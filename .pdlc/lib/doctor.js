'use strict';

// "Does a distributed target repo still match what the spine fork's
// current modules/ would generate?" — confirmed nothing checked this.
// Deliberately reuses the actual, already-tested compile machinery
// rather than reimplementing comparison logic: compiling is
// deterministic, so recompiling into the target and asking git what
// changed IS the drift report — no separate diffing algorithm to get
// wrong or let drift out of sync with compiler.js itself.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const compiler = require('./compiler');
const { distributeRuntime } = require('./distribute-runtime');

function checkDrift({ targetPath, modulesDir, repoRoot, registry, projectOverrides, onlyStacks, excludeMeta = true }) {
  const resolvedTarget = path.resolve(targetPath);
  if (!fs.existsSync(resolvedTarget)) {
    throw new Error(`${resolvedTarget} does not exist`);
  }

  const compileResult = compiler.compileAll(modulesDir, resolvedTarget, { excludeMeta, registry, projectOverrides, onlyStacks });
  distributeRuntime(repoRoot, resolvedTarget);

  let changed = [];
  let gitAvailable = true;
  try {
    const statusOut = execSync('git status --porcelain -- .claude .cursor .pdlc', { cwd: resolvedTarget, encoding: 'utf8' });
    changed = statusOut
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim());
  } catch {
    // not a git repo, or git unavailable — recompiled successfully
    // regardless, just can't report what specifically changed
    gitAvailable = false;
  }

  return {
    targetPath: resolvedTarget,
    modules: compileResult.modules,
    dormant: compileResult.dormant,
    gitAvailable,
    changed,
    inSync: gitAvailable ? changed.length === 0 : null,
  };
}

module.exports = { checkDrift };
