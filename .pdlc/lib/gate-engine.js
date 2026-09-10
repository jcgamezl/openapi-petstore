'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { readYaml, readJsonIfExists, writeJson, parseFrontmatter } = require('./util');
const { appendRun } = require('./run-ledger');

const SPINE_DIR = path.join(__dirname, '..');

// Where a ticket's gating artifacts live inside its worktree:
// <worktree>/pdlc/<TICKET-ID>/{intent.md,...,phase-state.json,memory/runs/}.
// One directory per ticket, committed with the code on the ticket
// branch. Before this, everything sat at the worktree root — so once
// ticket A's approved intent.md/plan.md/release.md merged to main,
// every later ticket's worktree inherited them and cleared every gate
// with zero human involvement (verified end to end by the launch
// audit), and two concurrent tickets merge-conflicted on the same
// files. Per-ticket directories fix both; the ticket-id check in
// checkExitArtifacts closes the door even if someone copies files over.
const { normalise: normaliseApproval, evaluate: evaluateApproval } = require('./approval-strategies');

const TICKETS_DIR = 'pdlc';

function loadGraph() {
  return readYaml(path.join(SPINE_DIR, 'phase-graph.yaml'));
}

function getPhaseDef(graph, phaseId) {
  const def = graph.phases.find((p) => p.id === phaseId);
  if (!def) throw new Error(`Unknown phase "${phaseId}" — not declared in phase-graph.yaml`);
  return def;
}

function getTrackDef(graph, trackName) {
  const def = graph.tracks[trackName];
  if (!def) throw new Error(`Unknown track "${trackName}" — not declared in phase-graph.yaml`);
  return def;
}

function statePath(projectDir) {
  return path.join(projectDir, 'phase-state.json');
}

// A ticket id becomes a directory name and a branch name, so it is
// path-shaped input and the only thing standing between a caller and a
// path traversal. Rejecting the separators and refusing a leading dot
// is what makes `path.join(root, TICKETS_DIR, id)` safe: without a
// separator there is nothing to traverse with, and `..` cannot pass a
// pattern that must start alphanumeric.
//
// This lives here, next to ticketDir, because it used to live only in
// start-ticket.js — and then the MCP tool layer became a second entry
// point that took a ticket id straight from a model and did not check
// it. One validator, every entry point.
const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertTicketId(ticketId) {
  if (!ticketId || typeof ticketId !== 'string') throw new Error('ticketId is required');
  if (!TICKET_ID_RE.test(ticketId)) {
    throw new Error(
      `ticket id "${ticketId}" contains characters that can't be used in a branch/directory name — `
      + 'use the Jira key as-is, e.g. BANK-1234'
    );
  }
  return ticketId;
}

function ticketDir(worktreePath, ticketId) {
  return path.join(worktreePath, TICKETS_DIR, ticketId);
}

// baseRef: the commit this ticket branched from, captured once at
// start-ticket time (a specific SHA, not a branch name guessed at
// later) — the one reliable diff baseline for escalation checking.
// null for state created outside start-ticket (tests, manual init);
// escalation checking just no-ops without one rather than guessing.
// baseBranch: the branch that SHA was the tip of (e.g. "main"), so the
// escalation diff can use merge-base(baseBranch, HEAD) and stay correct
// after the developer merges or rebases main into the ticket branch.
function defaultState(graph, trackName, baseRef = null, extra = {}) {
  const track = getTrackDef(graph, trackName);
  const phases = [...track.phases, ...(track.post_hoc || [])];
  return {
    ticket_id: extra.ticketId || null,
    track: trackName,
    phases,
    post_hoc_start: track.post_hoc ? track.phases.length : null,
    phase_index: 0,
    cycle: 1,
    base_ref: baseRef,
    base_branch: extra.baseBranch || null,
    history: [],
  };
}

function hasState(projectDir) {
  return fs.existsSync(statePath(projectDir));
}

function validateState(state, projectDir) {
  const problems = [];
  if (!state || typeof state !== 'object') problems.push('not a JSON object');
  else {
    if (!Array.isArray(state.phases) || state.phases.length === 0) problems.push('"phases" must be a non-empty array');
    if (typeof state.phase_index !== 'number' || state.phase_index < 0 || (Array.isArray(state.phases) && state.phase_index > state.phases.length)) {
      problems.push(`"phase_index" must be a number between 0 and ${Array.isArray(state.phases) ? state.phases.length : '?'}`);
    }
    if (typeof state.track !== 'string') problems.push('"track" must be a string');
  }
  if (problems.length) {
    throw new Error(`${statePath(projectDir)} is corrupt (${problems.join('; ')}) — restore it from git (git checkout -- ${path.relative(process.cwd(), statePath(projectDir))}) rather than hand-editing.`);
  }
  if (!Array.isArray(state.history)) state.history = [];
  return state;
}

// Refuses to invent state. Before this, a missing phase-state.json
// silently became "standard track, phase plan" — so status in the
// wrong directory, a teammate's clone without the committed artifacts,
// or CI on a branch with no ticket all reported a confident, wrong
// answer instead of the actual problem.
function loadState(projectDir, graph) {
  const existing = readJsonIfExists(statePath(projectDir), null);
  if (!existing) {
    throw new Error(
      `no phase-state.json in ${projectDir} — this isn't a ticket directory. ` +
      `Run from a ticket's worktree (status/advance auto-discover ${TICKETS_DIR}/<TICKET-ID>/), pass --project ${TICKETS_DIR}/<TICKET-ID>, ` +
      'or start the ticket first with start-ticket.'
    );
  }
  const state = validateState(existing, projectDir);
  getTrackDef(graph, state.track); // throws a readable error on a track this phase-graph doesn't know
  return state;
}

function saveState(projectDir, state) {
  writeJson(statePath(projectDir), state);
}

function currentPhaseId(state) {
  return state.phases[state.phase_index];
}

function isPostHoc(state) {
  return state.post_hoc_start !== null && state.post_hoc_start !== undefined && state.phase_index >= state.post_hoc_start;
}

function isDone(state) {
  return !currentPhaseId(state);
}

// git prints the real path (/private/var/... on macOS) while callers
// pass whatever spelling they were given (/var/...); everything that
// compares the two goes through realpath first.
function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function gitToplevel(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Every ticket directory under <root>/pdlc/ that has a phase-state.json,
// with its parsed state. Used by the CLI (status/advance/gate-check
// without --project), the CI check, and the deploy-gate hook.
function discoverTicketDirs(root) {
  const base = path.join(root, TICKETS_DIR);
  if (!fs.existsSync(base)) return [];
  const found = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    if (!hasState(dir)) continue;
    let state;
    try {
      state = validateState(readJsonIfExists(statePath(dir), null), dir);
    } catch (err) {
      found.push({ dir, ticketId: entry.name, state: null, error: err.message });
      continue;
    }
    found.push({ dir, ticketId: entry.name, state, done: isDone(state) });
  }
  return found.sort((a, b) => a.ticketId.localeCompare(b.ticketId));
}

// Resolves which ticket directory a command means when run without
// --project: the cwd itself if it holds phase-state.json (explicit
// ticket dir, or legacy/test layouts), otherwise the single in-flight
// ticket under the checkout's pdlc/. Several in flight -> ask, none ->
// say so. Returns { projectDir } or { projectDir: null, reason, candidates }.
function discoverProjectDir(cwd) {
  if (hasState(cwd)) return { projectDir: cwd, candidates: [] };
  const top = gitToplevel(cwd);
  // keep the caller's spelling of the path when it's the same directory
  const root = top && realpath(top) !== realpath(cwd) ? top : cwd;
  const all = discoverTicketDirs(root);
  const inFlight = all.filter((t) => t.state && !t.done);
  if (inFlight.length === 1) return { projectDir: inFlight[0].dir, candidates: all };
  if (all.length === 0) {
    return { projectDir: null, candidates: all, reason: `no ${TICKETS_DIR}/<TICKET-ID>/phase-state.json under ${root} — start a ticket first (start-ticket), or pass --project <ticket dir>.` };
  }
  if (inFlight.length === 0) {
    return { projectDir: null, candidates: all, reason: `every ticket under ${root}/${TICKETS_DIR}/ is complete (${all.map((t) => t.ticketId).join(', ')}) — pass --project ${TICKETS_DIR}/<TICKET-ID> to inspect one.` };
  }
  return { projectDir: null, candidates: all, reason: `${inFlight.length} tickets are in flight here (${inFlight.map((t) => t.ticketId).join(', ')}) — pass --project ${TICKETS_DIR}/<TICKET-ID> to pick one.` };
}

// How many commits the checkout's branch is behind its upstream, or 0
// when there is no upstream / no remote / git can't tell (fail open —
// this is a "pull first" nudge for shared tickets, not a gate).
function commitsBehindUpstream(dir) {
  try {
    const out = execFileSync('git', ['rev-list', '--count', 'HEAD..@{upstream}'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

// Resolves an exit artifact's file location within the project directory.
function artifactPath(projectDir, artifactName) {
  return path.join(projectDir, artifactName);
}

// spec.cycle, when set, declares which cycle's copy of a reused-filename
// artifact satisfies this gate: "current" is this cycle's own copy,
// "next" is the seed for the cycle a loop-back phase is about to start.
// This client's phase-graph has no loop-back phase (see phase-graph.yaml's
// launch comment), so in practice this always resolves to cycle 1 — kept
// so a phase-graph that DOES loop (a future cycle, or a different client
// fork) doesn't need engine changes, just a loops_to declaration.
function expectedCycle(spec, state) {
  if (spec.cycle === 'next') return state.cycle + 1;
  if (spec.cycle === 'current') return state.cycle;
  return null; // no cycle requirement declared for this artifact
}

// An artifact with no cycle field is treated as cycle 1: on a
// phase-graph with no loop every artifact IS cycle 1, and blocking a
// hand-written intent.md with "stale file from a previous loop" when
// there has never been a loop was pure confusion (audit finding).
function artifactCycle(fm) {
  return fm.data.cycle === undefined || fm.data.cycle === null ? 1 : fm.data.cycle;
}

// PCI-DSS v4.0 Req 6.2.3.1: custom code must be "reviewed by
// individuals other than the originating code author... and reviewed
// and approved by management prior to release." An AI review can
// inform this but can never legally BE the approval — checked here as
// approved_by (or author, if set) not equal to the artifact's author/
// requested_by. Both fields absent is not a pass — it's a config
// error the client needs to fix, not a silent skip.
function sodOk(fm) {
  if (!fm || !fm.data) return { ok: false, reason: 'no frontmatter to check author/approver against' };
  const author = fm.data.author || fm.data.requested_by;
  const approver = fm.data.approved_by;
  if (!author || !approver) {
    return { ok: false, reason: 'segregation of duties is enforced but this artifact is missing an author/requested_by or approved_by field to check' };
  }
  if (author === approver) {
    return { ok: false, reason: `approved_by ("${approver}") is the same person as author/requested_by — PCI-DSS 6.2.3.1 requires a distinct approver` };
  }
  return { ok: true };
}

// A named approved_by is a claim, not proof — nothing stops whoever is
// transcribing a human's approval (an engineer, an agent acting on their
// behalf) from typing a name without that person having actually said
// so. Real approvers here — product owner, compliance officer, release
// manager — routinely have no git/GitHub/Cursor/Claude access at all;
// they approve where they already work (a Jira comment, a Slack
// message, an email), and someone else transcribes it into the file.
// approval_evidence closes that gap: a link back to where the actual
// approval happened, so "approved_by: maria" is checkable against a
// real record instead of trusted on the transcriber's word alone.
// Segregation of duties, per approver — extracted so the legacy scalar
// path and the approvals list share one rule instead of drifting.
function sodOkFor(author, approver) {
  if (!author || !approver) {
    return { ok: false, reason: 'segregation of duties is enforced but this artifact is missing an author/requested_by or approved_by field to check' };
  }
  if (author === approver) {
    return { ok: false, reason: `approved_by ("${approver}") is the same person as author/requested_by — PCI-DSS 6.2.3.1 requires a distinct approver` };
  }
  return { ok: true };
}

// An artifact records its approvals in one of two shapes: the legacy
// three scalars — one approver, what every artifact written so far
// uses — or an `approvals:` list with one entry per role. The list is
// only ever needed by a gate that asks for more than one signature, so
// nothing already written has to be rewritten.
//
// require_approval_evidence and enforce_segregation_of_duties apply to
// EVERY approver, not just the first: a quorum whose second signature
// has no link is still blocked. One link does not cover two people.
function collectDecisions(fm, normalised, graph) {
  const requireEvidence = graph.require_approval_evidence === true;
  const enforceSod = graph.enforce_segregation_of_duties === true;
  const author = fm.data.author || fm.data.requested_by;
  const hasList = Array.isArray(fm.data.approvals) && fm.data.approvals.length > 0;
  const entries = hasList
    ? fm.data.approvals
    : [{ role: normalised.roles[0], by: fm.data.approved_by, evidence: fm.data.approval_evidence, status: fm.data.status }];

  const decisions = {};
  const problems = [];
  for (const e of entries) {
    if (!e || typeof e.role !== 'string') continue;
    if (!normalised.roles.includes(e.role)) {
      problems.push(`an approval from "${e.role}" does not belong to this gate (it wants: ${normalised.roles.join(', ')})`);
      continue;
    }
    const decision = e.status === 'declined' ? 'declined' : e.status === 'approved' ? 'approved' : null;
    if (!decision) continue;
    if (decision === 'approved') {
      if (requireEvidence && !String(e.evidence || '').trim()) {
        problems.push(hasList
          ? `${e.role} has no approval_evidence — a link to where they actually approved, not just a name`
          : approvalEvidenceOk(fm).reason);
        continue;
      }
      if (enforceSod) {
        const sod = sodOkFor(author, e.by);
        if (!sod.ok) {
          problems.push(hasList ? `${e.role}: ${sod.reason}` : sod.reason);
          continue;
        }
      }
    }
    decisions[e.role] = decision;
  }
  return { decisions, problems };
}

function approvalEvidenceOk(fm) {
  const evidence = fm.data.approval_evidence;
  if (!evidence || !String(evidence).trim()) {
    return { ok: false, reason: 'approval_evidence is required but missing or empty — a link to the Jira comment/Slack message/email where this was actually approved, not just a name in approved_by' };
  }
  return { ok: true };
}

// The artifact must belong to THIS ticket. Without this, any approved
// file with the right name satisfied the gate — including one copied
// or inherited from another ticket.
function ticketIdOk(fm, state) {
  if (!state.ticket_id) return { ok: true }; // state created outside start-ticket (init/tests) — nothing to compare against
  const id = fm.data.id;
  if (id === undefined || id === null || String(id).trim() === '') {
    return { ok: false, reason: `frontmatter has no "id" — this ticket is ${state.ticket_id}; set id: ${state.ticket_id}` };
  }
  if (String(id).trim() !== String(state.ticket_id)) {
    return { ok: false, reason: `belongs to ticket ${id}, but this ticket is ${state.ticket_id} — an artifact from another ticket never satisfies this gate` };
  }
  return { ok: true };
}

function checkExitArtifacts(phaseDef, projectDir, state, graph) {
  const enforceSod = graph.enforce_segregation_of_duties === true;
  const requireEvidence = graph.require_approval_evidence === true;
  const results = (phaseDef.exit_artifacts || []).map((spec) => {
    const fm = parseFrontmatter(artifactPath(projectDir, spec.artifact));
    const present = fm !== null;
    const parseError = present && fm.error ? fm.error : null;
    const approvedStatus = present && !parseError && fm.data && fm.data.status === 'approved';
    const ident = present && !parseError ? ticketIdOk(fm, state) : { ok: true };
    const wantCycle = expectedCycle(spec, state);
    const cycleOk = wantCycle === null || (present && !parseError && artifactCycle(fm) === wantCycle);
    // The gate's own strategy decides what "approved" means here: one
    // signature, a quorum, or the role the risk tier names.
    const gateApproval = normaliseApproval(spec.approval);
    let decisions = {};
    let problems = [];
    if (present && !parseError && fm.data) {
      const collected = collectDecisions(fm, gateApproval, graph);
      decisions = collected.decisions;
      problems = collected.problems;
    }
    const verdict = evaluateApproval(gateApproval, decisions);
    const waitingOn = gateApproval.roles.filter((r) => !decisions[r]);
    const declinedBy = gateApproval.roles.filter((r) => decisions[r] === 'declined');
    const approved = verdict === 'approved' && ident.ok && cycleOk;

    let reason = null;
    if (!present) reason = `${spec.artifact} does not exist yet`;
    else if (parseError) reason = `${spec.artifact}: ${parseError}`;
    else if (!ident.ok) reason = `${spec.artifact} ${ident.reason}`;
    else if (verdict === 'pending' && !problems.length) reason = `${spec.artifact} exists but is not approved (status: ${fm.data ? fm.data.status || 'missing' : 'missing'})`;
    else if (!cycleOk) reason = `${spec.artifact} is approved but is cycle ${artifactCycle(fm)} — this gate needs cycle ${wantCycle} (a copy left over from an earlier loop of this ticket)`;
    else if (verdict === 'declined') reason = `${spec.artifact} was declined by ${declinedBy.join(', ')} — that is a decision to discuss, not a missing signature`;
    else if (problems.length) reason = `${spec.artifact}: ${problems.join('; ')}`;
    else if (verdict === 'partial') reason = `${spec.artifact} is approved by some of its approvers but not all — waiting on ${waitingOn.join(', ')}`;

    return {
      artifact: spec.artifact, required: spec.required, approval: spec.approval,
      present, approved, verdict, waiting_on: waitingOn, reason,
    };
  });
  return results;
}

function checkTrackRequirements(graph, state, projectDir) {
  const track = getTrackDef(graph, state.track);
  if (track.requires !== 'skip_reason') return { ok: true };
  if (isPostHoc(state)) return { ok: true };
  // Only relevant the moment the track's FIRST phase's gate is being
  // checked — that's the transition where define/design get silently
  // skipped on this track, so that's the only point a missing
  // skip_reason should block. Checked by position, not by name — the
  // engine treats phase ids as opaque, so this can't hardcode which
  // phase happens to be first on any given track.
  if (state.phase_index !== 0) return { ok: true };
  const fm = parseFrontmatter(artifactPath(projectDir, 'intent.md'));
  const ok = !!(fm && !fm.error && fm.data && fm.data.skip_reason && ticketIdOk(fm, state).ok);
  return {
    ok,
    reason: ok ? null : `track "${state.track}" requires intent.md to record why phases were skipped (frontmatter field: skip_reason)`,
  };
}

// §02's "Tracks" design: a fast-tracked fix that balloons past what
// the track was meant for should re-enter standard/Design, not merge
// on its original, now-wrong classification. Checked only when
// leaving develop (where the actual code change happens) on a track
// that declares an `escalation` config. Fails OPEN on anything it
// can't determine (no base_ref, git error): this is a scope nudge,
// not a security gate, and a false block is worse than an occasional
// miss.
//
// The PDLC's own bookkeeping (pdlc/<TICKET>/: intent.md, plan.md,
// phase-state.json, the run ledger) is excluded from the count — it
// consumed ~270 of a 400-line fast-track budget in the audit's repro
// and is not the developer's change.
//
// git diff <ref> (no ...HEAD) covers committed + working-tree changes
// to TRACKED files; untracked (brand-new) files are invisible to it,
// so those are counted separately from git status.
function unquoteGitPath(raw) {
  if (!raw.startsWith('"')) return raw;
  try {
    return JSON.parse(raw); // git's C-style quoting is JSON-compatible for the common cases
  } catch {
    return raw.slice(1, -1);
  }
}

function countUntrackedLines(repoRoot, excludeRel) {
  let total = 0;
  let status;
  try {
    status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    return 0;
  }
  for (const line of status.split('\n')) {
    if (!line.startsWith('??')) continue;
    const file = unquoteGitPath(line.slice(3).trim());
    if (excludeRel && (file === excludeRel || file.startsWith(excludeRel + '/'))) continue;
    try {
      total += fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n').length;
    } catch {
      // binary or unreadable — skip rather than fail the whole check
    }
  }
  return total;
}

// The diff baseline: merge-base(base_branch, HEAD) when base_branch is
// known and resolvable — so merging or rebasing main into the ticket
// branch doesn't count main's own commits as "this change grew"
// (audit finding) — falling back to the base_ref SHA captured at
// start-ticket.
function escalationBaseline(state, repoRoot) {
  if (state.base_branch) {
    try {
      return execFileSync('git', ['merge-base', state.base_branch, 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // branch gone or unrelated history — fall through to the SHA
    }
  }
  return state.base_ref;
}

function checkEscalation(graph, state, projectDir) {
  const track = getTrackDef(graph, state.track);
  if (!track.escalation) return { ok: true };
  if (isPostHoc(state)) return { ok: true };
  if (currentPhaseId(state) !== (track.escalation.phase || 'develop')) return { ok: true };
  if (!state.base_ref) return { ok: true };

  const repoRoot = gitToplevel(projectDir);
  if (!repoRoot) return { ok: true };
  const excludeRel = path.relative(realpath(repoRoot), realpath(projectDir)).split(path.sep).join('/');
  const baseline = escalationBaseline(state, repoRoot);
  if (!baseline || !/^[0-9a-f]{7,64}$/i.test(baseline)) return { ok: true }; // never interpolated into a shell, but also never trust a non-SHA

  let stat;
  try {
    const args = ['diff', '--shortstat', baseline, '--', '.'];
    if (excludeRel && excludeRel !== '.' && !excludeRel.startsWith('..')) args.push(`:(exclude)${excludeRel}`);
    stat = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { ok: true };
  }

  const insertions = (stat.match(/(\d+) insertion/) || [])[1];
  const deletions = (stat.match(/(\d+) deletion/) || [])[1];
  const changed = (Number(insertions) || 0) + (Number(deletions) || 0) + countUntrackedLines(repoRoot, excludeRel === '.' ? null : excludeRel);
  const threshold = track.escalation.max_changed_lines;
  if (changed <= threshold) return { ok: true };

  const blocking = (track.escalation.on_exceed || 'block') === 'block';
  return {
    ok: !blocking,
    reason:
      `this "${state.track}" change has grown to ${changed} changed lines (threshold: ${threshold}) — ` +
      `consider re-routing to the standard track for a real Design pass rather than merging on the ` +
      `original classification.${blocking ? '' : ' (warning only, not blocking, per this track\'s on_exceed config)'}`,
  };
}

// Returns a full status report: current phase, whether its gate clears,
// and what's blocking it if not.
function checkGate(graph, state, projectDir) {
  const phaseId = currentPhaseId(state);
  if (!phaseId) {
    return { ticket_id: state.ticket_id || null, track: state.track, phase: null, done: true, ok: true, results: [] };
  }
  const phaseDef = getPhaseDef(graph, phaseId);
  const results = checkExitArtifacts(phaseDef, projectDir, state, graph);
  const trackCheck = checkTrackRequirements(graph, state, projectDir);
  const escalation = checkEscalation(graph, state, projectDir);
  const requiredUnmet = results.filter((r) => r.required && !r.approved);
  const ok = requiredUnmet.length === 0 && trackCheck.ok && escalation.ok;
  return {
    ticket_id: state.ticket_id || null,
    track: state.track,
    phase: phaseId,
    post_hoc: isPostHoc(state),
    done: false,
    ok,
    results,
    trackCheck,
    escalation,
  };
}

// Advances the state machine if the current phase's gate clears.
// Throws if it doesn't — callers should checkGate() first for a dry run.
function advance(graph, state, projectDir) {
  const report = checkGate(graph, state, projectDir);
  if (report.done) throw new Error('track is already complete, nothing to advance');
  if (!report.ok) {
    const blockers = report.results.filter((r) => r.required && !r.approved).map((r) => r.reason);
    if (!report.trackCheck.ok) blockers.push(report.trackCheck.reason);
    if (!report.escalation.ok) blockers.push(report.escalation.reason);
    throw new Error(`gate not clear for phase "${report.phase}": ${blockers.join('; ')}`);
  }

  const phaseDef = getPhaseDef(graph, report.phase);
  const atEnd = state.phase_index === state.phases.length - 1;

  state.history.push({ phase: report.phase, cleared_at: new Date().toISOString() });

  if (atEnd && phaseDef.loops_to) {
    const loopIndex = state.phases.indexOf(phaseDef.loops_to);
    state.phase_index = loopIndex >= 0 ? loopIndex : state.phase_index;
    // The artifact that just cleared this gate was validated as *next*
    // cycle's seed (cycle: state.cycle + 1) — advancing the counter now
    // makes it *this* cycle's own artifact for the phase we just looped
    // into, and stale copies from the cycle before that stop matching.
    if (loopIndex >= 0) state.cycle += 1;
  } else if (atEnd) {
    state.phase_index += 1; // walks past the end; currentPhaseId() then returns undefined -> done
  } else {
    state.phase_index += 1;
  }

  saveState(projectDir, state);

  const toPhase = currentPhaseId(state) || '(track complete)';
  const cleared = report.results.filter((r) => r.approved).map((r) => {
    const fm = parseFrontmatter(artifactPath(projectDir, r.artifact));
    return { artifact: r.artifact, approved_by: fm && fm.data ? fm.data.approved_by || null : null, approval_evidence: fm && fm.data ? fm.data.approval_evidence || null : null };
  });
  appendRun(
    projectDir,
    { event: 'phase-advanced', ticket_id: state.ticket_id || null, track: state.track, from_phase: report.phase, to_phase: toPhase, cycle: state.cycle, post_hoc: isPostHoc(state), approvals: cleared },
    `Phase "${report.phase}" gate cleared, advanced to "${toPhase}".`
  );

  return state;
}

module.exports = {
  TICKETS_DIR,
  TICKET_ID_RE,
  assertTicketId,
  loadGraph,
  getPhaseDef,
  getTrackDef,
  defaultState,
  hasState,
  loadState,
  saveState,
  currentPhaseId,
  isPostHoc,
  isDone,
  ticketDir,
  gitToplevel,
  realpath,
  commitsBehindUpstream,
  discoverTicketDirs,
  discoverProjectDir,
  checkGate,
  advance,
};
