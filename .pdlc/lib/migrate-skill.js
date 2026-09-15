'use strict';

// Mechanical migration of an existing, already-written client skill/
// agent (a .claude/skills/*/SKILL.md, .claude/agents/*.md, or
// .cursor/rules/*.mdc from BEFORE this spine existed) into a module.
// This is deliberately dumb — copy content, scaffold a manifest — the
// judgment call (which category, what id, whether it should be
// phase-gated) is the human's, this just removes the boilerplate.
// Nothing here needs an LLM: the content already exists, unlike
// stack-miner which drafts convention docs from scratch.

const fs = require('fs');
const path = require('path');
// js-yaml comes through util.js so the distributed .pdlc/ bundle
// resolves the vendored copy too (a bare require('js-yaml') fails there).
const { parseFrontmatter, ensureDir, yaml } = require('./util');

const VALID_CATEGORIES = ['phases', 'stacks', 'disciplines', 'meta'];
const VALID_TIERS = ['haiku', 'sonnet', 'opus'];

const GENERIC_DESCRIPTION_MARKER = 'describe this properly before onboarding';

// A description is free prose — "Use when: ..." , "#tag", a leading
// quote, a colon anywhere — and emitting it bare into YAML either
// breaks the parse or silently truncates it at the colon. js-yaml
// quotes only what needs quoting, so a plain description still reads
// naturally in the generated manifest.
function yamlScalar(value) {
  return yaml.dump(String(value), { lineWidth: -1 }).trimEnd();
}

// A source under .claude/agents/ (or one whose frontmatter carries
// tools:/model:) is a SUBAGENT, not a skill. Migrating it as
// kind: skill produced a module that compiles to a rule/skill only —
// the agent never appears in .claude/agents or .cursor/agents, so the
// thing the client was actually using stops existing.
function detectKind(sourcePath, data) {
  const inAgentsDir = path
    .dirname(path.resolve(sourcePath))
    .split(path.sep)
    .includes('agents');
  if (inAgentsDir) return 'agent';
  if (data && (data.tools !== undefined || data.model !== undefined)) return 'agent';
  return 'skill';
}

// Claude Code writes a full model id (claude-sonnet-5) or a bare tier;
// module.yaml speaks tiers. Only map what's unambiguous — anything else
// is reported as dropped rather than guessed at.
function detectModelTier(model) {
  if (typeof model !== 'string') return null;
  const found = VALID_TIERS.find((tier) => model.toLowerCase().includes(tier));
  return found || null;
}

function migrateSkill({ sourcePath, modulesDir, category, id, kind, toolCompat, description, owner, alwaysApply }) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`source file not found: ${sourcePath}`);
  }
  if (fs.statSync(sourcePath).isDirectory()) {
    const inner = path.join(sourcePath, 'SKILL.md');
    throw new Error(
      `--source ${sourcePath} is a directory, not a file` +
      (fs.existsSync(inner)
        ? ` — point it at the file inside it: --source ${inner}`
        : ` — point --source at the SKILL.md / agent .md / .mdc file itself, not the folder holding it`)
    );
  }
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`category must be one of ${VALID_CATEGORIES.join(', ')}, got "${category}"`);
  }
  if (!id) {
    throw new Error('an --id is required — pick one, this is not inferred from the source filename automatically');
  }

  const targetDir = path.join(modulesDir, category, id);
  if (fs.existsSync(targetDir)) {
    throw new Error(`${targetDir} already exists — pick a different --id or remove it first`);
  }

  const parsed = parseFrontmatter(sourcePath);
  const data = (parsed && parsed.data) || {};
  const sourceHadDescription = !!(description || data.description);
  const resolvedDescription =
    description || data.description || `Migrated from ${path.relative(process.cwd(), sourcePath)} — ${GENERIC_DESCRIPTION_MARKER}.`;
  const body = parsed ? parsed.body : fs.readFileSync(sourcePath, 'utf8');

  const detectedKind = detectKind(sourcePath, data);
  const resolvedKind = kind || detectedKind;
  const modelTier = resolvedKind === 'agent' ? detectModelTier(data.model) : null;

  ensureDir(targetDir);

  const manifestLines = [
    `id: ${id}`,
    `kind: ${resolvedKind}`,
    `description: ${yamlScalar(resolvedDescription)}`,
    `tool_compat: [${(toolCompat || ['claude', 'cursor']).join(', ')}]`,
  ];
  if (modelTier) manifestLines.push(`model_tier: ${modelTier}`);
  manifestLines.push(`owner: "${owner || '#TODO-set-owner'}"`);
  if (alwaysApply) manifestLines.push('always_apply: true');
  manifestLines.push('');
  fs.writeFileSync(path.join(targetDir, 'module.yaml'), manifestLines.join('\n'), 'utf8');

  const skillContent = [
    '---',
    `name: ${id}`,
    `description: ${yamlScalar(resolvedDescription)}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(targetDir, 'SKILL.md'), skillContent, 'utf8');

  const warnings = [];

  if (!kind && detectedKind === 'agent') {
    warnings.push(
      `${sourcePath} looks like a SUBAGENT (it lives under an agents/ directory, or declares tools:/model: in its ` +
      `frontmatter), so this module was written as kind: agent — a subagent in both tools, not just a skill. ` +
      `Pass --kind skill if that's wrong.`
    );
  }
  if (data.model !== undefined) {
    warnings.push(
      modelTier
        ? `source declared model: ${data.model} — mapped to model_tier: ${modelTier}. Check that's the tier you want.`
        : `source declared model: ${data.model}, which doesn't map to a module.yaml model_tier (haiku/sonnet/opus) — ` +
          `it was DROPPED. Set model_tier by hand if the cost/capability choice mattered.`
    );
  }
  if (data.tools !== undefined) {
    warnings.push(
      `source declared tools: ${JSON.stringify(data.tools)} — module.yaml has no tool-allowlist field, so this was ` +
      `DROPPED and the migrated agent inherits the full tool surface. If that allowlist was a deliberate restriction ` +
      `(a security-conscious client's read-only reviewer, say), say so in the SKILL.md body, or the restriction is gone.`
    );
  }
  if (data.globs !== undefined) {
    warnings.push(
      `source declared Cursor globs: ${JSON.stringify(data.globs)} (auto-attach on matching file paths). There is no ` +
      `equivalent in module.yaml — a module activates on its description, or always via always_apply — so this was ` +
      `DROPPED. Fold the "applies to these files" condition into the description, or re-run with --always-apply true.`
    );
  }
  if (!sourceHadDescription) {
    warnings.push(
      `no description found in ${sourcePath} — this module got a generic placeholder, which means it will ` +
      `almost certainly NOT auto-activate (Claude/Cursor match relevance against the description). Write a ` +
      `specific one ("Use whenever...") before treating this as onboarded, or auto-activation is not real.`
    );
  }
  if (!alwaysApply && parsed && parsed.data && parsed.data.alwaysApply === true) {
    warnings.push(
      `source had alwaysApply: true (always active regardless of relevance judgment) — that was NOT carried ` +
      `over. If this content is policy-critical (compliance, security) rather than relevance-dependent, ` +
      `re-run with --always-apply true, or it now silently depends on the model deciding it's relevant.`
    );
  }

  return { targetDir, manifestPath: path.join(targetDir, 'module.yaml'), skillPath: path.join(targetDir, 'SKILL.md'), warnings };
}

module.exports = { migrateSkill, VALID_CATEGORIES, GENERIC_DESCRIPTION_MARKER };
