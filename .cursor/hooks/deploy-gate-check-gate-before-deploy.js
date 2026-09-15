#!/usr/bin/env node
'use strict';

// The canonical hook example from the very first architecture pass —
// actually built. Blocks a production deploy command until the ticket's
// LAUNCH gate (release.md approved by a named release_manager, with
// approval_evidence) is genuinely clear — or the ticket is already
// complete, which means that gate cleared. Any earlier phase blocks,
// even if that phase's own gate happens to be clear (the audit caught
// the previous version allowing a deploy at plan/develop as long as
// intent.md/plan.md was approved).
//
// Deliberately fails CLOSED on ambiguity — the opposite choice from
// unit-test-writer's check-tests-before-commit.js, and worth being
// explicit about why: a wrongly-blocked commit costs someone a few
// minutes; a wrongly-allowed production deploy is a different order
// of consequence. "Can't confidently tell" means block here, not
// allow. The one place ambiguity defaults to ALLOW is "is this even a
// deploy command?" — otherwise every unrelated command would need
// explaining.
//
// Works for both tools' hook contracts:
//   Claude Code PreToolUse: stdin {tool_input:{command}, cwd}; block =
//     stderr text + exit 2.
//   Cursor beforeShellExecution: stdin {command, cwd, ...}; block =
//     stdout JSON {permission:"deny", user_message, agent_message}
//     (+ exit 2 also blocks); allow = {permission:"allow"}.
//
// The deploy-command pattern below is a starting heuristic, not
// exhaustive — every client's actual deploy tooling differs
// (kubectl/terraform/a custom script/whatever). Adjust it for the
// real command this client's release process actually runs.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

let data = {};
try {
  data = JSON.parse(readStdin()) || {};
} catch {
  data = {};
}
const isCursor = !data.tool_input && typeof data.command === 'string';
const command = (data.tool_input && data.tool_input.command) || data.command || (data.input && data.input.command) || null;

function allow() {
  if (isCursor) process.stdout.write(JSON.stringify({ permission: 'allow' }) + '\n');
  process.exit(0);
}

function deny(message) {
  if (isCursor) process.stdout.write(JSON.stringify({ permission: 'deny', user_message: message, agent_message: message }) + '\n');
  console.error(message);
  process.exit(2);
}

// Real deploy verbs only, in command position. The earlier
// `\bdeploy\b.*\bprod\b` pattern matched a grep over
// deploy/production.yaml, a `cat docs/deploy-prod.md`, and a git
// commit message mentioning both words — and blocked them whenever a
// gate wasn't clear (it blocked the audit's own commands, and one of
// the engine owner's while fixing it). Anchored on the command
// position instead: the deploy tool has to be the thing being run,
// not a word inside an argument.
const DEPLOY_TOOL = /(^|[;&|(]\s*|\bsudo\s+|\bnpx\s+|\bnpm\s+run\s+|\byarn\s+(run\s+)?|\bpnpm\s+(run\s+)?|\bmake\s+|\.\/|\bsh\s+|\bbash\s+)(deploy(-[a-z]+)?(\.sh|\.js|\.py)?(:[a-z0-9_-]+)?|kubectl\s+(apply|rollout|set\s+image)|helm\s+(install|upgrade)|terraform\s+apply|serverless\s+deploy|sls\s+deploy|cdk\s+deploy|aws\s+ecs\s+update-service|gcloud\s+(run|app)\s+deploy|az\s+webapp\s+deploy|oc\s+(apply|rollout))(?=$|\s)/i;
const PROD_TARGET = /(^|[\s=:/,\-])(prod|production|prd)(?=$|[\s=:/,\-.])/i;

if (!command || !DEPLOY_TOOL.test(command) || !PROD_TARGET.test(command)) {
  allow(); // not a production deploy — not this hook's concern
}

// Run relative to where the AGENT is, not where the hook process
// happened to start: both tools pass cwd in the payload, and Claude
// Code hooks run in the main checkout even after the agent cd'd into
// the ticket worktree.
if (typeof data.cwd === 'string' && fs.existsSync(data.cwd)) {
  try {
    process.chdir(data.cwd);
  } catch {
    // keep the current directory
  }
}
const cdPrefix = command.match(/^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*(&&|;)/);
if (cdPrefix) {
  const target = cdPrefix[2] || cdPrefix[3] || cdPrefix[4];
  if (target && fs.existsSync(path.resolve(target))) {
    try {
      process.chdir(path.resolve(target));
    } catch {
      // ignore
    }
  }
}

function gitToplevel() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return process.cwd();
  }
}

const root = gitToplevel();

// The engine lives in one of two places, and this hook has to work in
// both: inside the plugin that shipped this script (one copy, updated
// centrally), or under the repo's own .pdlc/ (the per-repo
// distribution). __dirname resolves whatever either tool does with its
// plugin-root variable — Claude Code expands ${CLAUDE_PLUGIN_ROOT},
// Cursor resolves a relative command, and a script that locates itself
// needs neither to be true. Plugin first: if both exist, the plugin's
// copy is the newer one.
function findRuntime() {
  const inPlugin = path.resolve(__dirname, '..', '..', 'spine', 'bin', 'spine.js');
  if (fs.existsSync(inPlugin)) return inPlugin;
  const inRepo = path.join(root, '.pdlc', 'bin', 'spine.js');
  if (fs.existsSync(inRepo)) return inRepo;
  return null;
}

const runtime = findRuntime();
if (!runtime) {
  deny(
    'Blocked: could not verify the launch gate before this production deploy — no engine found, '
    + 'neither inside this plugin nor at .pdlc/bin/spine.js under ' + root + '.\n' +
    'Run the deploy from the ticket\'s worktree (or a checkout with the PDLC runtime committed), or fix the underlying error.'
  );
}

// Every ticket directory on this checkout. In-flight tickets must be at
// the launch phase with a clear gate; complete tickets already cleared
// it. No ticket state at all -> fail closed.
const ticketsRoot = path.join(root, 'pdlc');
let ticketDirs = [];
if (fs.existsSync(ticketsRoot)) {
  ticketDirs = fs.readdirSync(ticketsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(ticketsRoot, e.name, 'phase-state.json')))
    .map((e) => path.join(ticketsRoot, e.name));
}
if (fs.existsSync(path.join(root, 'phase-state.json'))) ticketDirs.push(root); // legacy layout: state at the checkout root

if (ticketDirs.length === 0) {
  deny(
    'Blocked: no PDLC ticket state (pdlc/<TICKET-ID>/phase-state.json) found under ' + root + ' — ' +
    'a production deploy has to come from a ticket whose launch gate cleared (release.md approved by the release manager, with approval_evidence).'
  );
}

const problems = [];
for (const dir of ticketDirs) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(dir, 'phase-state.json'), 'utf8'));
  } catch (err) {
    problems.push(`${path.relative(root, dir) || '.'}: phase-state.json unreadable (${err.message.split('\n')[0]})`);
    continue;
  }
  const phase = Array.isArray(state.phases) ? state.phases[state.phase_index] : undefined;
  if (!phase) continue; // complete — its launch gate already cleared

  // Only the launch phase's gate is a deploy approval. This hook belongs
  // to a launch-phase module (module.yaml: phase: launch), which is why
  // it can name that phase; the engine itself never does.
  if (phase !== 'launch') {
    problems.push(`${path.relative(root, dir) || '.'}: still at phase "${phase}" (track "${state.track}") — a production deploy needs the launch gate, i.e. an approved release.md`);
    continue;
  }

  let statusOutput;
  try {
    statusOutput = execFileSync('node', [runtime, 'status', '--project', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    problems.push(`${path.relative(root, dir) || '.'}: could not read the gate (${(err.stderr || err.message || '').toString().split('\n')[0]})`);
    continue;
  }
  if (!/^gate:\s*CLEAR/m.test(statusOutput)) {
    problems.push(`${path.relative(root, dir) || '.'}: launch gate not clear —\n${statusOutput.trim()}`);
  }
}

if (problems.length === 0) allow();

deny(
  'Blocked: the launch gate is not clear — deploying to production now would ship without the release manager\'s recorded approval.\n\n' +
  problems.join('\n\n') +
  '\n\nGet release.md approved (status: approved, approved_by, approval_evidence) and re-run status; the hook allows the deploy once the gate reads CLEAR or the ticket is complete.'
);
