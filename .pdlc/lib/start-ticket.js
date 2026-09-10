'use strict';

// Deterministic orchestration only — no LLM judgment involved, which is
// exactly why this is a CLI command an agent calls via Bash rather than
// something it improvises: route + worktree + init should behave
// identically every time for the same inputs, not vary by session.
//
// This is meant to be invoked BY AN AGENT on the user's behalf — see
// modules/disciplines/ticket-starter/SKILL.md — not typed by a human
// or a product owner. The human says "let's start ticket X"; the agent
// runs this.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const gateEngine = require('./gate-engine');
const router = require('./router');
const { appendRun } = require('./run-ledger');

function git(args, cwd, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

// A ticket worktree's .git is a FILE pointing at the main repo. Running
// start-ticket from inside one (which ticket-starter step 4 makes the
// normal situation for a developer's second ticket) used to branch the
// new ticket off the FIRST ticket's branch and name the worktree
// ../repo-A-B — so everything is resolved to the main checkout first.
function resolveMainRepo(dir) {
  const commonDir = git(['rev-parse', '--git-common-dir'], dir);
  const abs = path.isAbsolute(commonDir) ? commonDir : path.resolve(dir, commonDir);
  return path.basename(abs) === '.git' ? path.dirname(abs) : abs;
}

function isTracked(repoPath, relPath) {
  try {
    git(['ls-files', '--error-unmatch', relPath], repoPath);
    return true;
  } catch {
    return false;
  }
}

function branchExists(repoPath, branch) {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

function currentBranch(repoPath) {
  try {
    const name = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoPath);
    return name || null;
  } catch {
    return null; // detached HEAD
  }
}

function startTicket({ repoPath, ticketId, issueType, priority, labels, branch, worktreePath }) {
  // One validator, shared with the MCP tool layer — see
  // gate-engine.assertTicketId for why a ticket id is path-shaped input.
  gateEngine.assertTicketId(ticketId);
  const givenRepoPath = path.resolve(repoPath || '.');
  if (!fs.existsSync(path.join(givenRepoPath, '.git'))) {
    throw new Error(`${givenRepoPath} doesn't look like a git repo (no .git) — pass --repo pointing at the actual checkout`);
  }
  const mainRepoPath = resolveMainRepo(givenRepoPath);
  const resolvedFromWorktree = gateEngine.realpath(mainRepoPath) !== gateEngine.realpath(givenRepoPath);
  const resolvedRepoPath = resolvedFromWorktree ? mainRepoPath : givenRepoPath;

  // A worktree only contains COMMITTED files. If the runtime/skills were
  // distributed into this repo but never committed, the new worktree
  // would have no .pdlc/ at all and the very next command dies with a
  // raw MODULE_NOT_FOUND. Only checked when the runtime is actually
  // present here (running from the spine fork's own lib, as the tests
  // do, has nothing to check).
  const uncommitted = ['.pdlc/bin/spine.js', '.claude', '.cursor'].filter(
    (rel) => fs.existsSync(path.join(resolvedRepoPath, rel)) && !isTracked(resolvedRepoPath, rel)
  );
  if (uncommitted.includes('.pdlc/bin/spine.js')) {
    throw new Error(
      `the PDLC runtime in ${resolvedRepoPath} is not committed yet (${uncommitted.join(', ')}). ` +
      'A git worktree only contains committed files, so the ticket worktree would have no runtime. ' +
      'Commit .pdlc/, .claude/, .cursor/ and .github/workflows/pdlc-gate-check.yml first, then re-run start-ticket.'
    );
  }

  const graph = gateEngine.loadGraph();
  const context = { issue_type: issueType || 'Task', priority: priority || null, labels: labels || [] };
  const routed = router.route(graph, context);
  if (routed.rejected) {
    throw new Error(`${ticketId} (${context.issue_type}) is not routed through the PDLC: ${routed.reason}. Nothing was created.`);
  }
  const { track, matched_rule: matchedRule } = routed;

  const repoName = path.basename(resolvedRepoPath);
  const resolvedBranch = branch || `pdlc/${ticketId}`;
  const resolvedWorktreePath = path.resolve(worktreePath || path.join(resolvedRepoPath, '..', `${repoName}-${ticketId}`));

  if (fs.existsSync(resolvedWorktreePath)) {
    throw new Error(`${resolvedWorktreePath} already exists — this ticket may already have a worktree started (cd there and run status), or finish-ticket the old one first`);
  }

  // Captured BEFORE creating the worktree, as a specific commit SHA —
  // this is the one reliable diff baseline mid-flight escalation
  // checking needs later (see gate-engine.js's checkEscalation). A
  // branch name guessed at after the fact ("probably main") isn't
  // reliable; this is exact. The branch name is kept too, so the
  // escalation diff survives a merge/rebase of main into the ticket.
  const baseRef = git(['rev-parse', 'HEAD'], resolvedRepoPath);
  const baseBranch = currentBranch(resolvedRepoPath);

  // Developer B picking up developer A's ticket (or the same developer
  // after finish-ticket removed the worktree but kept the branch): the
  // branch already exists — attach a worktree to it instead of failing
  // with a raw "fatal: a branch named ... already exists", and keep the
  // phase-state.json that branch already carries.
  const resumed = branchExists(resolvedRepoPath, resolvedBranch);
  try {
    const args = resumed
      ? ['worktree', 'add', resolvedWorktreePath, resolvedBranch]
      : ['worktree', 'add', resolvedWorktreePath, '-b', resolvedBranch];
    git(args, resolvedRepoPath);
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : err.message;
    if (/already checked out|already used by worktree/.test(stderr)) {
      throw new Error(`branch ${resolvedBranch} is already checked out in another worktree — ${stderr.split('\n')[0]}. Use that worktree, or finish-ticket it first.`);
    }
    throw new Error(`git worktree add failed: ${stderr.split('\n')[0]}`);
  }

  const dir = gateEngine.ticketDir(resolvedWorktreePath, ticketId);
  let state;
  if (resumed && gateEngine.hasState(dir)) {
    state = gateEngine.loadState(dir, graph);
  } else {
    state = gateEngine.defaultState(graph, track, baseRef, { ticketId, baseBranch });
    gateEngine.saveState(dir, state);
  }

  appendRun(
    dir,
    { event: resumed ? 'ticket-resumed' : 'ticket-started', ticket_id: ticketId, track: state.track, matched_rule: matchedRule, starting_phase: gateEngine.currentPhaseId(state) || '(track complete)', branch: resolvedBranch, base_ref: baseRef },
    resumed
      ? `Re-attached a worktree to existing branch ${resolvedBranch} for ${ticketId}; state kept at phase "${gateEngine.currentPhaseId(state) || '(track complete)'}".`
      : `Started ${ticketId} on branch ${resolvedBranch}, routed to "${track}"${matchedRule ? ` (matched: ${matchedRule})` : ' (default track)'}.`
  );

  return {
    ticketId,
    track: state.track,
    matchedRule: resumed ? null : matchedRule,
    branch: resolvedBranch,
    worktreePath: resolvedWorktreePath,
    ticketDir: dir,
    startingPhase: gateEngine.currentPhaseId(state) || null,
    resumed,
    repoPath: resolvedRepoPath,
    resolvedFromWorktree,
    next: `open ${resolvedWorktreePath} as your workspace; the ticket's artifacts live in ${path.relative(resolvedWorktreePath, dir)}/`,
  };
}

module.exports = { startTicket };
