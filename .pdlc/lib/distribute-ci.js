'use strict';

// Ships the GitHub Actions gate-check workflow into a target repo — the
// "required CI check" half of the §06 defense-in-depth principle (hooks
// are the fast local layer, this is the layer that can't be skipped by
// whoever/whatever is pushing the commit). Without this, `spine
// distribute-runtime` gave a target repo a `gate-check` command that
// *could* fail CI, but no actual pipeline wired it up — the backstop was
// documented, not shipped.
//
// Lives outside .pdlc/ on purpose: GitHub only discovers workflows under
// .github/workflows/ at the repo root, and unlike .pdlc/ this file can
// collide with a client's own CI setup, so it's named specifically
// (pdlc-gate-check.yml) rather than claiming a generic name.

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./util');

const TEMPLATE_REL_PATH = path.join('templates', 'ci', 'github-actions-pdlc-gate-check.yml');
const DEST_REL_PATH = path.join('.github', 'workflows', 'pdlc-gate-check.yml');

function distributeCiTemplate(repoRoot, targetRoot) {
  const src = path.join(repoRoot, 'spine', TEMPLATE_REL_PATH);
  const dest = path.join(targetRoot, DEST_REL_PATH);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return dest;
}

module.exports = { distributeCiTemplate, DEST_REL_PATH };
