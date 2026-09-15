'use strict';

// Compiles modules/<id>/{module.yaml, SKILL.md, hooks/} into each tool's
// native format. modules/ is the single source of truth authored by
// humans; everything under .claude/ and .cursor/ is generated and
// overwritten on every run — see architecture plan §05.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readYaml, ensureDir, parseFrontmatter } = require('./util');

const VALID_KINDS = ['skill', 'agent', 'connector', 'gate', 'router', 'human'];
const VALID_TOOLS = ['claude', 'cursor', 'ci'];
const VALID_TIERS = ['haiku', 'sonnet', 'opus'];

// phase/capability are only required for modules that fill a gated
// capability slot (registered in registry.yaml, participate in a
// phase's exit_artifacts). A module a client brings in wholesale —
// their existing Java review agent, a stack-specific skill — isn't
// bound to any one phase's gate; it's just available every session.
// Omitting phase/capability is how a module declares that.
// CLAUDE.md has always claimed module.yaml is "validated against
// spine/schemas/module.schema.json". It wasn't — three required fields
// were checked for truthiness and nothing else, so a wrong type, a bad
// id, a malformed hooks[] entry or an entirely empty file all got
// through (an empty one as a TypeError from somewhere downstream, not a
// readable message). This is that schema, hand-written: no ajv, no new
// dependency. Keep the two in step when either changes.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const VALID_INPUT_TYPES = ['trigger', 'artifact', 'document'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateManifest(manifest, moduleDir) {
  if (!isPlainObject(manifest)) {
    const what = manifest === null || manifest === undefined ? 'an empty file (or nothing but comments)' : `a ${Array.isArray(manifest) ? 'list' : typeof manifest}`;
    throw new Error(
      `invalid module.yaml in ${moduleDir}:\n  - expected a YAML mapping of manifest fields, got ${what}` +
      `\n    (minimum: id, kind, description, tool_compat — see spine/schemas/module.schema.json)`
    );
  }

  const errors = [];
  const checkString = (field, { required = false } = {}) => {
    const value = manifest[field];
    if (value === undefined || value === null || value === '') {
      if (required) errors.push(`missing required field "${field}"`);
      return false;
    }
    if (typeof value !== 'string') {
      errors.push(`"${field}" must be a string, got ${Array.isArray(value) ? 'a list' : typeof value}`);
      return false;
    }
    return true;
  };
  const checkEnum = (field, allowed, { required = false } = {}) => {
    if (!checkString(field, { required })) return;
    if (!allowed.includes(manifest[field])) {
      errors.push(`${field} "${manifest[field]}" is not one of ${allowed.join(', ')}`);
    }
  };

  if (checkString('id', { required: true }) && !ID_PATTERN.test(manifest.id)) {
    errors.push(`id "${manifest.id}" must be lowercase alphanumeric with dashes (${ID_PATTERN}) — it becomes a filename and a skill/agent name in both tools`);
  }
  checkEnum('kind', VALID_KINDS, { required: true });
  // Required because both tools decide whether to auto-activate a rule
  // or delegate to an agent by matching the task against this text. A
  // module without one compiles into something that can never fire.
  checkString('description', { required: true });
  checkString('phase');
  checkString('capability');
  checkString('owner');
  checkString('source_of_truth');
  checkEnum('model_tier', VALID_TIERS);

  if (manifest.tool_compat === undefined || manifest.tool_compat === null) {
    errors.push('missing required field "tool_compat"');
  } else if (!Array.isArray(manifest.tool_compat) || manifest.tool_compat.length === 0) {
    errors.push(`"tool_compat" must be a non-empty list of ${VALID_TOOLS.join('/')}`);
  } else {
    for (const t of manifest.tool_compat) {
      if (!VALID_TOOLS.includes(t)) errors.push(`tool_compat entry "${t}" is not one of ${VALID_TOOLS.join(', ')}`);
    }
  }

  if ((manifest.phase && !manifest.capability) || (!manifest.phase && manifest.capability)) {
    errors.push('phase and capability must be set together, or both omitted for a shared (non-gated) module');
  }

  if (manifest.always_apply !== undefined && typeof manifest.always_apply !== 'boolean') {
    errors.push(`"always_apply" must be a boolean, got ${typeof manifest.always_apply}`);
  }

  const checkObjectList = (field, requiredKeys, check) => {
    if (manifest[field] === undefined || manifest[field] === null) return;
    if (!Array.isArray(manifest[field])) {
      errors.push(`"${field}" must be a list`);
      return;
    }
    manifest[field].forEach((item, i) => {
      const where = `${field}[${i}]`;
      if (!isPlainObject(item)) {
        errors.push(`${where} must be a mapping, got ${Array.isArray(item) ? 'a list' : typeof item}`);
        return;
      }
      for (const key of requiredKeys) {
        if (typeof item[key] !== 'string' || item[key] === '') errors.push(`${where} is missing required string field "${key}"`);
      }
      if (check) check(item, where);
    });
  };

  checkObjectList('inputs', ['type'], (item, where) => {
    if (typeof item.type === 'string' && !VALID_INPUT_TYPES.includes(item.type)) {
      errors.push(`${where}.type "${item.type}" is not one of ${VALID_INPUT_TYPES.join(', ')}`);
    }
    for (const key of ['source', 'artifact']) {
      if (item[key] !== undefined && typeof item[key] !== 'string') errors.push(`${where}.${key} must be a string`);
    }
  });
  checkObjectList('outputs', ['artifact'], (item, where) => {
    if (item.schema !== undefined && typeof item.schema !== 'string') errors.push(`${where}.schema must be a string`);
  });
  checkObjectList('hooks', ['script'], (item, where) => {
    for (const key of ['claude_event', 'claude_matcher', 'cursor_event']) {
      if (item[key] !== undefined && typeof item[key] !== 'string') errors.push(`${where}.${key} must be a string`);
    }
    if (item.cursor_fail_closed !== undefined && typeof item.cursor_fail_closed !== 'boolean') {
      errors.push(`${where}.cursor_fail_closed must be a boolean`);
    }
    if (item.claude_event && !item.claude_matcher) {
      errors.push(`${where} sets claude_event "${item.claude_event}" with no claude_matcher — Claude Code needs the matcher (e.g. Bash) to know when to fire it`);
    }
    if (!item.claude_event && !item.cursor_event) {
      errors.push(`${where} binds script "${item.script}" to no event at all — a hooks[] entry without claude_event or cursor_event never fires in either tool`);
    }
  });

  if (errors.length) {
    throw new Error(`invalid module.yaml in ${moduleDir}:\n  - ${errors.join('\n  - ')}`);
  }
}

// A hooks[] binding names a script by filename. Typo it and the old
// behavior was a "successful" compile with zero registrations — the
// hook simply never fires, in either tool, with nothing said about it.
// For an enforcement backstop that's the worst possible failure mode.
function validateHookScripts(mod) {
  const declared = mod.manifest.hooks || [];
  if (declared.length === 0) return;
  const hooksDir = path.join(mod.dir, 'hooks');
  const present = fs.existsSync(hooksDir)
    ? fs.readdirSync(hooksDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()
    : [];
  for (const binding of declared) {
    if (present.includes(binding.script)) continue;
    throw new Error(
      `module "${mod.manifest.id}" (${mod.dir}) declares a hooks[] binding for script "${binding.script}", ` +
      `but no such file exists in ${hooksDir} — ` +
      (present.length ? `files present there: ${present.join(', ')}` : 'that directory is missing or empty') +
      `. Left unchecked this compiles with the hook silently never registered.`
    );
  }
}

// Recursive: a module can live at any depth under modulesDir, e.g.
// modules/phases/jira-intake, modules/stacks/java,
// modules/disciplines/unit-test-writer — any directory that contains a
// module.yaml IS a module; the compiler doesn't care how deep it's
// nested or what its parent folders are named. Category folders
// (phases/stacks/disciplines) are a convention for humans organizing a
// module count that would otherwise sprawl flat, not something the
// engine reads.
function findModuleDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && e.name === 'module.yaml')) {
    return [dir]; // a module dir is a leaf — don't recurse into its hooks/ etc.
  }
  return entries.filter((e) => e.isDirectory()).flatMap((e) => findModuleDirs(path.join(dir, e.name)));
}

// The compile functions below extract SKILL.md frontmatter with a
// regex, not a real YAML parser (deliberately — it's copying content
// through, not interpreting it). That means broken frontmatter (an
// unquoted description containing "word: word", for instance — real
// bug, caught by the test suite, not by a compile that used to
// succeed on it) would previously compile "successfully" into a
// broken file, and only fail unpredictably whenever Claude Code or
// Cursor actually tried to parse it. Validate for real here, once,
// before anything downstream trusts the file.
function validateSkillFrontmatter(mod) {
  const skillPath = path.join(mod.dir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return;
  let fm;
  try {
    fm = parseFrontmatter(skillPath);
  } catch (err) {
    throw new Error(`invalid YAML frontmatter in ${skillPath}: ${err.message.split('\n')[0]}`);
  }
  // parseFrontmatter reports a YAML error instead of throwing (so the
  // gate engine can turn it into a readable blocker) — at compile time
  // it IS fatal.
  if (fm && fm.error) throw new Error(`invalid YAML frontmatter in ${skillPath}: ${fm.error}`);
}

function scanModules(modulesDir) {
  const modules = findModuleDirs(modulesDir).map((dir) => {
    const manifestPath = path.join(dir, 'module.yaml');
    let manifest;
    try {
      manifest = readYaml(manifestPath);
    } catch (err) {
      // js-yaml's own message doesn't name the file it choked on
      throw new Error(`invalid YAML in ${manifestPath}: ${err.message.split('\n')[0]}`);
    }
    validateManifest(manifest, dir);
    const mod = { dir, manifest };
    validateSkillFrontmatter(mod);
    validateHookScripts(mod);
    return mod;
  });

  // Without this, two module.yaml files sharing an id would silently
  // overwrite each other's compiled output — whichever compiled last
  // wins, with no error, no warning, just a skill that quietly wasn't
  // the one you thought it was. Fail loud instead.
  const byId = new Map();
  for (const mod of modules) {
    const existing = byId.get(mod.manifest.id);
    if (existing) {
      throw new Error(
        `duplicate module id "${mod.manifest.id}": ${existing.dir} and ${mod.dir} — ` +
        `ids must be unique across all of modules/, regardless of category folder`
      );
    }
    byId.set(mod.manifest.id, mod);
  }

  return modules;
}

function generatedNotice(sourcePath) {
  return `<!-- GENERATED by \`npm run compile\` from ${sourcePath} — edit the source, not this file. -->\n\n`;
}

function insertNotice(content, sourcePath) {
  const notice = generatedNotice(sourcePath);
  const fmMatch = content.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/);
  if (fmMatch) return fmMatch[1] + '\n' + notice + fmMatch[2];
  return notice + content;
}

// A module folder holds two kinds of file: supporting files a SKILL.md
// cites (references/, templates) and working files that must never
// leave the spine. Compiling copied both. Two real leaks came of it: a
// SKILL.md.draft awaiting owner review shipped into a client repo, and
// stack-miner's repos.yaml — gitignored precisely because it holds the
// client's 85 repo URLs and local paths — was copied to
// .claude/skills/stack-miner/repos.yaml, where .gitignore no longer
// covered it, one `git add -A` from being committed.
//
// Two rules, because neither alone catches both: what git is told to
// ignore never ships (repos.yaml), and a draft never ships
// (SKILL.md.draft was untracked, not ignored). The git half fails open
// — a temp dir in a test or a checkout without git answers "nothing
// ignored", and the draft rule still holds there.
// Memoised per (directory, name set) for the life of the process. A
// compile asks the same question about the same directories every time,
// and the test suite calls compileAll 52 times — without this that is
// ~1,600 git subprocesses for answers that cannot have changed. Keyed by
// absolute path, so a temp-dir fixture never collides with the real
// modules tree.
const ignoreCache = new Map();

function gitIgnoredNames(dir, names) {
  if (!names.length) return new Set();
  const key = `${path.resolve(dir)} ${names.join(' ')}`;
  if (ignoreCache.has(key)) return ignoreCache.get(key);
  const answer = gitIgnoredNamesUncached(dir, names);
  ignoreCache.set(key, answer);
  return answer;
}

function gitIgnoredNamesUncached(dir, names) {
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: dir,
      input: names.join('\n'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch {
    // exit 1 means "none of them are ignored"; anything else means git
    // could not answer. Both are "ignore nothing" for our purposes.
    return new Set();
  }
}

function isWorkingFile(name, ignored) {
  return name.endsWith('.draft') || ignored.has(name);
}

function compileClaudeSkill(mod, repoRoot) {
  const skillSrc = path.join(mod.dir, 'SKILL.md');
  if (!fs.existsSync(skillSrc)) return null;
  const content = fs.readFileSync(skillSrc, 'utf8');
  const outDir = path.join(repoRoot, '.claude', 'skills', mod.manifest.id);
  ensureDir(outDir);
  const outPath = path.join(outDir, 'SKILL.md');
  fs.writeFileSync(outPath, insertNotice(content, path.relative(repoRoot, skillSrc)), 'utf8');
  // A skill's supporting files — references/, scripts/, templates a
  // SKILL.md body cites by relative path — ship with it. Only SKILL.md
  // was copied before, so a client skill imported wholesale lost every
  // file it pointed at in the target repo (audit finding). module.yaml
  // and hooks/ are the manifest and the hook sources; they have their
  // own destinations.
  const extra = [];
  const entries = fs.readdirSync(mod.dir, { withFileTypes: true });
  const ignored = gitIgnoredNames(mod.dir, entries.map((e) => e.name));
  for (const entry of entries) {
    if (['module.yaml', 'SKILL.md', 'hooks'].includes(entry.name) || entry.name.startsWith('.')) continue;
    if (isWorkingFile(entry.name, ignored)) continue;
    const src = path.join(mod.dir, entry.name);
    const dest = path.join(outDir, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
      // Enumerate the SOURCE, not the destination. cpSync merges into an
      // existing destination rather than replacing it, so a file deleted
      // from the module stays behind in .claude/. Walking the destination
      // then re-registered that leftover in the manifest as if this
      // compile had just written it — which is exactly what the manifest
      // exists to prevent, and the stale-output pruning could never reach
      // it because it re-added itself every run. Walking the source
      // instead leaves the leftover out of the manifest, and the pruning
      // removes it on this same compile.
      // One `git check-ignore` per DIRECTORY, not per file. The first
      // version of this called it per entry, which spawned a subprocess
      // for every file in every references/ tree — with the imported
      // rules catalog that is hundreds per module, and compileAll runs
      // 52 times in the test suite. It took the suite from ~50s to
      // 7m37s, which I first misdiagnosed as a full disk.
      const walk = (srcDir, destDir) => {
        const entries = fs.readdirSync(srcDir, { withFileTypes: true });
        const ignored = gitIgnoredNames(srcDir, entries.map((e) => e.name));
        for (const e of entries) {
          if (isWorkingFile(e.name, ignored)) continue;
          if (e.isDirectory()) walk(path.join(srcDir, e.name), path.join(destDir, e.name));
          else extra.push(path.join(destDir, e.name));
        }
      };
      walk(src, dest);
    } else {
      fs.copyFileSync(src, dest);
      extra.push(dest);
    }
  }
  return [outPath, ...extra];
}

// Claude Code subagents (.claude/agents/) and Cursor subagents
// (.cursor/agents/) turned out to use the same shape — markdown with
// YAML frontmatter, project-scoped directory, name/description/model
// fields — so one generator produces both from the same manifest rather
// than needing a separate "custom modes" translation.
const MODEL_TIER_IDS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
};

// Both tools decide whether to auto-activate a rule/agent by matching
// the task against this description. Phase modules used to get
// `Agent for capability "pr-review" in phase "launch"` (agents) and
// `pr-review (launch)` (Cursor rules) — internal slot coordinates that
// describe nothing a model could match a user's request against, so
// those modules could never auto-delegate. The manifest description is
// the real text; the slot coordinates are appended as a suffix so the
// scoping information isn't lost.
function activationDescription(mod) {
  const base = mod.manifest.description || `See modules/${mod.manifest.id}/SKILL.md`;
  if (mod.manifest.phase && mod.manifest.capability) {
    return `${base} — phase: ${mod.manifest.phase}, capability: ${mod.manifest.capability}`;
  }
  // Both tools pick a subagent by matching a task against this text. For
  // a stack module that means the file patterns belong IN it: with all
  // eleven reviewers installed, "this client's Java conventions" and
  // "this client's Kotlin conventions" read almost identically, and the
  // globs are the only thing that actually separates them. Truncated at
  // eight so one module cannot flood the description it shares a
  // matching pool with — flutter declares 52.
  const globs = mod.manifest.applies_to;
  if (Array.isArray(globs) && globs.length) {
    const shown = globs.slice(0, 8).join(', ');
    const rest = globs.length > 8 ? `, and ${globs.length - 8} more patterns` : '';
    return `${base} Applies to: ${shown}${rest}.`;
  }
  return base;
}

// Descriptions are prose: they contain colons, quotes, dashes. Emitted
// bare they either break the YAML parse or truncate at the first colon.
// JSON.stringify produces a valid YAML double-quoted scalar.
function yamlString(value) {
  return JSON.stringify(String(value));
}

// The SKILL.md body with its frontmatter stripped — this IS the system
// prompt for a compiled subagent.
function skillBody(mod) {
  const skillPath = path.join(mod.dir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return null;
  const content = fs.readFileSync(skillPath, 'utf8');
  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return (fmMatch ? fmMatch[1] : content).trim();
}

function agentFrontmatter(mod, extra) {
  const lines = ['---', `name: ${mod.manifest.id}`, `description: ${yamlString(activationDescription(mod))}`];
  if (mod.manifest.model_tier) lines.push(`model: ${MODEL_TIER_IDS[mod.manifest.model_tier] || 'inherit'}`);
  for (const line of extra || []) lines.push(line);
  lines.push('---', '');
  return lines.join('\n');
}

function compileAgent(mod, repoRoot, toolDir, skillRefPath, extraFrontmatter) {
  if (mod.manifest.kind !== 'agent') return null;
  const outDir = path.join(repoRoot, toolDir, 'agents');
  ensureDir(outDir);
  const outPath = path.join(outDir, `${mod.manifest.id}.md`);
  // The body used to be the single line `Load skill: <path>`. Claude
  // Code can resolve that; Cursor has no skill-loading mechanism at
  // all — the agent file's body IS its system prompt, so a Cursor
  // subagent was being handed a one-line pointer it could not follow
  // and none of the capability content. Inline the skill body for both
  // tools and keep the pointer as a provenance comment.
  const body = skillBody(mod);
  const content =
    agentFrontmatter(mod, extraFrontmatter) +
    generatedNotice(path.relative(repoRoot, path.join(mod.dir, 'module.yaml'))) +
    (body
      ? `<!-- Capability source, inlined below: ${skillRefPath} -->\n\n${body}\n`
      : '(no bundled skill)\n');
  fs.writeFileSync(outPath, content, 'utf8');
  return outPath;
}

// Claude Code reads capability context from .claude/skills/; Cursor's
// nearest equivalent is .cursor/rules/ (compiled by compileCursorRule),
// not a mirrored .cursor/skills/ — so the two agent files point at
// different relative paths even though their own shape is identical.
function compileClaudeAgent(mod, repoRoot) {
  return compileAgent(mod, repoRoot, '.claude', `.claude/skills/${mod.manifest.id}/SKILL.md`);
}

function compileCursorAgent(mod, repoRoot) {
  if (!mod.manifest.tool_compat.includes('cursor')) return null;
  return compileAgent(mod, repoRoot, '.cursor', `.cursor/rules/${mod.manifest.id}.mdc`);
}

// Copies the script AND, when module.yaml declares a claude_event
// binding for it, returns a registration to merge into
// .claude/settings.json — copying the file alone does NOT make Claude
// Code call it. That was a real gap: hooks/ existed and got compiled
// to a file, but nothing ever wired it to actually fire.
function compileClaudeHooks(mod, repoRoot) {
  const hooksDir = path.join(mod.dir, 'hooks');
  if (!fs.existsSync(hooksDir)) return { written: [], registrations: [] };
  const outDir = path.join(repoRoot, '.claude', 'hooks');
  ensureDir(outDir);
  const written = [];
  const registrations = [];
  const declared = mod.manifest.hooks || [];
  for (const file of fs.readdirSync(hooksDir)) {
    const src = path.join(hooksDir, file);
    const outPath = path.join(outDir, `${mod.manifest.id}-${file}`);
    fs.copyFileSync(src, outPath);
    fs.chmodSync(outPath, 0o755);
    written.push(outPath);

    const binding = declared.find((h) => h.script === file);
    if (binding && binding.claude_event) {
      registrations.push({
        event: binding.claude_event,
        matcher: binding.claude_matcher || '',
        command: `\${CLAUDE_PROJECT_DIR}/.claude/hooks/${mod.manifest.id}-${file}`,
      });
    }
  }
  return { written, registrations };
}

// .claude/hooks/ is entirely generated (never hand-edited, per every
// other doc in this repo), so any settings.json hooks entry whose
// command lives under that path is safe to fully regenerate on every
// compile — anything else (a client's own hand-added entry pointing
// elsewhere) is left untouched. Idempotent: re-compiling doesn't
// duplicate entries, and removing a binding from module.yaml actually
// removes the stale registration instead of leaving it behind.
function mergeClaudeSettingsHooks(repoRoot, registrations) {
  const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
  settings.hooks = settings.hooks || {};

  const isGenerated = (entry) =>
    Array.isArray(entry.hooks) && entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes('/.claude/hooks/'));

  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event].filter((e) => !isGenerated(e));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  for (const reg of registrations) {
    settings.hooks[reg.event] = settings.hooks[reg.event] || [];
    settings.hooks[reg.event].push({ matcher: reg.matcher, hooks: [{ type: 'command', command: reg.command }] });
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (Object.keys(settings).length === 0) {
    // Nothing left to say — but a file that still carries last compile's
    // registrations must not stay behind (the old early return left
    // stale hooks live after every binding was removed).
    if (fs.existsSync(settingsPath)) fs.rmSync(settingsPath);
    return null;
  }

  ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return settingsPath;
}

function compileCursorRule(mod, repoRoot) {
  if (!mod.manifest.tool_compat.includes('cursor')) return null;
  const skillSrc = path.join(mod.dir, 'SKILL.md');
  if (!fs.existsSync(skillSrc)) return null;
  const content = fs.readFileSync(skillSrc, 'utf8');
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  let body = fmMatch ? fmMatch[2] : content;
  // A skill's supporting files ship next to its Claude copy
  // (.claude/skills/<id>/references/...) — the Cursor rule is a single
  // .mdc, so a relative `references/foo.md` in the body would dangle
  // there. Re-anchor those links to the copy that does exist in the repo
  // (both tools read the same checkout).
  body = body.replace(/(^|[\s(`'"])references\//gm, `$1.claude/skills/${mod.manifest.id}/references/`);
  const outDir = path.join(repoRoot, '.cursor', 'rules');
  ensureDir(outDir);
  const outPath = path.join(outDir, `${mod.manifest.id}.mdc`);
  const mdc = [
    '---',
    `description: ${yamlString(activationDescription(mod))}`,
    `alwaysApply: ${mod.manifest.always_apply === true}`,
    '---',
    '',
    generatedNotice(path.relative(repoRoot, skillSrc)),
    body,
  ].join('\n');
  fs.writeFileSync(outPath, mdc, 'utf8');
  return outPath;
}

// Cursor hooks: one hooks.json merged from every module's declared
// cursor_event bindings — Cursor's event set (beforeShellExecution,
// afterFileEdit, ...) doesn't share names with Claude Code's
// (PreToolUse+matcher), so like the Claude side, this reads the
// explicit binding from module.yaml rather than inferring an event
// from the filename. A script with no cursor_event declared (e.g.
// Claude-only) is skipped here, not guessed at.
//
// The script itself has to be COPIED under .cursor/hooks/ — this used
// to emit `command: ./hooks/<id>-<file>` and copy nothing anywhere
// under .cursor/, so every hook Cursor tried to run pointed at a
// nonexistent file. Cursor resolves a project hook command from the
// project root, so the command is `node .cursor/hooks/<id>-<file>`
// against the file this actually writes.
const CURSOR_HOOKS_REL = '.cursor/hooks/';
// The pre-fix generated form, so upgrading a target doesn't leave a
// dangling `./hooks/...` entry behind that we'd mistake for a
// hand-authored one and preserve forever.
const LEGACY_CURSOR_HOOK_COMMAND = /^(?:\.\/)?hooks\//;

function isGeneratedCursorHook(entry) {
  if (!entry || typeof entry.command !== 'string') return false;
  return entry.command.includes(CURSOR_HOOKS_REL) || LEGACY_CURSOR_HOOK_COMMAND.test(entry.command.trim());
}

// Same contract as mergeClaudeSettingsHooks: everything the compiler
// generated is regenerated wholesale, everything a client hand-wrote
// into their own .cursor/hooks.json (their own event entries, their own
// top-level keys) is left exactly as it was. Compiling into a client
// repo must never eat hooks the compiler didn't write.
function mergeCursorHooksJson(repoRoot, hookEntries) {
  const outPath = path.join(repoRoot, '.cursor', 'hooks.json');
  let doc = {};
  if (fs.existsSync(outPath)) {
    try {
      doc = JSON.parse(fs.readFileSync(outPath, 'utf8')) || {};
    } catch (err) {
      throw new Error(`${outPath} is not valid JSON (${err.message}) — fix or remove it before compiling`);
    }
  }
  const existing = doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {};
  const merged = {};
  for (const [event, entries] of Object.entries(existing)) {
    if (!Array.isArray(entries)) {
      merged[event] = entries; // not a shape we generate — leave it alone
      continue;
    }
    const kept = entries.filter((e) => !isGeneratedCursorHook(e));
    if (kept.length) merged[event] = kept;
  }
  for (const [event, entries] of Object.entries(hookEntries)) {
    merged[event] = (merged[event] || []).concat(entries);
  }

  if (Object.keys(merged).length === 0 && !fs.existsSync(outPath)) return null;
  doc.version = doc.version || 1;
  doc.hooks = merged;
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return outPath;
}

function compileCursorHooks(modules, repoRoot) {
  const hookEntries = {};
  const written = [];
  const outHooksDir = path.join(repoRoot, '.cursor', 'hooks');
  for (const mod of modules) {
    if (!mod.manifest.tool_compat.includes('cursor')) continue;
    const hooksDir = path.join(mod.dir, 'hooks');
    if (!fs.existsSync(hooksDir)) continue;
    const declared = mod.manifest.hooks || [];
    for (const file of fs.readdirSync(hooksDir).sort()) {
      const binding = declared.find((h) => h.script === file);
      if (!binding || !binding.cursor_event) continue;
      ensureDir(outHooksDir);
      const outPath = path.join(outHooksDir, `${mod.manifest.id}-${file}`);
      fs.copyFileSync(path.join(hooksDir, file), outPath);
      fs.chmodSync(outPath, 0o755);
      written.push(outPath);
      hookEntries[binding.cursor_event] = hookEntries[binding.cursor_event] || [];
      hookEntries[binding.cursor_event].push({
        command: `node ${CURSOR_HOOKS_REL}${mod.manifest.id}-${file}`,
        type: 'command',
        // failClosed used to be hardcoded true for every hook, which
        // silently inverted unit-test-writer's documented fail-OPEN
        // policy (a crash there would have blocked every shell command
        // in Cursor). Per-binding, defaulting to fail-open.
        failClosed: binding.cursor_fail_closed === true,
      });
    }
  }
  const hooksJsonPath = mergeCursorHooksJson(repoRoot, hookEntries);
  if (hooksJsonPath) written.push(hooksJsonPath);
  return written;
}

// registry.yaml is the whole point of the swap story ("point a slot at
// a different module id") — but until this function existed, nothing
// ever read it. Every phase module compiled unconditionally regardless
// of what registry.yaml said, which meant editing that file did
// nothing. This resolves which phase module is actually ACTIVE per
// (phase, capability) slot — registry.yaml sets the client-wide
// default, projectOverrides (from a project.yaml, keyed "phase.capability")
// take precedence for that one project — and throws loudly on the two
// ways this config can be broken: pointing at a module id that doesn't
// exist, or pointing at one whose own module.yaml declares a different
// phase/capability than the slot it's registered under.
//
// Shared modules (no phase/capability) are never touched by this —
// they're not gating anything, there's no slot for registry.yaml to
// resolve for them.
function resolvePhaseModules(modules, registry, projectOverrides) {
  const registryEntries = [];
  for (const [phase, caps] of Object.entries(registry || {})) {
    if (!caps) continue; // e.g. `define:` with only a comment underneath parses as null
    for (const [capability, moduleId] of Object.entries(caps)) {
      registryEntries.push({ phase, capability, moduleId });
    }
  }
  for (const [key, moduleId] of Object.entries(projectOverrides || {})) {
    const [phase, capability] = key.split('.');
    const existing = registryEntries.find((e) => e.phase === phase && e.capability === capability);
    if (existing) existing.moduleId = moduleId;
    else registryEntries.push({ phase, capability, moduleId });
  }

  const byId = new Map(modules.map((m) => [m.manifest.id, m]));
  const activeIds = new Set();
  for (const entry of registryEntries) {
    const mod = byId.get(entry.moduleId);
    if (!mod) {
      throw new Error(
        `registry.yaml (or a project override) points "${entry.phase}.${entry.capability}" at module ` +
        `"${entry.moduleId}", but no module with that id exists under modules/`
      );
    }
    if (mod.manifest.phase !== entry.phase || mod.manifest.capability !== entry.capability) {
      throw new Error(
        `registry.yaml registers "${entry.moduleId}" under "${entry.phase}.${entry.capability}", but its own ` +
        `module.yaml declares phase="${mod.manifest.phase}" capability="${mod.manifest.capability}" — these must match`
      );
    }
    activeIds.add(entry.moduleId);
  }

  const phaseModuleIds = modules.filter((m) => m.manifest.phase && m.manifest.capability).map((m) => m.manifest.id);
  const dormant = phaseModuleIds.filter((id) => !activeIds.has(id));

  return { activeIds, dormant };
}

// Retiring a module, or pointing a registry slot at a different one,
// used to leave the old module's compiled output sitting live in every
// already-compiled target forever: the skill still loads, the agent is
// still delegatable, the hook still fires, and `spine doctor` reports
// "in sync" because a compile only ever ADDS files. Removing a module
// has to actually remove it downstream.
//
// Two mechanisms, because the two kinds of output differ:
//   - a manifest of what the last compile wrote (.claude/.spine-manifest.json).
//     This is the only way to recognise a stale COPIED hook script,
//     which is byte-identical to its source and carries no marker.
//   - a sweep of the generated-output directories for files carrying
//     the "GENERATED" notice. Covers targets compiled before the
//     manifest existed, and can never touch a hand-authored file,
//     since only the compiler writes that notice.
const MANIFEST_REL = ['.claude', '.spine-manifest.json'];
const GENERATED_MARKER = 'GENERATED by `npm run compile`';

// Files the compiler MERGES into rather than owns — a client's own
// content lives in these, so they're never pruned even if a compile
// stops writing them.
function isMergeTarget(repoRoot, absPath) {
  return [
    path.join(repoRoot, '.claude', 'settings.json'),
    path.join(repoRoot, '.cursor', 'hooks.json'),
  ].some((p) => path.resolve(p) === path.resolve(absPath));
}

function carriesGeneratedNotice(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').includes(GENERATED_MARKER);
  } catch {
    return false;
  }
}

function readPreviousManifest(repoRoot) {
  const manifestPath = path.join(repoRoot, ...MANIFEST_REL);
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Array.isArray(doc.generated) ? doc.generated : [];
  } catch {
    return []; // unreadable manifest just means we fall back to the notice sweep
  }
}

function pruneStaleOutput(repoRoot, writtenPaths) {
  const root = path.resolve(repoRoot);
  const keep = new Set(writtenPaths.map((p) => path.resolve(p)));
  const removed = [];

  const manifestAbs = path.resolve(root, ...MANIFEST_REL);
  const remove = (abs, recursive = false) => {
    if (keep.has(path.resolve(abs))) return;
    if (path.resolve(abs) === manifestAbs) return; // rewritten every compile, never "stale"
    if (isMergeTarget(root, abs)) return;
    if (!path.resolve(abs).startsWith(root + path.sep)) return; // never step outside the target
    if (!fs.existsSync(abs)) return;
    fs.rmSync(abs, { recursive, force: true });
    removed.push(abs);
  };

  for (const rel of readPreviousManifest(repoRoot)) {
    remove(path.resolve(root, rel));
  }

  const sweeps = [
    { dir: path.join(root, '.claude', 'agents'), matches: (n) => n.endsWith('.md') },
    { dir: path.join(root, '.cursor', 'agents'), matches: (n) => n.endsWith('.md') },
    { dir: path.join(root, '.cursor', 'rules'), matches: (n) => n.endsWith('.mdc') },
  ];
  for (const { dir, matches } of sweeps) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (!matches(name) || !fs.statSync(abs).isFile()) continue;
      if (keep.has(path.resolve(abs)) || !carriesGeneratedNotice(abs)) continue;
      remove(abs);
    }
  }

  const skillsRoot = path.join(root, '.claude', 'skills');
  if (fs.existsSync(skillsRoot)) {
    for (const name of fs.readdirSync(skillsRoot)) {
      const skillDir = path.join(skillsRoot, name);
      if (!fs.statSync(skillDir).isDirectory()) continue;
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (keep.has(path.resolve(skillFile))) continue;
      if (!fs.existsSync(skillFile) || !carriesGeneratedNotice(skillFile)) continue;
      remove(skillDir, true);
    }
    // The manifest pass removes the SKILL.md itself; sweep up the empty
    // directory it leaves behind so a retired skill doesn't linger as a
    // ghost folder.
    for (const name of fs.readdirSync(skillsRoot)) {
      const skillDir = path.join(skillsRoot, name);
      if (fs.statSync(skillDir).isDirectory() && fs.readdirSync(skillDir).length === 0) {
        fs.rmdirSync(skillDir);
      }
    }
  }

  return removed;
}

function writeManifest(repoRoot, writtenPaths) {
  const manifestPath = path.join(repoRoot, ...MANIFEST_REL);
  const generated = [...writtenPaths, manifestPath]
    .map((p) => path.relative(repoRoot, p).split(path.sep).join('/'))
    .sort();
  ensureDir(path.dirname(manifestPath));
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, generated }, null, 2) + '\n', 'utf8');
  return manifestPath;
}

// meta/ modules (stack-miner, module-auditor, ...) are studio-only
// tooling — they clone repos, read PR history, edit modules/. Shipping
// them into a client's own application repo isn't just clutter, it's
// unnecessary tool surface a security-conscious client has every right
// to ask about. excludeMeta defaults false so compiling into the spine
// fork's own root (where the studio actually runs these) still works;
// the CLI sets it true whenever --out targets somewhere else.
//
// registry/projectOverrides default to null — pass nothing and every
// phase module compiles unconditionally, same as before this existed
// (existing callers/tests that don't care about slot resolution are
// unaffected). The CLI always passes registry.yaml for real compiles.
//
// onlyStacks (array of stacks/ module ids, or null): scopes which
// stack modules ship — a Java-only repo shouldn't get react-conventions
// compiled into it too. Only affects modules under a stacks/ category
// folder; disciplines/phases/meta are never filtered by this. null
// (the default, and what plain `compile` uses) means every stack
// module ships everywhere, same as before this existed —
// distribute-all is what actually passes this, scoped from
// repos.yaml's own stack->repo mapping.
function compileAll(modulesDir, repoRoot, { excludeMeta = false, registry = null, projectOverrides = null, onlyStacks = null } = {}) {
  let modules = scanModules(modulesDir);
  if (excludeMeta) {
    modules = modules.filter((m) => !m.dir.split(path.sep).includes('meta'));
  }
  if (onlyStacks) {
    const onlyStacksSet = new Set(onlyStacks);
    modules = modules.filter((m) => {
      const isStackModule = m.dir.split(path.sep).includes('stacks');
      return !isStackModule || onlyStacksSet.has(m.manifest.id);
    });
  }

  let dormant = [];
  if (registry) {
    const resolved = resolvePhaseModules(modules, registry, projectOverrides);
    dormant = resolved.dormant;
    modules = modules.filter((m) => {
      const isPhaseModule = !!(m.manifest.phase && m.manifest.capability);
      return !isPhaseModule || resolved.activeIds.has(m.manifest.id);
    });
  }

  const written = [];
  const claudeHookRegistrations = [];
  for (const mod of modules) {
    if (mod.manifest.tool_compat.includes('claude')) {
      const skill = compileClaudeSkill(mod, repoRoot);
      if (skill) written.push(...skill);
      const agent = compileClaudeAgent(mod, repoRoot);
      if (agent) written.push(agent);
      const { written: hookFiles, registrations } = compileClaudeHooks(mod, repoRoot);
      written.push(...hookFiles);
      claudeHookRegistrations.push(...registrations);
    }
    if (mod.manifest.tool_compat.includes('cursor')) {
      const rule = compileCursorRule(mod, repoRoot);
      if (rule) written.push(rule);
      const cursorAgent = compileCursorAgent(mod, repoRoot);
      if (cursorAgent) written.push(cursorAgent);
    }
  }
  written.push(...compileCursorHooks(modules, repoRoot));

  // Always run, even with zero registrations — a module.yaml that
  // dropped its hooks binding needs its stale settings.json entry
  // removed, not just no new one added.
  const settingsPath = mergeClaudeSettingsHooks(repoRoot, claudeHookRegistrations);
  if (settingsPath) written.push(settingsPath);

  // Retired/swapped modules leave output behind otherwise — see
  // pruneStaleOutput. Runs after everything is written so the keep-set
  // is complete.
  const removed = pruneStaleOutput(repoRoot, written);
  written.push(writeManifest(repoRoot, written));

  return { modules: modules.map((m) => m.manifest.id), written, dormant, removed };
}

module.exports = { scanModules, validateManifest, compileAll, resolvePhaseModules };
