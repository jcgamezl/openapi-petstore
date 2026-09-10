'use strict';

// The other half of start-ticket.js — confirmed via grep before
// building this, nothing removed a worktree once a ticket was done.
// Every worktree start-ticket creates accumulates forever unless
// someone remembers `git worktree remove` by hand.
//
// Deterministic, not LLM judgment — same reasoning as start-ticket:
// this should behave identically every time, so it's a command an
// agent calls via Bash, not something it improvises.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const gateEngine = require('./gate-engine');

function findMainRepoPath(worktreePath) {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktreePath,
      encoding: 'utf8',
    }).trim();
    const absCommonDir = path.isAbsolute(commonDir) ? commonDir : path.resolve(worktreePath, commonDir);
    return path.basename(absCommonDir) === '.git' ? path.dirname(absCommonDir) : absCommonDir;
  } catch {
    return null;
  }
}

// checkGate's done:true only fires for a track whose last phase has no
// loops_to — true of every track in the default phase-graph.yaml (no
// measure phase, no loop back to plan; a client that adds a loop-based
// phase back in would need this to keep working for THAT phase-graph
// too). So "finished" here means: the current phase's gate is clear AND
// advancing from here would either reach checkGate's own done:true, or
// trigger a loop (the loops_to case, for a phase-graph that has one).
function isTicketFinished(graph, state, report) {
  if (!report.ok) return false;
  if (report.done) return true;
  const phaseDef = gateEngine.getPhaseDef(graph, report.phase);
  return !!phaseDef.loops_to;
}

// The ticket directory inside the worktree: the one in-flight
// pdlc/<ID>/ (or the only one), or the worktree root itself for
// legacy/test layouts that keep phase-state.json there.
function resolveProjectDir(worktreePath, projectDir) {
  if (projectDir) return path.resolve(worktreePath, projectDir);
  if (gateEngine.hasState(worktreePath)) return worktreePath;
  const tickets = gateEngine.discoverTicketDirs(worktreePath).filter((t) => t.state);
  const inFlight = tickets.filter((t) => !t.done);
  if (inFlight.length === 1) return inFlight[0].dir;
  if (tickets.length === 1) return tickets[0].dir;
  if (tickets.length === 0) {
    throw new Error(`no ${gateEngine.TICKETS_DIR}/<TICKET-ID>/phase-state.json in ${worktreePath} — is this really a ticket worktree? Pass --project <ticket dir> if the layout is unusual.`);
  }
  throw new Error(`${worktreePath} holds ${inFlight.length} in-flight tickets (${inFlight.map((t) => t.ticketId).join(', ')}) — pass --project ${gateEngine.TICKETS_DIR}/<TICKET-ID> to say which one is finished.`);
}

function uncommittedPaths(worktreePath) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktreePath, encoding: 'utf8' });
    return out.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
  } catch {
    return [];
  }
}

function finishTicket({ worktreePath, repoPath, projectDir, deleteBranch = false, force = false }) {
  const resolvedWorktreePath = path.resolve(worktreePath);
  if (!fs.existsSync(resolvedWorktreePath)) {
    throw new Error(`${resolvedWorktreePath} does not exist`);
  }

  const graph = gateEngine.loadGraph();
  const resolvedProjectDir = resolveProjectDir(resolvedWorktreePath, projectDir);
  const state = gateEngine.loadState(resolvedProjectDir, graph);
  const report = gateEngine.checkGate(graph, state, resolvedProjectDir);
  const finished = isTicketFinished(graph, state, report);

  if (!finished && !force) {
    throw new Error(
      `this ticket isn't finished — still at phase "${report.phase}" (track "${state.track}"), gate ${report.ok ? 'clear but not yet at a loop point' : 'not clear'}. ` +
      `Pass --force to remove the worktree anyway (abandoning the ticket — its uncommitted artifacts are lost).`
    );
  }

  const resolvedRepoPath = repoPath ? path.resolve(repoPath) : findMainRepoPath(resolvedWorktreePath);
  if (!resolvedRepoPath) {
    throw new Error(`could not determine the main repo for ${resolvedWorktreePath} — pass repoPath explicitly`);
  }

  let branch = null;
  try {
    branch = execFileSync('git', ['-C', resolvedWorktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // worktree already gone or not a git checkout — fine, proceed without a branch name
  }

  // A finished ticket whose approval record (pdlc/<ID>/) was never
  // committed is the audit's worst case: git refuses to remove the
  // worktree, the old message said "pass force", and force deleted the
  // whole approval trail while reporting a normal completion. Say what
  // is actually pending instead.
  if (!force) {
    const pending = uncommittedPaths(resolvedWorktreePath);
    if (pending.length) {
      const ticketRel = path.relative(resolvedWorktreePath, resolvedProjectDir).split(path.sep).join('/');
      const artifacts = pending.filter((p) => p === ticketRel || p.startsWith(ticketRel + '/'));
      throw new Error(
        `${resolvedWorktreePath} has ${pending.length} uncommitted change(s)` +
        (artifacts.length ? `, including this ticket's own approval record (${artifacts.slice(0, 3).join(', ')}${artifacts.length > 3 ? ', ...' : ''})` : '') +
        `. Commit them on branch ${branch || '(unknown)'} and open/merge the PR first — the artifacts are the audit trail, they must land on main with the code. ` +
        '--force removes the worktree anyway and LOSES them (abandon only).'
      );
    }
  }

  const removeArgs = ['worktree', 'remove', resolvedWorktreePath];
  if (force) removeArgs.push('--force');
  try {
    execFileSync('git', removeArgs, { cwd: resolvedRepoPath, stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : err.message;
    if (/untracked|modified/.test(stderr)) {
      throw new Error(
        `${resolvedWorktreePath} has uncommitted or untracked changes git won't silently discard. ` +
        `Commit them first, or pass --force to remove anyway and lose them.`
      );
    }
    throw new Error(`git worktree remove failed: ${stderr.split('\n')[0]}`);
  }

  let branchDeleted = false;
  if (deleteBranch && branch) {
    try {
      // -d, not -D: refuses if the branch has unmerged commits —
      // deliberately not force-deleting someone's work by accident.
      execFileSync('git', ['branch', '-d', branch], { cwd: resolvedRepoPath, stdio: 'pipe' });
      branchDeleted = true;
    } catch (err) {
      throw new Error(
        `worktree removed, but branch "${branch}" was not deleted (likely has unmerged commits): ${err.message.split('\n')[0]}. ` +
        `Delete it manually with git branch -D if that's intentional.`
      );
    }
  }

  return { ticketId: state.ticket_id || null, worktreePath: resolvedWorktreePath, repoPath: resolvedRepoPath, branch, branchDeleted, wasForced: force && !finished };
}

module.exports = { finishTicket };
