'use strict';

// Copies a self-contained runtime bundle into a target repo, under
// .pdlc/ — WITHOUT this, `compile --out <target>` only ever
// distributed skills/agents/hooks, never the engine that drives
// gates/routing/worktree setup. A repo with only .claude/+.cursor/
// has skills to load but nothing for the agent to actually invoke via
// Bash for status/advance/route/start-ticket — those commands
// literally didn't exist outside the spine fork.
//
// Zero-npm-install-required in the target repo: js-yaml is vendored
// alongside the runtime at .pdlc/vendor/js-yaml, not declared as a
// dependency the target repo has to install itself — a Java or Python
// repo shouldn't need `npm install` just to get PDLC gate tracking
// working. NOT under a node_modules/ directory: every React/Angular/
// Node repo gitignores node_modules/, so the previous
// .pdlc/node_modules/js-yaml copy was never committed and every fresh
// clone and every git worktree failed on "Cannot find module 'js-yaml'"
// for every spine command (audit finding). util.js falls back to the
// vendor/ path when require('js-yaml') fails.

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./util');

const RUNTIME_FILES = [
  'lib/approval-strategies.js',
  'lib/gate-engine.js',
  'lib/gate-report.js',
  'lib/router.js',
  'lib/compiler.js',
  'lib/util.js',
  'lib/stack-gaps.js',
  'lib/stack-scope.js',
  'lib/plugin-build.js',
  'lib/overlap-check.js',
  'lib/migrate-skill.js',
  'lib/start-ticket.js',
  'lib/finish-ticket.js',
  'lib/distribute-runtime.js',
  'lib/run-ledger.js',
  'lib/spec-kitti.js',
  'lib/import-rules.js', // studio-only, but required unconditionally by spine.js (see distribute-all.js note)
  // distribute-all.js is studio-only (a target repo would never
  // meaningfully run it), but spine.js requires every command's
  // module unconditionally at the top of the file regardless of
  // which command is invoked — so it still has to be present for the
  // require to succeed, or EVERY command in the distributed bundle
  // breaks, not just this one. See the "spine.js requires every file
  // it imports" regression test below for why this list can't drift
  // out of sync silently anymore.
  'lib/distribute-all.js',
  'lib/doctor.js', // same studio-only reasoning as distribute-all.js above
  'lib/distribute-ci.js', // same studio-only reasoning — required unconditionally by spine.js
  'bin/spine.js',
  'phase-graph.yaml',
  'schemas/intent.v1.json',
  'schemas/scope.v1.json',
  'schemas/spec.v1.json',
  'schemas/plan.v1.json',
  'schemas/module.schema.json',
  'templates/ci/github-actions-pdlc-gate-check.yml', // read by lib/distribute-ci.js at runtime
];

function copyFile(spineDir, repoRoot, relPath, outDir) {
  const src = path.join(spineDir, relPath);
  const dest = path.join(outDir, relPath);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDirRecursive(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function distributeRuntime(repoRoot, targetRoot) {
  const spineDir = path.join(repoRoot, 'spine');
  const outDir = path.join(targetRoot, '.pdlc');
  const written = [];

  for (const relPath of RUNTIME_FILES) {
    copyFile(spineDir, repoRoot, relPath, outDir);
    written.push(path.join(outDir, relPath));
  }
  // Every artifact schema ships, listed above or not — a writer module
  // pointing at .pdlc/schemas/<new>.v1.json must find it there.
  for (const f of fs.readdirSync(path.join(spineDir, 'schemas'))) {
    const rel = `schemas/${f}`;
    if (f.endsWith('.json') && !RUNTIME_FILES.includes(rel)) {
      copyFile(spineDir, repoRoot, rel, outDir);
      written.push(path.join(outDir, rel));
    }
  }

  const yamlSrc = path.join(repoRoot, 'node_modules', 'js-yaml');
  const yamlDest = path.join(outDir, 'vendor', 'js-yaml');
  if (fs.existsSync(yamlSrc)) {
    copyDirRecursive(yamlSrc, yamlDest);
    written.push(yamlDest);
  } else {
    throw new Error(`${yamlSrc} not found — run \`npm install\` in the spine repo before distributing`);
  }
  // A previous distribution's gitignored copy — remove it so nobody
  // is misled into thinking it's the one being used.
  fs.rmSync(path.join(outDir, 'node_modules'), { recursive: true, force: true });

  // The pilot-facing quickstart goes to the TARGET REPO ROOT (not
  // under .pdlc/, which is documented as "generated, don't read/edit")
  // — it's the one document a developer opening this repo tomorrow
  // is meant to read first.
  const quickstartSrc = path.join(spineDir, 'templates', 'pilot', 'PDLC-QUICKSTART.md');
  if (fs.existsSync(quickstartSrc)) {
    const quickstartDest = path.join(targetRoot, 'PDLC-QUICKSTART.md');
    fs.copyFileSync(quickstartSrc, quickstartDest);
    written.push(quickstartDest);
  }

  const readme = [
    '# .pdlc/ — generated, do not edit',
    '',
    'Self-contained PDLC runtime, distributed from the spine fork via',
    '`spine compile` / `spine distribute-runtime`. This is what an agent',
    '(Claude Code / Cursor) invokes via Bash for phase/gate/routing',
    'operations in this repo — it is not meant to be run by hand.',
    '',
    'Prerequisites on a developer machine: Node >= 18 and git >= 2.20.',
    'No npm install needed — js-yaml is vendored under vendor/.',
    '',
    'Commit this whole directory (plus .claude/, .cursor/ and',
    '.github/workflows/pdlc-gate-check.yml): ticket worktrees only',
    'contain committed files, and the CI check needs it on every branch.',
    '',
    'Ticket state and artifacts live in pdlc/<TICKET-ID>/ inside each',
    'ticket\'s worktree — see PDLC-QUICKSTART.md at the repo root.',
    'Re-distributed automatically whenever the spine fork re-compiles',
    'into this repo — do not hand-edit anything under here.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'README.md'), readme, 'utf8');
  written.push(path.join(outDir, 'README.md'));

  return written;
}

module.exports = { distributeRuntime, RUNTIME_FILES };
