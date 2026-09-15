'use strict';

// `compile --out` was still a manual, one-repo-at-a-time command —
// confirmed as a real gap earlier in the build. This loops over every
// repo declared in stack-miner's repos.yaml (the one file that already
// knows which repo is which stack) and compiles+distributes into each
// one, scoped to only the stack(s) that repo actually is — a Java-only
// repo doesn't get react-conventions shipped into it too.

const fs = require('fs');
const path = require('path');
const compiler = require('./compiler');
const { distributeRuntime } = require('./distribute-runtime');
const { distributeCiTemplate } = require('./distribute-ci');

function distributeAll({ reposYamlPath, modulesDir, repoRoot, registry }) {
  if (!fs.existsSync(reposYamlPath)) {
    throw new Error(
      `${reposYamlPath} not found. Copy modules/meta/stack-miner/repos.yaml.example ` +
      `to modules/meta/stack-miner/repos.yaml, list real repos with local_path set, and try again.`
    );
  }
  const { readYaml } = require('./util');
  const repos = readYaml(reposYamlPath) || {};
  const stacksMap = repos.stacks || {};

  // Group by local_path so a monorepo entry appearing under multiple
  // stacks gets ONE compile with all its stacks active, not repeated
  // conflicting compiles into the same directory.
  const byLocalPath = new Map();
  const skipped = [];
  for (const [stackId, entries] of Object.entries(stacksMap)) {
    for (const entry of entries || []) {
      if (!entry.local_path) {
        skipped.push({ stack: stackId, repo: entry.repo, reason: 'no local_path set in repos.yaml' });
        continue;
      }
      const localPath = path.resolve(entry.local_path);
      if (!byLocalPath.has(localPath)) byLocalPath.set(localPath, new Set());
      byLocalPath.get(localPath).add(stackId);
    }
  }

  const results = [];
  for (const [localPath, stackSet] of byLocalPath) {
    if (!fs.existsSync(localPath)) {
      skipped.push({ localPath, reason: 'local_path does not exist on this machine' });
      continue;
    }
    const compileResult = compiler.compileAll(modulesDir, localPath, {
      excludeMeta: true,
      registry,
      onlyStacks: [...stackSet],
    });
    distributeRuntime(repoRoot, localPath);
    distributeCiTemplate(repoRoot, localPath);
    results.push({
      localPath,
      stacks: [...stackSet],
      modules: compileResult.modules,
      dormant: compileResult.dormant,
    });
  }

  return { results, skipped };
}

module.exports = { distributeAll };
