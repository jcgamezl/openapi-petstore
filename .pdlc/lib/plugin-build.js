'use strict';

// Builds the spine into ONE plugin directory that both Claude Code and
// Cursor install, by REUSING compileAll rather than generating a second
// time — the same reasoning doctor.js applies: a second generator drifts
// from the first, and the only way it cannot is if it IS the first.
// compileAll writes the repo layout into a staging dir; this rearranges
// that output into the plugin layout.
//
// The two tools line up better than expected: skills/, agents/ and
// commands/ are the SAME paths in both. rules/ is Cursor-only and Claude
// Code ignores it. The one genuine collision is hooks/hooks.json — same
// default path, different schema and different event-name casing
// (PreToolUse vs preToolUse) — so each manifest points at its own file.
//
// What a plugin still cannot carry, and why compile --out stays:
// .github/workflows/ (no plugin can install CI, and it is the only
// control that cannot be talked around) and pdlc/<TICKET>/ (the approval
// record belongs with the code it approves).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { compileAll } = require('./compiler');
const { ensureDir } = require('./util');

const PLUGIN_NAME = 'pdlc';
const MARKETPLACE_NAME = 'pdlc-spine';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function pluginMeta(version) {
  return {
    name: PLUGIN_NAME,
    version,
    description:
      'The PDLC spine: phase gates, ticket routing, and the discipline and stack reviewers. '
      + 'Gate operations come from the pdlc MCP server; the hooks block a commit without tests '
      + 'and a deploy with an unclear launch gate.',
    author: { name: 'pdlc-spine' },
  };
}

// Claude Code's registrations come out of compileAll in
// .claude/settings.json, Cursor's in .cursor/hooks.json — both already
// carry the right event names for their own tool, because the compiler
// has emitted both vocabularies since it was written. The only thing
// that changes here is the command path: inside a plugin it resolves
// against the plugin root, not the repo root.
function claudeHooks(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const settings = readJson(settingsPath);
  const out = {};
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    out[event] = entries.map((e) => {
      const mapped = {
        hooks: (e.hooks || []).map((h) => ({
          type: 'command',
          command: `node \${CLAUDE_PLUGIN_ROOT}/hooks/scripts/${path.basename(String(h.command))}`,
        })),
      };
      if (e.matcher) mapped.matcher = e.matcher;
      return mapped;
    });
  }
  return out;
}

function cursorHooks(hooksJsonPath) {
  if (!fs.existsSync(hooksJsonPath)) return { version: 1, hooks: {} };
  const src = readJson(hooksJsonPath);
  const out = {};
  for (const [event, entries] of Object.entries(src.hooks || {})) {
    out[event] = (Array.isArray(entries) ? entries : [entries]).map((e) => {
      const entry = {
        command: `./hooks/scripts/${path.basename(String(e.command))}`,
        type: 'command',
      };
      if (e.matcher) entry.matcher = e.matcher;
      if (e.failClosed !== undefined) entry.failClosed = e.failClosed;
      return entry;
    });
  }
  return { version: src.version || 1, hooks: out };
}

function copyInto(src, dest) {
  if (!fs.existsSync(src)) return [];
  ensureDir(path.dirname(dest));
  fs.cpSync(src, dest, { recursive: true });
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else found.push(p);
    }
  };
  const stat = fs.statSync(dest);
  if (stat.isDirectory()) walk(dest);
  else found.push(dest);
  return found;
}

function buildPlugin(modulesDir, outDir, opts = {}) {
  const repoRoot = path.join(__dirname, '..', '..');

  // Building a plugin is a studio operation: it copies the spine tree and
  // vendors js-yaml out of node_modules. This file ships in the
  // distributed .pdlc/ runtime for consistency with the other studio
  // commands, and neither of those exists there — so say that plainly
  // rather than produce a plugin with pieces missing.
  const vendorSource = path.join(repoRoot, 'node_modules', 'js-yaml');
  if (!fs.existsSync(vendorSource)) {
    throw new Error(
      'build-plugin has to run from a spine checkout: no node_modules/js-yaml to vendor at '
      + `${vendorSource}. Run it from the spine fork (npm install first), not from a distributed .pdlc/ runtime.`
    );
  }
  const version = readJson(path.join(repoRoot, 'package.json')).version || '0.1.0';

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-plugin-stage-'));
  let compiled;
  try {
    compiled = compileAll(modulesDir, staging, {
      onlyStacks: opts.onlyStacks || null,
      // Meta modules are studio tooling for building other modules; they
      // do not belong in a plugin a client installs. Same default as
      // `compile --out`.
      excludeMeta: opts.includeMeta !== true,
    });

    fs.rmSync(outDir, { recursive: true, force: true });
    ensureDir(outDir);
    const written = [];

    written.push(...copyInto(path.join(staging, '.claude', 'skills'), path.join(outDir, 'skills')));
    written.push(...copyInto(path.join(staging, '.claude', 'agents'), path.join(outDir, 'agents')));
    written.push(...copyInto(path.join(staging, '.cursor', 'rules'), path.join(outDir, 'rules')));
    written.push(...copyInto(path.join(staging, '.claude', 'hooks'), path.join(outDir, 'hooks', 'scripts')));

    const scriptsDir = path.join(outDir, 'hooks', 'scripts');
    if (fs.existsSync(scriptsDir)) {
      for (const f of fs.readdirSync(scriptsDir)) fs.chmodSync(path.join(scriptsDir, f), 0o755);
    }

    // The engine, vendored the way distribute-runtime does it: no
    // npm install at the destination, and never under a node_modules/
    // directory, which every JS repo gitignores.
    for (const rel of ['bin', 'lib', 'schemas', 'phase-graph.yaml']) {
      written.push(...copyInto(path.join(repoRoot, 'spine', rel), path.join(outDir, 'spine', rel)));
    }
    written.push(...copyInto(
      path.join(repoRoot, 'node_modules', 'js-yaml'),
      path.join(outDir, 'spine', 'vendor', 'js-yaml')
    ));

    const write = (rel, data) => {
      const p = path.join(outDir, rel);
      ensureDir(path.dirname(p));
      fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
      written.push(p);
    };

    const meta = pluginMeta(version);
    write('.claude-plugin/plugin.json', { ...meta, hooks: './hooks/claude-hooks.json' });
    write('.cursor-plugin/plugin.json', { ...meta, hooks: './hooks/cursor-hooks.json' });
    write('hooks/claude-hooks.json', claudeHooks(path.join(staging, '.claude', 'settings.json')));
    write('hooks/cursor-hooks.json', cursorHooks(path.join(staging, '.cursor', 'hooks.json')));
    // The gate server, declared for both tools. ${workspaceFolder} is how
    // the editor tells it which repo it is looking at — the abandoned
    // August experiment hardcoded an absolute path here and worked on
    // exactly one machine. ${PLUGIN_ROOT} is Cursor's documented
    // placeholder for mcp.json; Claude Code's is ${CLAUDE_PLUGIN_ROOT}.
    const mcpServer = (rootVar) => ({
      mcpServers: {
        pdlc: {
          type: 'stdio',
          command: 'node',
          args: [`\${${rootVar}}/spine/mcp/server.js`],
          env: { PDLC_PROJECT_DIR: '${workspaceFolder}' },
        },
      },
    });
    write('mcp.json', mcpServer('PLUGIN_ROOT'));
    write('.mcp.json', mcpServer('CLAUDE_PLUGIN_ROOT'));
    written.push(...copyInto(path.join(repoRoot, 'spine', 'mcp'), path.join(outDir, 'spine', 'mcp')));

    write('.claude-plugin/marketplace.json', {
      name: MARKETPLACE_NAME,
      description: 'The PDLC spine, distributed as a plugin.',
      owner: { name: 'pdlc-spine' },
      plugins: [{ name: PLUGIN_NAME, description: meta.description, version, source: './' }],
    });

    return { written, modules: compiled.modules, outDir };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { buildPlugin, PLUGIN_NAME, MARKETPLACE_NAME };
