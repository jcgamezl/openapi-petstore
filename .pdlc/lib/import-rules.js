'use strict';

// Imports the client's versioned rules catalog (the repo behind
// spec-kitti's `rules-catalog/rules.yaml` — "golden rules" in their
// vocabulary; here they are just the client's rules) into the spine's
// modules, deterministically and repeatably:
//
//   rules.yaml entry                       -> spine module (references/rules/...)
//   core.<category>.*                      -> disciplines/engineering-practices
//   implementation.<stack>.*               -> stacks/<stack>  (created if missing)
//   implementation.code-style.*.{js,ts}    -> stacks/react AND stacks/node
//   implementation.design-system.{web,mobile}.* -> disciplines/design-system
//   discovery.endpoint-patterns.*          -> meta/stack-miner
//   security-main                          -> skipped (ported by hand into disciplines/security)
//
// Each rule body is copied verbatim (frontmatter stripped, provenance
// header added) as references/rules/<sub>/<name>.md, and a generated
// block between <!-- rules-catalog:start --> / <!-- rules-catalog:end -->
// in the module's SKILL.md lists every imported rule with what files it
// applies to. Re-running with a newer catalog rewrites exactly that
// block and those files; everything else in the module is hand-authored
// and untouched. rules-catalog.lock.json at the modules root records
// catalog version and per-rule versions so drift is visible in git.
//
// Studio-side only (like distribute-all): a target repo never runs this.

const fs = require('fs');
const path = require('path');
const { yaml, ensureDir } = require('./util');

const START = '<!-- rules-catalog:start -->';
const END = '<!-- rules-catalog:end -->';
const LOCK_FILE = 'rules-catalog.lock.json';

const STACK_META = {
  java: { name: 'Java', hint: 'Java 21 / Spring Boot' },
  react: { name: 'React', hint: 'React, Next.js, Vite, TypeScript' },
  angular: { name: 'Angular', hint: 'Angular / TypeScript' },
  node: { name: 'Node.js', hint: 'Node.js services — Fastify, NestJS, TypeScript' },
  python: { name: 'Python', hint: 'Python services — FastAPI' },
  kotlin: { name: 'Kotlin', hint: 'Kotlin backend — Spring Boot 3' },
  flutter: { name: 'Flutter', hint: 'Flutter / Dart mobile apps' },
  go: { name: 'Go', hint: 'Go services' },
  plsql: { name: 'PL/SQL', hint: 'Oracle PL/SQL packages and procedures' },
  terraform: { name: 'Terraform', hint: 'Terraform on AWS and Azure' },
  nullplatform: { name: 'nullplatform', hint: 'the nullplatform deployment platform' },
};

// Where a catalog rule lands. Returns null for rules the spine handles
// otherwise (documented in the summary, never silently dropped).
function targetsFor(rule) {
  const parts = rule.id.split('.');
  const [top, second] = parts;
  const name = parts[parts.length - 1];
  if (rule.id === 'security-main' || top === 'security') return [{ skip: 'ported by hand into modules/disciplines/security' }];
  if (top === 'core') return [{ module: 'disciplines/engineering-practices', sub: second, name }];
  if (top === 'discovery') return [{ module: 'meta/stack-miner', sub: `discovery-${second}`, name: parts.slice(2).join('-') }];
  if (top === 'implementation') {
    if (second === 'design-system') return [{ module: 'disciplines/design-system', sub: parts[2], name }];
    if (second === 'code-style') {
      const lang = parts.includes('typescript') ? 'typescript' : parts.includes('javascript') ? 'javascript' : name;
      return [
        { module: 'stacks/react', sub: 'code-style', name: lang, stack: 'react' },
        { module: 'stacks/node', sub: 'code-style', name: lang, stack: 'node' },
      ];
    }
    const stack = second === 'kotlin-backend' ? 'kotlin' : second;
    if (!STACK_META[stack]) return [{ skip: `no spine stack module mapped for implementation.${second}` }];
    // implementation.react.golden_rules.nextjs.foo -> sub "nextjs"; plain -> sub "core"
    const between = parts.slice(2).filter((p) => p !== 'golden_rules');
    const sub = between.length > 1 ? between.slice(0, -1).join('-') : 'core';
    return [{ module: `stacks/${stack}`, sub, name: between[between.length - 1], stack }];
  }
  return [{ skip: `catalog family "${top}" is not something the spine consumes` }];
}

function stripFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: content };
  let fm = {};
  try {
    fm = yaml.load(m[1]) || {};
  } catch {
    fm = {};
  }
  return { fm, body: m[2] };
}

function globsOf(fm) {
  if (Array.isArray(fm.globs)) return fm.globs.map(String);
  if (typeof fm.globs === 'string') return fm.globs.split(',').map((s) => s.trim()).filter(Boolean);
  if (typeof fm.applyTo === 'string') return fm.applyTo.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function referenceContent(rule, fm, body, catalogVersion) {
  const globs = globsOf(fm);
  const header = [
    `<!-- Imported verbatim from the client's rules catalog v${catalogVersion} by \`spine import-rules\`.`,
    `     rule: ${rule.id} (v${rule.version || '?'})  source: ${rule.package_relative}`,
    `     Do not edit here — change the catalog and re-import. -->`,
    '',
    `> **${rule.id}** — ${rule.description || ''}`.trimEnd(),
    globs.length ? `> Applies to: ${globs.map((g) => `\`${g}\``).join(', ')}` : '',
    '',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === ''));
  return header.join('\n') + '\n' + body.trimStart();
}

function stackModuleFiles(stack) {
  const meta = STACK_META[stack];
  const id = `${stack}-conventions`;
  const manifest = [
    `id: ${id}`,
    'kind: agent',
    '# Shared stack module (no phase/capability): available in every session of',
    `# a ${meta.name} repo. Created by \`spine import-rules\` from the client's rules`,
    '# catalog; the hand-authored part of SKILL.md is yours to extend, the',
    '# generated block between the rules-catalog markers is not.',
    `description: Reviews and writes ${meta.name} code against this client's conventions (${meta.hint}) — the client's own rules catalog, applied per file pattern`,
    'tool_compat: [claude, cursor]',
    'model_tier: sonnet',
    `owner: "#platform-${stack}-guild"`,
    '',
  ].join('\n');
  const skill = [
    '---',
    `name: ${id}`,
    `description: This client's ${meta.name} conventions (${meta.hint}) — the rules their own catalog mandates, applied to the files each rule names. Use for any review or generation of ${meta.name} code in this client's projects, in any PDLC phase.`,
    '---',
    '',
    `# ${meta.name} conventions`,
    '',
    `The client's ${meta.name} rules, imported from their versioned rules catalog.`,
    'Each rule below is a MUST / MUST NOT list the client already enforces;',
    'read the reference whose file patterns match what you are touching',
    'before writing or reviewing code, and cite the rule id when a finding',
    'comes from one. When a rule and the repository disagree, the rule is',
    'the standard and the repository is the finding — say so rather than',
    'silently following the code.',
    '',
    'Run `stack-miner` against the real repositories to learn what the',
    'catalog does not cover (naming in this codebase, local wrappers, the',
    'exceptions the team actually lives with) and record that in the',
    'hand-authored part of this file, above the generated block.',
    '',
    START,
    END,
    '',
  ].join('\n');
  return { manifest, skill };
}

function renderBlock(entries, catalogVersion) {
  const lines = [
    START,
    `## Client rules catalog (v${catalogVersion})`,
    '',
    'Generated by `spine import-rules` — do not edit between these markers.',
    'Imported verbatim; the rule id is the client\'s own and is what to cite.',
    '',
    '| Rule | Covers | Applies to | Reference |',
    '|---|---|---|---|',
  ];
  for (const e of entries.sort((a, b) => a.rule.id.localeCompare(b.rule.id))) {
    const globs = e.globs.length ? e.globs.map((g) => `\`${g}\``).join(', ') : 'any file';
    lines.push(`| \`${e.rule.id}\` | ${(e.rule.description || '').replace(/\|/g, '\\|')} | ${globs} | \`${e.refRel}\` |`);
  }
  lines.push(END);
  return lines.join('\n');
}

function upsertBlock(skillContent, block) {
  const s = skillContent.indexOf(START);
  const e = skillContent.indexOf(END);
  if (s >= 0 && e > s) return skillContent.slice(0, s) + block + skillContent.slice(e + END.length);
  return skillContent.replace(/\s*$/, '\n\n') + block + '\n';
}

// module.yaml is hand-authored and its comments carry real reasoning —
// why a module has no phase, why always_apply is false. Parsing it and
// dumping it back would delete every one of them, so this is a textual
// upsert of one field, in the same spirit as upsertBlock does for the
// generated section of a SKILL.md.
//
// Globs must be quoted: `**/*.java` as a plain YAML scalar starts with
// `*`, which YAML reads as an alias, and the file stops parsing.
function upsertAppliesTo(text, globs) {
  const block = ['applies_to:', ...globs.map((g) => `  - "${String(g).replace(/"/g, '\\"')}"`)].join('\n');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^applies_to:\s*$/.test(l) || /^applies_to:\s*\[/.test(l));
  if (start === -1) {
    const trimmed = text.replace(/\n+$/, '');
    return `${trimmed}\n# File patterns these conventions apply to, so a repo with several\n# stacks gets the right reviewer per file. Maintained by\n# \`spine import-rules\` from the rules' own "Applies to:" lines; a glob\n# added by hand here is preserved on re-import.\n${block}\n`;
  }
  let end = start + 1;
  while (end < lines.length && /^\s+/.test(lines[end]) && lines[end].trim() !== '') end += 1;
  return [...lines.slice(0, start), block, ...lines.slice(end)].join('\n');
}

// The union is co-owned: the catalog contributes most of it, and a stack
// owner who knows the repos can add a pattern the catalog never mentioned.
// A re-import must not eat that.
function mergeAppliesTo(existing, derived) {
  const all = new Set([...(Array.isArray(existing) ? existing : []), ...derived]);
  return [...all].sort();
}

function importRules({ catalogPath, rulesRoot, modulesDir }) {
  const catalog = yaml.load(fs.readFileSync(catalogPath, 'utf8'));
  if (!catalog || !Array.isArray(catalog.rules)) throw new Error(`${catalogPath} has no "rules" list`);
  const catalogVersion = String(catalog.catalog_version || catalog.version || 'unknown');
  const perModule = new Map(); // module rel -> entries
  const skipped = [];
  const missing = [];
  const created = [];
  const written = [];

  for (const rule of catalog.rules) {
    const src = path.join(rulesRoot, rule.package_relative || '');
    for (const t of targetsFor(rule)) {
      if (t.skip) {
        skipped.push({ id: rule.id, reason: t.skip });
        continue;
      }
      if (!rule.package_relative || !fs.existsSync(src)) {
        missing.push({ id: rule.id, file: rule.package_relative || '(none)' });
        continue;
      }
      const moduleDir = path.join(modulesDir, t.module);
      if (!fs.existsSync(moduleDir)) {
        if (!t.stack) throw new Error(`target module ${t.module} for ${rule.id} does not exist and is not a stack module — create it by hand first`);
        ensureDir(moduleDir);
        const files = stackModuleFiles(t.stack);
        fs.writeFileSync(path.join(moduleDir, 'module.yaml'), files.manifest, 'utf8');
        fs.writeFileSync(path.join(moduleDir, 'SKILL.md'), files.skill, 'utf8');
        created.push(t.module);
      }
      const { fm, body } = stripFrontmatter(fs.readFileSync(src, 'utf8'));
      const refRel = path.posix.join('references', 'rules', t.sub, `${t.name}.md`);
      const refAbs = path.join(moduleDir, refRel);
      ensureDir(path.dirname(refAbs));
      fs.writeFileSync(refAbs, referenceContent(rule, fm, body, catalogVersion), 'utf8');
      written.push(refAbs);
      if (!perModule.has(t.module)) perModule.set(t.module, []);
      perModule.get(t.module).push({ rule, refRel, globs: globsOf(fm), version: rule.version || null });
    }
  }

  // Remove previously imported rule files that are no longer in the catalog.
  const lockPath = path.join(modulesDir, LOCK_FILE);
  const previous = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null;
  const removed = [];
  const nowFiles = new Set(written.map((p) => path.relative(modulesDir, p)));
  if (previous && previous.files) {
    for (const rel of previous.files) {
      if (!nowFiles.has(rel)) {
        const abs = path.join(modulesDir, rel);
        if (fs.existsSync(abs)) {
          fs.rmSync(abs);
          removed.push(abs);
        }
      }
    }
  }

  for (const [moduleRel, entries] of perModule) {
    const skillPath = path.join(modulesDir, moduleRel, 'SKILL.md');
    const current = fs.readFileSync(skillPath, 'utf8');
    fs.writeFileSync(skillPath, upsertBlock(current, renderBlock(entries, catalogVersion)), 'utf8');
    written.push(skillPath);

    // Every catalog rule already states its own file patterns; recording
    // the union on the module is what turns "which stack reviewers does
    // this diff need" into a computed answer instead of an inference.
    // A module whose rules declare none gets no field at all — an empty
    // list would read as "applies to nothing" and silence the module.
    const derived = entries.flatMap((e) => e.globs);
    if (derived.length) {
      const manifestPath = path.join(modulesDir, moduleRel, 'module.yaml');
      const text = fs.readFileSync(manifestPath, 'utf8');
      const merged = mergeAppliesTo((yaml.load(text) || {}).applies_to, derived);
      const next = upsertAppliesTo(text, merged);
      if (next !== text) {
        fs.writeFileSync(manifestPath, next, 'utf8');
        written.push(manifestPath);
      }
    }
  }
  // A module that had imported rules last time and has none now keeps
  // no stale block behind.
  if (previous && previous.rules) {
    const previousModules = new Set(Object.values(previous.rules).map((r) => r.module));
    for (const moduleRel of previousModules) {
      if (perModule.has(moduleRel)) continue;
      const skillPath = path.join(modulesDir, moduleRel, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const current = fs.readFileSync(skillPath, 'utf8');
      const stripped = current.replace(new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n?`), '\n');
      if (stripped !== current) {
        fs.writeFileSync(skillPath, stripped, 'utf8');
        written.push(skillPath);
      }
    }
  }

  const lock = {
    catalog_version: catalogVersion,
    catalog_repository: catalog.repository || null,
    imported_at: new Date().toISOString(),
    rules: Object.fromEntries(
      [...perModule.entries()].flatMap(([m, es]) => es.map((e) => [e.rule.id, { version: e.version, module: m, reference: e.refRel }]))
    ),
    files: [...nowFiles].sort(),
    skipped,
  };
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');

  return {
    catalogVersion,
    modules: [...perModule.keys()].sort(),
    created,
    rulesImported: [...perModule.values()].reduce((n, es) => n + es.length, 0),
    written,
    removed,
    skipped,
    missing,
    lockPath,
  };
}

module.exports = { importRules, targetsFor, START, END, LOCK_FILE, STACK_META, upsertAppliesTo, mergeAppliesTo };
