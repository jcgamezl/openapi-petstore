'use strict';

// Deterministic bookkeeping only — this does NOT run stack-miner or
// call an LLM. It answers "which stacks in repos.yaml don't have a
// module yet", so a human knows exactly which stacks still need a
// mining session. Mining itself stays one-at-a-time, human-reviewed —
// see modules/meta/stack-miner/SKILL.md.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readYaml } = require('./util');
const { scanModules } = require('./compiler');

// Last commit date touching this file, via git log — not a judgment on
// whether it's "too old," just the fact a human decides against. Falls
// back to null if this isn't a git checkout or the file is untracked.
function lastModified(filePath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', filePath], {
      cwd: path.dirname(filePath),
      encoding: 'utf8',
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}


// A topic counts as addressed when any of its match strings appears
// anywhere in the SKILL.md — the imported rules-catalog block included.
// A catalog rule that covers the topic does cover the topic; the point
// is to find what nobody has written about at all, not to grade prose.
function topicCoverage(skillBody, topics) {
  const haystack = skillBody.toLowerCase();
  const addressed = [];
  const unaddressed = [];
  for (const topic of topics) {
    const hit = topic.match.some((m) => haystack.includes(m.toLowerCase()));
    (hit ? addressed : unaddressed).push(topic.id);
  }
  return { addressed, unaddressed };
}

// Deliberately fails open, like the escalation check in gate-engine:
// this report exists to tell a human where to point the miner next, and
// a taxonomy that is missing, malformed or silent about a stack must
// never turn into a false "fully covered" or a crash.
function loadTopics(topicsPath) {
  if (!topicsPath || !fs.existsSync(topicsPath)) return {};
  try {
    const doc = readYaml(topicsPath) || {};
    return doc.stacks || {};
  } catch {
    return {};
  }
}

function findStackGaps(reposYamlPath, modulesDir, opts = {}) {
  if (!fs.existsSync(reposYamlPath)) {
    throw new Error(
      `${reposYamlPath} not found. Copy modules/meta/stack-miner/repos.yaml.example ` +
      `to modules/meta/stack-miner/repos.yaml and list the client's real repos first.`
    );
  }
  const repos = readYaml(reposYamlPath) || {};
  const wanted = Object.keys(repos.stacks || {});
  const modules = scanModules(modulesDir);
  const byId = new Map(modules.map((m) => [m.manifest.id, m]));
  const topicsByStack = loadTopics(
    opts.topicsPath || path.join(modulesDir, 'meta', 'stack-miner', 'topics.yaml')
  );

  const missing = wanted.filter((id) => !byId.has(id));
  const covered = wanted
    .filter((id) => byId.has(id))
    .map((id) => {
      const mod = byId.get(id);
      const skillPath = path.join(mod.dir, 'SKILL.md');
      const draft = path.join(mod.dir, 'SKILL.md.draft');
      const topics = topicsByStack[id]
        ? topicCoverage(fs.readFileSync(skillPath, 'utf8'), topicsByStack[id])
        : null;
      return {
        id,
        skillPath,
        lastModified: lastModified(skillPath),
        draftPath: fs.existsSync(draft) ? draft : null,
        topics,
      };
    });
  const draftInProgress = wanted.filter((id) =>
    fs.existsSync(path.join(modulesDir, 'stacks', id.replace(/-conventions$/, ''), 'SKILL.md.draft'))
  );

  return { wanted, covered, missing, draftInProgress };
}

module.exports = { findStackGaps, topicCoverage };
