'use strict';

// spec-kitti (the client's own Spec Kit fork) is OPTIONAL. It runs
// `/spec-kitti.sync --epic-key` against a Jira epic and writes
// specs/<###-name>/spec.md with the epic key in its header and each
// story as `### Story N: [KEY] Title`; `/spec-kitti.tasks` writes
// tasks.md where every story task carries a `- jira: KEY` line (the
// same line its own sync-status script parses to push completion back
// to Jira). So the link between a Jira ticket and its Spec Kit feature
// directory already exists on disk — nothing has to be added on the
// client's side. This module finds it deterministically, so the writer
// skills can extract from spec-kitti's artifacts when they exist and fall
// back to drafting from Jira when they don't. Never a hard dependency:
// `found: false` is a normal answer, not an error.

const fs = require('fs');
const path = require('path');

const STORY_RE = /^###\s+Story\s+\d+\s*:\s*\[([A-Z][A-Z0-9]*-\d+)\]\s*(.*?)\s*$/;
const EPIC_RE = /\*\*Jira Epic:\*\*\s*\[([A-Z][A-Z0-9]*-\d+)\]\(([^)]*)\)/;
const TASK_RE = /^- \[( |x|X)\]\s+(T\d+)\b(\s+\[P\])?(\s+\[(US\d+)\])?\s+(.*)$/;
const JIRA_META_RE = /^\s*-\s*jira:\s*([A-Z][A-Z0-9]*-\d+)\s*$/i;
const PHASE_RE = /^##\s+(.*)$/;

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// Every candidate spec file: specs/*/spec.md (the fork's feature layout)
// plus .spec-kitti/spec_*.md (an older sync layout its docs still show).
function candidateSpecs(repoRoot) {
  const out = [];
  const specsDir = path.join(repoRoot, 'specs');
  if (fs.existsSync(specsDir)) {
    for (const entry of fs.readdirSync(specsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const specPath = path.join(specsDir, entry.name, 'spec.md');
      if (fs.existsSync(specPath)) out.push({ featureDir: path.join(specsDir, entry.name), specPath });
    }
  }
  const legacyDir = path.join(repoRoot, '.spec-kitti');
  if (fs.existsSync(legacyDir)) {
    for (const name of fs.readdirSync(legacyDir)) {
      if (/^spec_.*\.md$/.test(name)) out.push({ featureDir: legacyDir, specPath: path.join(legacyDir, name) });
    }
  }
  return out.sort((a, b) => a.specPath.localeCompare(b.specPath));
}

function parseSpec(content) {
  const epicMatch = content.match(EPIC_RE);
  const epic = epicMatch ? { key: epicMatch[1], url: epicMatch[2] || null } : null;
  const title = (content.match(/^#\s+Feature Specification:\s*(.*)$/m) || [])[1] || (content.match(/^#\s+(.*)$/m) || [])[1] || null;
  const lines = content.split('\n');
  const stories = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(STORY_RE);
    if (m) {
      if (current) stories.push(current);
      current = { key: m[1], title: m[2], lines: [line] };
      continue;
    }
    if (current) {
      if (/^##\s/.test(line) || /^###\s+Story\s+/.test(line)) {
        stories.push(current);
        current = null;
      } else {
        current.lines.push(line);
      }
    }
  }
  if (current) stories.push(current);
  return {
    title,
    epic,
    stories: stories.map((s) => ({ key: s.key, title: s.title, block: s.lines.join('\n').trim() })),
  };
}

function parseTasks(content) {
  const tasks = [];
  let phase = null;
  let last = null;
  for (const line of content.split('\n')) {
    const ph = line.match(PHASE_RE);
    if (ph) {
      phase = ph[1].trim();
      last = null;
      continue;
    }
    const t = line.match(TASK_RE);
    if (t) {
      last = { id: t[2], done: t[1].toLowerCase() === 'x', parallel: !!t[3], story: t[5] || null, description: t[6].trim(), jira: null, phase };
      tasks.push(last);
      continue;
    }
    const j = line.match(JIRA_META_RE);
    if (j && last) last.jira = j[1].toUpperCase();
  }
  return tasks;
}

function planSummary(content) {
  if (!content) return null;
  const m = content.match(/^##\s+Summary\s*\n([\s\S]*?)(?=^##\s|\s*$)/m);
  return m ? m[1].trim() : null;
}

// Locate the spec-kitti feature a ticket belongs to.
//   ticketKey: the Jira key being worked (a story, or the epic itself)
//   epicKey:   optional — the ticket's parent epic, when the caller knows
//              it (from Jira MCP); lets a sub-task or a story the spec
//              didn't list still resolve to its feature directory.
function locateFeature({ repoRoot, ticketKey, epicKey = null }) {
  const key = String(ticketKey || '').toUpperCase().trim();
  if (!key) throw new Error('ticketKey is required');
  const parent = epicKey ? String(epicKey).toUpperCase().trim() : null;
  const root = path.resolve(repoRoot || '.');
  const scanned = [];

  for (const cand of candidateSpecs(root)) {
    scanned.push(path.relative(root, cand.specPath));
    const spec = parseSpec(fs.readFileSync(cand.specPath, 'utf8'));
    const story = spec.stories.find((s) => s.key === key) || null;
    const isEpic = spec.epic && spec.epic.key === key;
    const viaParent = !story && !isEpic && parent && spec.epic && spec.epic.key === parent;
    if (!story && !isEpic && !viaParent) continue;

    const tasksPath = path.join(cand.featureDir, 'tasks.md');
    const planPath = path.join(cand.featureDir, 'plan.md');
    const allTasks = parseTasks(readIfExists(tasksPath) || '');
    const storyKeys = story ? [key] : spec.stories.map((s) => s.key);
    const ticketTasks = story ? allTasks.filter((t) => t.jira === key) : allTasks.filter((t) => t.jira && storyKeys.includes(t.jira));
    const sharedTasks = allTasks.filter((t) => !t.jira);

    return {
      found: true,
      matchedBy: story ? 'story' : isEpic ? 'epic' : 'parent-epic',
      ticket: key,
      featureDir: cand.featureDir,
      featureName: path.basename(cand.featureDir),
      files: {
        spec: cand.specPath,
        plan: fs.existsSync(planPath) ? planPath : null,
        tasks: fs.existsSync(tasksPath) ? tasksPath : null,
        contracts: fs.existsSync(path.join(cand.featureDir, 'contracts')) ? path.join(cand.featureDir, 'contracts') : null,
        dataModel: fs.existsSync(path.join(cand.featureDir, 'data-model.md')) ? path.join(cand.featureDir, 'data-model.md') : null,
      },
      title: spec.title,
      epic: spec.epic,
      story,
      stories: spec.stories.map((s) => ({ key: s.key, title: s.title })),
      tasks: ticketTasks,
      sharedTasks,
      progress: { total: ticketTasks.length, done: ticketTasks.filter((t) => t.done).length },
      planSummary: planSummary(readIfExists(planPath)),
    };
  }

  return {
    found: false,
    ticket: key,
    scanned,
    reason: scanned.length
      ? `no spec-kitti feature under ${root} references ${key}${parent ? ` or its epic ${parent}` : ''} (looked at ${scanned.length} spec file(s)) — draft from Jira as usual.`
      : `no specs/*/spec.md under ${root} — this repo has no spec-kitti features; draft from Jira as usual.`,
  };
}

function formatReport(result) {
  if (!result.found) return `spec-kitti: ${result.reason}`;
  const lines = [];
  lines.push(`spec-kitti: ${result.ticket} belongs to feature ${result.featureName} (matched by ${result.matchedBy})`);
  if (result.title) lines.push(`  feature: ${result.title}`);
  if (result.epic) lines.push(`  epic: ${result.epic.key}${result.epic.url ? ` ${result.epic.url}` : ''}`);
  lines.push(`  spec:  ${result.files.spec}`);
  lines.push(`  plan:  ${result.files.plan || '(none yet)'}`);
  lines.push(`  tasks: ${result.files.tasks || '(none yet)'}`);
  if (result.story) lines.push(`  story: [${result.story.key}] ${result.story.title}`);
  else lines.push(`  stories: ${result.stories.map((s) => `${s.key}`).join(', ') || '(none)'}`);
  if (result.tasks.length) {
    lines.push(`  tasks for this ticket: ${result.progress.done}/${result.progress.total} done`);
    for (const t of result.tasks) lines.push(`    [${t.done ? 'x' : ' '}] ${t.id}${t.story ? ` [${t.story}]` : ''} ${t.description}`);
  }
  if (result.sharedTasks.length) lines.push(`  shared setup/foundational/polish tasks: ${result.sharedTasks.map((t) => t.id).join(', ')}`);
  if (result.planSummary) lines.push(`  plan summary: ${result.planSummary.split('\n')[0]}`);
  return lines.join('\n');
}

module.exports = { locateFeature, parseSpec, parseTasks, candidateSpecs, formatReport };
