#!/usr/bin/env node
'use strict';

// Deterministic backstop for "a developer doesn't know to invoke
// unit-test-writer" — this doesn't rely on the model remembering.
// Fires before `git commit` (PreToolUse+Bash in Claude Code,
// beforeShellExecution in Cursor — see module.yaml's hooks binding).
//
// Fails OPEN on anything it can't confidently parse: an enforcement
// hook that blocks commits due to a schema mismatch is worse than one
// that occasionally misses a real case. Only blocks when it's sure
// this is a git commit AND sure no test file is staged alongside
// source changes. (The Cursor binding leaves cursor_fail_closed false
// for the same reason — see modules/.../module.yaml.)
//
// The two tools disagree about both the input shape and how a verdict
// is returned, so this script speaks both protocols:
//
//   Claude Code  in: {"tool_input":{"command":...},"cwd":...}
//                out: text on stderr + exit 2 to block
//   Cursor       in: {"command":...,"cwd":...}   (top level, no tool_input)
//                out: {"permission":"allow"|"deny",...} on stdout; exit 2 also blocks

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// Parse stdin exactly once — cwd and command both come from it.
const payload = parsePayload(readStdin()) || {};
const isCursor = !payload.tool_input && typeof payload.command === 'string';

function allow() {
  if (isCursor) process.stdout.write(JSON.stringify({ permission: 'allow' }) + '\n');
  process.exit(0);
}

function deny(message) {
  // Both channels, unconditionally: Cursor reads the JSON verdict on
  // stdout, Claude Code reads stderr text with exit 2. Emitting both is
  // inert in the tool that doesn't read it, and means neither tool
  // depends on the shape detection above being right.
  process.stdout.write(
    JSON.stringify({ permission: 'deny', user_message: message, agent_message: message }) + '\n'
  );
  process.stderr.write(message + '\n');
  process.exit(2);
}

const command =
  (payload.tool_input && payload.tool_input.command) ||
  payload.command ||
  (payload.input && payload.input.command) ||
  null;

if (typeof command !== 'string' || !/\bgit\s+commit\b/.test(command)) {
  allow(); // not a git commit — nothing to check
}

if (/\[no-tests-needed:/.test(command)) {
  allow(); // explicit, visible bypass — same discipline as phase-graph's skip_reason
}

// The hook process does NOT inherit the agent's working directory in
// every host, and an agent working in a monorepo subdirectory or a
// worktree routinely runs `cd <dir> && git commit ...`. Running git
// from the wrong directory silently reported an empty index, i.e. no
// source files, i.e. never blocked. Honor the payload cwd, then any
// `cd <dir> &&` prefix on the command itself.
function resolveCwd(cmd, payloadCwd) {
  let base = typeof payloadCwd === 'string' && payloadCwd ? payloadCwd : process.cwd();
  const m = cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*&&/);
  if (m) base = path.resolve(base, m[1] || m[2] || m[3]);
  return base;
}

try {
  const cwd = resolveCwd(command, payload.cwd);
  if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) process.chdir(cwd);
} catch {
  // can't move there — carry on from wherever we are, and fail open
  // below if git then tells us nothing useful
}

function gitLines(args, { trim = true } = {}) {
  try {
    const out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((l) => l.length > 0).map((l) => (trim ? l.trim() : l));
  } catch {
    return null;
  }
}

const cached = gitLines(['diff', '--cached', '--name-only']);
if (cached === null) {
  allow(); // not in a git repo, or git unavailable — fail open
}

// What WILL be committed, not just what is already staged. The hook
// runs before the command, so `git add Foo.java && git commit` (the
// single most common form an agent writes) had nothing in the index
// yet and sailed straight through. Same for `git commit -a`.
const willCommit = new Set(cached);

function segmentsOf(cmd) {
  return cmd.split(/&&|\|\||;/).map((s) => s.trim()).filter(Boolean);
}

const ADD_EVERYTHING = /^(\.|-A|--all|-u|--update|:\/)$/;

for (const segment of segmentsOf(command)) {
  const m = segment.match(/^git\s+add\s+(.+)$/);
  if (!m) continue;
  const args = m[1].match(/"[^"]*"|'[^']*'|\S+/g) || [];
  let everything = false;
  for (const rawArg of args) {
    const arg = rawArg.replace(/^["']|["']$/g, '');
    if (ADD_EVERYTHING.test(arg)) {
      everything = true;
    } else if (!arg.startsWith('-')) {
      willCommit.add(arg);
    }
  }
  if (everything) {
    for (const line of gitLines(['status', '--porcelain', '--untracked-files=all'], { trim: false }) || []) {
      const file = line.slice(3).trim().split(' -> ').pop();
      if (file) willCommit.add(file.replace(/^["']|["']$/g, ''));
    }
  }
}

// `git commit -a` / `-am "..."` / `--all` stages every modified tracked
// file at commit time; git diff --cached is blind to all of it.
const commitSegment = segmentsOf(command).find((s) => /\bgit\s+commit\b/.test(s)) || command;
if (/(?:^|\s)-[A-Za-z]*a[A-Za-z]*(?=\s|$)/.test(commitSegment) || /(?:^|\s)--all(?=\s|$)/.test(commitSegment)) {
  for (const file of gitLines(['diff', '--name-only']) || []) willCommit.add(file);
}

const SOURCE_EXT = /\.(java|ts|tsx|js|jsx|py|go|rb)$/;

// A bare /(test|spec)/i over the whole path called Contest.java,
// Inspector.ts, Specification.py and anything under src/latest/ a test
// — which both hid real source changes from the check AND satisfied the
// "a test is present" condition on its own. Match the conventions
// instead: a test directory segment, or a real test filename pattern.
const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec']);

function isTestFile(file) {
  const parts = file.split('/');
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some((seg) => TEST_DIR_SEGMENTS.has(seg.toLowerCase()))) return true;
  return (
    /Tests?\.java$/.test(name) ||       // FooTest.java, FooTests.java
    /\.(test|spec)\.[A-Za-z0-9]+$/.test(name) || // foo.test.ts, foo.spec.js
    /^test_.*\.py$/.test(name) ||       // test_foo.py
    /_test\.go$/.test(name) ||          // foo_test.go
    /_spec\.rb$/.test(name)             // foo_spec.rb
  );
}

const candidates = [...willCommit].filter((f) => SOURCE_EXT.test(f));
const sourceFiles = candidates.filter((f) => !isTestFile(f));
const testFiles = candidates.filter((f) => isTestFile(f));

if (sourceFiles.length > 0 && testFiles.length === 0) {
  deny(
    `This commit touches ${sourceFiles.length} source file(s) with no test file staged:\n` +
    sourceFiles.map((f) => `  ${f}`).join('\n') +
    '\n\nRun the unit-test-writer skill before committing, or if tests genuinely aren\'t ' +
    'needed here, say why directly in the commit message:\n' +
    '  git commit -m "... [no-tests-needed: reason]"'
  );
}

allow();
