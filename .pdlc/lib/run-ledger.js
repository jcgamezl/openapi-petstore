'use strict';

// Confirmed via grep before building this: memory/runs/ has existed
// since the very first commit and nothing ever wrote to it. The "a
// new developer, or agent run 4, reads the ledger tail instead of the
// whole git log" story from the architecture plan had no actual
// persistence mechanism behind it.
//
// Lives in the project directory (a ticket's worktree in practice) —
// committed alongside the code changes on that branch, same as any
// other artifact, so it merges into the shared history on that
// project the normal way, not lost when the worktree is removed.

const path = require('path');
const { ensureDir, writeFrontmatter } = require('./util');

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// data: plain object -> YAML frontmatter. body: the human-readable
// summary line(s). Returns the path written, so callers can log it.
function appendRun(projectDir, data, body) {
  const runsDir = path.join(projectDir, 'memory', 'runs');
  ensureDir(runsDir);
  const slug = (data.event || 'run') + '-' + (data.to_phase || data.starting_phase || data.phase || 'unknown');
  const filePath = path.join(runsDir, `${timestampSlug()}-${slug}.md`);
  writeFrontmatter(filePath, data, body || '');
  return filePath;
}

module.exports = { appendRun };
