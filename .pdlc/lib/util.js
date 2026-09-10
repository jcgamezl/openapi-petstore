'use strict';

const fs = require('fs');
const path = require('path');

// js-yaml resolution order: the spine fork's own node_modules (normal
// npm install), then the copy distribute-runtime vendors at
// .pdlc/vendor/js-yaml. It is deliberately NOT vendored under a
// node_modules/ directory — every React/Angular/Node target repo
// gitignores `node_modules/`, so a .pdlc/node_modules/js-yaml copy was
// never committed, and every teammate's fresh clone (and every git
// worktree, which only contains committed files) failed on
// "Cannot find module 'js-yaml'" for every single spine command.
function loadYamlLib() {
  try {
    return require('js-yaml');
  } catch (err) {
    const vendored = path.join(__dirname, '..', 'vendor', 'js-yaml');
    if (fs.existsSync(vendored)) return require(vendored);
    throw new Error(
      `js-yaml not found — neither installed (npm install) nor vendored at ${vendored}. ` +
      'If this is a distributed .pdlc/ runtime, re-run `spine distribute-runtime` from the spine fork.'
    );
  }
}
const yaml = loadYamlLib();

function readYaml(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return yaml.load(raw);
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON (${err.message}) — fix or delete it; if it's a hand-edited phase-state.json, restore it from git.`);
  }
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

// Parses a markdown file with YAML frontmatter:
//   ---
//   key: value
//   ---
//   body text
// Returns { data, body } or null if the file doesn't exist. A file whose
// frontmatter is not valid YAML (a Jira title with an unquoted colon is
// the everyday case) returns { data: {}, body, error } instead of
// throwing — the gate engine turns that into a readable blocker rather
// than a raw js-yaml stack trace from status/advance/gate-check.
function parseFrontmatter(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  let data;
  try {
    data = yaml.load(match[1]);
  } catch (err) {
    const line = err.mark && typeof err.mark.line === 'number' ? ` (frontmatter line ${err.mark.line + 1})` : '';
    return { data: {}, body: match[2], error: `frontmatter is not valid YAML${line}: ${err.reason || err.message}. Quote values that contain ':' or '#', e.g. title: "Fix: payments timeout".` };
  }
  if (data !== null && typeof data !== 'object') {
    return { data: {}, body: match[2], error: 'frontmatter is not a YAML mapping (key: value lines)' };
  }
  return { data: data || {}, body: match[2] };
}

function writeFrontmatter(filePath, data, body) {
  const front = yaml.dump(data, { lineWidth: -1 }).trimEnd();
  const content = `---\n${front}\n---\n${body || ''}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

module.exports = {
  yaml,
  readYaml,
  readJsonIfExists,
  writeJson,
  ensureDir,
  parseFrontmatter,
  writeFrontmatter,
};
