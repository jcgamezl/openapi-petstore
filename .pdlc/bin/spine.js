#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const gateEngine = require('../lib/gate-engine');
const router = require('../lib/router');
const compiler = require('../lib/compiler');
const { findStackGaps } = require('../lib/stack-gaps');
const { stacksForFiles } = require('../lib/stack-scope');
const { formatGateReport } = require('../lib/gate-report');
const { buildPlugin, PLUGIN_NAME, MARKETPLACE_NAME } = require('../lib/plugin-build');
const { findOverlappingPairs } = require('../lib/overlap-check');
const { migrateSkill } = require('../lib/migrate-skill');
const { distributeRuntime } = require('../lib/distribute-runtime');
const { distributeCiTemplate } = require('../lib/distribute-ci');
const { startTicket } = require('../lib/start-ticket');
const { finishTicket } = require('../lib/finish-ticket');
const { distributeAll } = require('../lib/distribute-all');
const { checkDrift } = require('../lib/doctor');
const { locateFeature, formatReport } = require('../lib/spec-kitti');
const { importRules } = require('../lib/import-rules');
const { readYaml } = require('../lib/util');

const REPO_ROOT = path.join(__dirname, '..', '..');

// Bare boolean flags (--force, --delete-branch, --all) work, and so
// does an explicitly empty value (`--labels ""` used to crash: the
// empty string is falsy, so the parser treated it as a bare flag and
// handed `true` to .split()).
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      const val = next !== undefined && !next.startsWith('--') ? argv[++i] : true;
      flags[key] = val;
    }
  }
  return flags;
}

function boolFlag(flags, name) {
  const v = flags[name];
  return v === true || v === 'true' || v === 'yes' || v === '1';
}

function listFlag(flags, name) {
  const v = flags[name];
  if (v === undefined || v === true || v === '') return [];
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}

function printGateReport(report) {
  for (const line of formatGateReport(report)) console.log(line);
}

// --project given: it must be a real ticket directory (no silent
// default state — see gate-engine.loadState). Omitted: the single
// in-flight ticket under this checkout's pdlc/, wherever the cwd is.
function resolveProjectDir(flags) {
  if (flags.project && flags.project !== true) {
    const dir = path.resolve(flags.project);
    if (!gateEngine.hasState(dir)) {
      throw new Error(`no phase-state.json in ${dir} — not a ticket directory. Ticket directories are ${gateEngine.TICKETS_DIR}/<TICKET-ID>/ inside the ticket's worktree; run start-ticket first if this ticket hasn't been started.`);
    }
    return dir;
  }
  const found = gateEngine.discoverProjectDir(process.cwd());
  if (!found.projectDir) throw new Error(found.reason);
  return found.projectDir;
}

function cmdStatus(flags) {
  const graph = gateEngine.loadGraph();
  let projectDir;
  try {
    projectDir = resolveProjectDir(flags);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  const state = gateEngine.loadState(projectDir, graph);
  const report = gateEngine.checkGate(graph, state, projectDir);
  printGateReport(report);
}

// Distinct from `status` on purpose: status is informational (always
// exits 0 on a readable ticket — used by phase-advancer to read state,
// not to pass/fail anything). gate-check is the one meant for CI — a
// required check that actually has to be able to fail, or it's a
// rubber stamp regardless of gate state.
//
// Without --project it checks EVERY ticket directory under the checkout
// (pdlc/*/): in-flight ones must have a clear gate, complete ones pass,
// and a branch with no ticket state at all passes with a notice — the
// shipped CI workflow runs on every PR and on main, and a main branch
// or a non-PDLC PR being permanently red would just get the required
// check turned off (audit finding).
function cmdGateCheck(flags) {
  const graph = gateEngine.loadGraph();
  if (flags.project && flags.project !== true) {
    let projectDir;
    try {
      projectDir = resolveProjectDir(flags);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    const state = gateEngine.loadState(projectDir, graph);
    const report = gateEngine.checkGate(graph, state, projectDir);
    printGateReport(report);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();
  if (gateEngine.hasState(cwd)) {
    const state = gateEngine.loadState(cwd, graph);
    const report = gateEngine.checkGate(graph, state, cwd);
    printGateReport(report);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const root = gateEngine.gitToplevel(cwd) || cwd;
  const tickets = gateEngine.discoverTicketDirs(root);
  if (tickets.length === 0) {
    console.log(`no PDLC ticket state under ${root}/${gateEngine.TICKETS_DIR}/ — nothing to gate on this branch (pass).`);
    return;
  }
  let failed = 0;
  let complete = 0;
  for (const t of tickets) {
    if (!t.state) {
      console.log(`ticket: ${t.ticketId}  [BLOCKED] ${t.error}`);
      failed += 1;
      continue;
    }
    const report = gateEngine.checkGate(graph, t.state, t.dir);
    // A finished ticket's pdlc/<ID>/ never goes away — it IS the approval
    // record, and a repo a year into the pilot carries hundreds. Printing
    // a line for each buried the one in-flight ticket this check exists to
    // report on, and a check nobody reads stops doing its job. checkGate
    // returns immediately on a completed state without verifying anything,
    // so counting them here loses no check — only the noise.
    if (report.done) {
      complete += 1;
      continue;
    }
    printGateReport(report);
    if (!report.ok) failed += 1;
  }
  if (complete) {
    console.log(`${complete} completed ticket(s) — nothing to gate. Pass --project ${gateEngine.TICKETS_DIR}/<TICKET-ID> to inspect one.`);
  }
  if (failed) {
    console.log(`\n${failed} of ${tickets.length} ticket(s) not clear.`);
    process.exitCode = 1;
  }
}

function cmdAdvance(flags) {
  const graph = gateEngine.loadGraph();
  let projectDir;
  try {
    projectDir = resolveProjectDir(flags);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  const state = gateEngine.loadState(projectDir, graph);
  // Two people advancing the same ticket from stale checkouts produce a
  // merge conflict in phase-state.json. If this branch tracks an
  // upstream and is behind it, someone else may already have advanced —
  // pull first. Fails open when there is no upstream or git can't tell.
  const behind = gateEngine.commitsBehindUpstream(projectDir);
  if (behind > 0) {
    console.error(`cannot advance: this branch is ${behind} commit(s) behind its upstream — another developer may have advanced this ticket already. Run git pull, then re-run status/advance.`);
    process.exitCode = 1;
    return;
  }
  try {
    gateEngine.advance(graph, state, projectDir);
    console.log(`advanced. now at: ${gateEngine.currentPhaseId(state) || '(track complete)'}`);
  } catch (err) {
    console.error(`cannot advance: ${err.message}`);
    process.exitCode = 1;
  }
}

// Manual init of a project directory — start-ticket is the normal
// path (it also creates the worktree/branch); this exists for repos
// that don't use worktrees and for tests. --ticket records the ticket
// id so the gate can check artifacts belong to it.
function cmdInit(flags) {
  const projectDir = path.resolve(flags.project && flags.project !== true ? flags.project : '.');
  const graph = gateEngine.loadGraph();
  if (fs.existsSync(path.join(projectDir, 'phase-state.json'))) {
    console.error(`${projectDir} already has phase-state.json — refusing to overwrite. Delete it first if you really want to re-init.`);
    process.exitCode = 1;
    return;
  }
  let track = flags.track;
  if (!track && flags.context) {
    track = router.route(graph, JSON.parse(flags.context)).track;
  }
  track = track || graph.routing.default;
  fs.mkdirSync(projectDir, { recursive: true });
  const state = gateEngine.defaultState(graph, track, null, { ticketId: flags.ticket && flags.ticket !== true ? flags.ticket : null });
  gateEngine.saveState(projectDir, state);
  console.log(`initialized ${projectDir} on track "${track}", starting at phase "${gateEngine.currentPhaseId(state)}"`);
}

function cmdRoute(flags) {
  const graph = gateEngine.loadGraph();
  let context;
  if (flags['context-file']) {
    context = JSON.parse(fs.readFileSync(flags['context-file'], 'utf8'));
  } else if (flags.context) {
    context = JSON.parse(flags.context);
  } else {
    console.error('usage: spine route --context \'{"issue_type":"Bug","priority":"P1","labels":[]}\'');
    process.exitCode = 1;
    return;
  }
  const result = router.route(graph, context);
  console.log(JSON.stringify(result, null, 2));
}

function cmdCompile(flags) {
  const modulesDir = path.resolve(flags.modules || path.join(REPO_ROOT, 'modules'));
  const outRoot = path.resolve(flags.out || REPO_ROOT);
  const distributingExternally = outRoot !== REPO_ROOT;

  const registryPath = path.resolve(flags.registry || path.join(REPO_ROOT, 'spine', 'registry.yaml'));
  const registry = fs.existsSync(registryPath) ? readYaml(registryPath) : null;

  const projectYamlPath = path.resolve(flags['project-config'] || path.join(outRoot, 'project.yaml'));
  let projectOverrides = null;
  if (fs.existsSync(projectYamlPath)) {
    const projectConfig = readYaml(projectYamlPath);
    projectOverrides = (projectConfig && projectConfig.overrides) || null;
  }

  // --only-stacks java-conventions: don't ship angular+react conventions
  // into a Java repo. distribute-all scopes by repos.yaml automatically;
  // this is the single-target equivalent.
  const onlyStacks = listFlag(flags, 'only-stacks');
  const result = compiler.compileAll(modulesDir, outRoot, {
    excludeMeta: distributingExternally && !boolFlag(flags, 'include-meta'),
    registry,
    projectOverrides,
    onlyStacks: onlyStacks.length ? onlyStacks : null,
  });
  console.log(`compiled ${result.modules.length} module(s): ${result.modules.join(', ') || '(none)'}`);
  for (const f of result.written) console.log(`  wrote ${path.relative(outRoot, f)}`);
  // Generated output for a module that no longer compiles (retired,
  // swapped out in registry.yaml) is pruned — say so, or a client
  // wonders where their rule went.
  for (const f of result.removed || []) console.log(`  removed stale ${path.relative(outRoot, f)}`);
  if (distributingExternally && !boolFlag(flags, 'include-meta')) {
    console.log('(excluded meta/ studio tooling from this external target — pass --include-meta to override)');
  }
  if (result.dormant.length) {
    console.log(`(${result.dormant.length} phase module(s) exist but aren't registered for any slot, not compiled: ${result.dormant.join(', ')})`);
  }
  if (projectOverrides) {
    console.log(`(applied project-level overrides from ${path.relative(REPO_ROOT, projectYamlPath)}: ${Object.entries(projectOverrides).map(([k, v]) => `${k}=${v}`).join(', ')})`);
  }

  // Skills without the engine to invoke them are inert — a target repo
  // that isn't this spine fork itself needs .pdlc/ too, not just
  // .claude/+.cursor/, or an agent has nothing to run status/advance/
  // route/start-ticket against.
  if (outRoot !== REPO_ROOT && flags['with-runtime'] !== 'false' && flags['with-runtime'] !== false) {
    const written = distributeRuntime(REPO_ROOT, outRoot);
    console.log(`also distributed the PDLC runtime to .pdlc/ (${written.length} files) — pass --with-runtime false to skip this.`);
    const ciPath = distributeCiTemplate(REPO_ROOT, outRoot);
    console.log(`also wrote the CI gate-check backstop to ${path.relative(outRoot, ciPath)} — mark it a required status check in this repo's branch protection to make it actually block merges.`);
  }
}

// A repo can have more than one stack — a service with its own
// Terraform, a monorepo with a frontend and a BFF — so "which
// conventions apply" is a per-FILE question. It used to be answered by
// matching a module's prose description, which is fine with two stacks
// installed and degrades with eleven.
// One plugin, two manifests, both tools. Deliberately additive: this
// does NOT replace `compile --out`. A repo still needs the CI workflow
// (no plugin can install .github/workflows/, and it is the only control
// that cannot be talked around) and its own pdlc/<TICKET>/ directories.
function cmdBuildPlugin(flags) {
  if (!flags.out || flags.out === true) {
    console.error('build-plugin needs --out <path> — the directory to write the plugin into. It is emptied first.');
    process.exitCode = 1;
    return;
  }
  const modulesDir = path.resolve(flags.modules || path.join(REPO_ROOT, 'modules'));
  // listFlag returns [] for an absent flag, and [] is truthy — passed
  // straight through, compileAll filtered EVERY stack module out while
  // the command reported a full build. Normalise to null.
  const stacks = listFlag(flags, 'only-stacks');
  const onlyStacks = stacks.length ? stacks : null;
  const out = path.resolve(flags.out);
  const result = buildPlugin(modulesDir, out, { onlyStacks, includeMeta: flags['include-meta'] === true });

  console.log(`build-plugin: ${result.modules.length} module(s), ${result.written.length} files -> ${out}`);
  console.log('');
  console.log('Install it:');
  console.log(`  Cursor       cp -R ${out} ~/.cursor/plugins/local/${PLUGIN_NAME}`);
  console.log(`  Claude Code  /plugin marketplace add ${out}`);
  console.log(`               /plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  console.log('');
  console.log('Still needed in the target repo (a plugin cannot install these):');
  console.log('  .github/workflows/pdlc-gate-check.yml   spine compile --out <repo>');
  console.log('  PDLC-QUICKSTART.md                      (same command)');
  if (!onlyStacks) {
    console.log('');
    console.log(`Note: no --only-stacks, so every stack convention shipped. Selection is per file at`);
    console.log(`review time (spine stacks-for), so this is noise rather than breakage — but a repo`);
    console.log(`only needs the stacks it has: --only-stacks java-conventions,terraform-conventions`);
  }
}

function cmdStacksFor(flags) {
  const modulesDir = path.resolve(flags.modules || path.join(REPO_ROOT, 'modules'));
  let files = [];
  if (typeof flags.files === 'string') {
    files = flags.files.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (typeof flags.diff === 'string') {
    try {
      files = execFileSync('git', ['diff', '--name-only', `${flags.diff}...HEAD`], { encoding: 'utf8' })
        .split('\n').map((s) => s.trim()).filter(Boolean);
    } catch (err) {
      console.error(`could not read the diff against ${flags.diff}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    console.error('stacks-for needs --files a.java,b.tf or --diff <base-ref>');
    process.exitCode = 1;
    return;
  }
  const hits = stacksForFiles(compiler.scanModules(modulesDir), files);
  if (!hits.length) {
    console.log(`no stack module declares a file pattern matching these ${files.length} file(s).`);
    console.log("Fall back to the reviewer whose description fits, and consider adding the pattern to that module's applies_to.");
    return;
  }
  for (const h of hits) {
    console.log(`${h.id}  (${h.matched.length} file(s))`);
    for (const f of h.matched.slice(0, 5)) console.log(`    ${f}`);
    if (h.matched.length > 5) console.log(`    … and ${h.matched.length - 5} more`);
  }
}

function cmdStackGaps(flags) {
  const modulesDir = path.resolve(flags.modules || path.join(REPO_ROOT, 'modules'));
  const reposYaml = path.resolve(flags.repos || path.join(modulesDir, 'meta', 'stack-miner', 'repos.yaml'));
  let result;
  try {
    result = findStackGaps(reposYaml, modulesDir);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  const { wanted, covered, missing, draftInProgress } = result;
  console.log(`${wanted.length} stack(s) declared in ${path.relative(REPO_ROOT, reposYaml)}\n`);
  if (missing.length) {
    console.log(`MISSING — no module yet, needs a stack-miner pass:`);
    for (const id of missing) console.log(`  - ${id}${draftInProgress.includes(id) ? ' (draft in progress, awaiting owner review)' : ''}`);
    console.log();
  }
  if (covered.length) {
    console.log(`COVERED:`);
    for (const c of covered) {
      console.log(`  - ${c.id}  (last touched: ${c.lastModified || 'unknown'})`);
      if (c.draftPath) {
        console.log(`      draft awaiting owner review: ${path.relative(REPO_ROOT, c.draftPath)}`);
      }
      if (c.topics) {
        const total = c.topics.addressed.length + c.topics.unaddressed.length;
        console.log(`      ${c.topics.addressed.length}/${total} topics addressed`);
        if (c.topics.unaddressed.length) {
          console.log(`      not addressed: ${c.topics.unaddressed.join(', ')}`);
        }
      }
    }
  }
  if (!missing.length && !covered.length) console.log('Nothing declared yet — fill in repos.yaml first.');
}

function cmdOverlapCheck(flags) {
  const modulesDir = path.resolve(flags.modules || path.join(REPO_ROOT, 'modules'));
  const threshold = flags.threshold ? parseFloat(flags.threshold) : undefined;
  const modules = compiler.scanModules(modulesDir);
  const pairs = findOverlappingPairs(modules, threshold);
  if (pairs.length === 0) {
    console.log(`No overlapping description pairs found among ${modules.length} modules.`);
    return;
  }
  console.log(`${pairs.length} candidate pair(s) worth a closer look (description similarity, not a contradiction claim):\n`);
  for (const p of pairs) console.log(`  ${p.score}  ${p.a}  <->  ${p.b}`);
  console.log('\nThis is a cheap shortlist, not a verdict — run the module-auditor agent (modules/meta/module-auditor) on these pairs for an actual duplicate/contradiction/intentional-composition judgment.');
}

function cmdMigrateSkill(flags) {
  const modulesDir = path.resolve(flags.modules || path.join(REPO_ROOT, 'modules'));
  if (!flags.source || !flags.category || !flags.id) {
    console.error('usage: spine migrate-skill --source <path> --category <phases|stacks|disciplines|meta> --id <id> [--kind skill|agent] [--tool-compat claude,cursor] [--description "..."] [--owner "#team"] [--always-apply true]');
    process.exitCode = 1;
    return;
  }
  try {
    const result = migrateSkill({
      sourcePath: path.resolve(flags.source),
      modulesDir,
      category: flags.category,
      id: flags.id,
      kind: flags.kind,
      toolCompat: flags['tool-compat'] ? flags['tool-compat'].split(',').map((s) => s.trim()) : undefined,
      description: flags.description,
      owner: flags.owner,
      alwaysApply: boolFlag(flags, 'always-apply'),
    });
    console.log(`Migrated. Wrote:\n  ${result.manifestPath}\n  ${result.skillPath}`);
    if (result.warnings.length) {
      console.log('\n⚠ warnings:');
      for (const w of result.warnings) console.log(`  - ${w}`);
    }
    console.log('\nNext: set a real owner and description if they were placeholders, review the copied content for');
    console.log('anything tool-specific that might not translate, run `npm run compile`, and retire the original');
    console.log('hand-authored file in its old location — this module is now the single source of truth for it.');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

function cmdDistributeRuntime(flags) {
  if (!flags.out) {
    console.error('usage: spine distribute-runtime --out <path-to-target-repo>');
    process.exitCode = 1;
    return;
  }
  try {
    const outRoot = path.resolve(flags.out);
    const written = distributeRuntime(REPO_ROOT, outRoot);
    console.log(`Distributed runtime to ${outRoot}/.pdlc/ (${written.length} files/dirs).`);
    console.log('That target repo can now run `node .pdlc/bin/spine.js status` etc. on its own — no need for the spine fork.');
    const ciPath = distributeCiTemplate(REPO_ROOT, outRoot);
    console.log(`Also wrote ${path.relative(outRoot, ciPath)} — mark "PDLC gate check" as a required status check in branch protection to make it actually block merges.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

function cmdStartTicket(flags) {
  if (!flags.id || flags.id === true) {
    console.error('usage: spine start-ticket --id <ticket-id> [--repo <path>] [--issue-type <type>] [--priority <P1..P4>] [--labels a,b,c] [--branch <name>] [--worktree <path>]');
    process.exitCode = 1;
    return;
  }
  try {
    const result = startTicket({
      repoPath: flags.repo && flags.repo !== true ? flags.repo : undefined,
      ticketId: flags.id,
      issueType: flags['issue-type'] && flags['issue-type'] !== true ? flags['issue-type'] : undefined,
      priority: flags.priority && flags.priority !== true ? flags.priority : undefined,
      labels: listFlag(flags, 'labels'),
      branch: flags.branch && flags.branch !== true ? flags.branch : undefined,
      worktreePath: flags.worktree && flags.worktree !== true ? flags.worktree : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

function cmdFinishTicket(flags) {
  if (!flags.worktree || flags.worktree === true) {
    console.error('usage: spine finish-ticket --worktree <path> [--repo <path>] [--project <ticket dir>] [--delete-branch] [--force]');
    process.exitCode = 1;
    return;
  }
  try {
    const result = finishTicket({
      worktreePath: flags.worktree,
      repoPath: flags.repo && flags.repo !== true ? flags.repo : undefined,
      projectDir: flags.project && flags.project !== true ? flags.project : undefined,
      deleteBranch: boolFlag(flags, 'delete-branch'),
      force: boolFlag(flags, 'force'),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.wasForced) {
      console.log('(removed with --force while the ticket was not actually finished — this was an abandon, not a completion)');
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

// spec-kitti (the client's Spec Kit fork) is optional: this answers "does a spec-kitti feature already
// cover this ticket?" so a writer skill can extract from specs/<###>/
// instead of drafting from Jira. `found: false` is a normal answer
// (exit 0) — the skill then proceeds exactly as it would without
// spec-kitti. See lib/spec-kitti.js for how the link is discovered.
function cmdSpecKitti(flags) {
  if (!flags.ticket || flags.ticket === true) {
    console.error('usage: spine spec-kitti --ticket <JIRA-KEY> [--epic <JIRA-KEY>] [--repo <path>] [--json]');
    process.exitCode = 1;
    return;
  }
  const repoRoot = flags.repo && flags.repo !== true ? path.resolve(flags.repo) : (gateEngine.gitToplevel(process.cwd()) || process.cwd());
  const result = locateFeature({ repoRoot, ticketKey: flags.ticket, epicKey: flags.epic && flags.epic !== true ? flags.epic : null });
  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
  }
}

// Studio-side: pull the client's versioned rules catalog into the
// modules tree (see lib/import-rules.js for the id -> module mapping).
// Repeatable: a newer catalog rewrites only the generated block and the
// references/rules/ files; hand-authored module content is untouched.
function cmdImportRules(flags) {
  if (!flags.rules || flags.rules === true) {
    console.error('usage: spine import-rules --rules <path-to-rules-repo> [--catalog <rules.yaml>] [--modules <dir>]');
    console.error('  --catalog defaults to <rules>/rules.yaml; point it at spec-kitti\'s rules-catalog/rules.yaml when that is the index that matches the rule files.');
    process.exitCode = 1;
    return;
  }
  const rulesRoot = path.resolve(flags.rules);
  const catalogPath = path.resolve(flags.catalog && flags.catalog !== true ? flags.catalog : path.join(rulesRoot, 'rules.yaml'));
  const modulesDir = path.resolve(flags.modules && flags.modules !== true ? flags.modules : path.join(REPO_ROOT, 'modules'));
  const result = importRules({ catalogPath, rulesRoot, modulesDir });
  console.log(`imported ${result.rulesImported} rule(s) from catalog v${result.catalogVersion} into ${result.modules.length} module(s): ${result.modules.join(', ')}`);
  for (const m of result.created) console.log(`  created stack module ${m}`);
  for (const r of result.removed) console.log(`  removed stale ${path.relative(modulesDir, r)}`);
  if (result.skipped.length) {
    const byReason = {};
    for (const s of result.skipped) (byReason[s.reason] = byReason[s.reason] || []).push(s.id);
    for (const [reason, ids] of Object.entries(byReason)) console.log(`  skipped ${ids.length}: ${reason} (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', ...' : ''})`);
  }
  if (result.missing.length) {
    console.log(`  WARNING ${result.missing.length} catalog entr${result.missing.length === 1 ? 'y' : 'ies'} point at files that do not exist under ${rulesRoot}: ${result.missing.slice(0, 5).map((m) => m.id).join(', ')}${result.missing.length > 5 ? ', ...' : ''}`);
  }
  console.log(`  lock: ${path.relative(REPO_ROOT, result.lockPath)} — run npm run compile, review the diff, commit.`);
}

function cmdDistributeAll(flags) {
  const modulesDir = path.resolve(flags.modules || path.join(REPO_ROOT, 'modules'));
  const reposYamlPath = path.resolve(flags.repos || path.join(modulesDir, 'meta', 'stack-miner', 'repos.yaml'));
  const registryPath = path.resolve(flags.registry || path.join(REPO_ROOT, 'spine', 'registry.yaml'));
  const registry = fs.existsSync(registryPath) ? readYaml(registryPath) : null;

  let outcome;
  try {
    outcome = distributeAll({ reposYamlPath, modulesDir, repoRoot: REPO_ROOT, registry });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  for (const r of outcome.results) {
    console.log(`${r.localPath}  [${r.stacks.join(', ')}]  ${r.modules.length} module(s)${r.dormant.length ? `, ${r.dormant.length} dormant` : ''}`);
  }
  if (outcome.skipped.length) {
    console.log(`\nSkipped ${outcome.skipped.length}:`);
    for (const s of outcome.skipped) console.log(`  ${s.localPath || s.repo} (${s.stack ? s.stack + ': ' : ''}${s.reason})`);
  }
  if (outcome.results.length === 0 && outcome.skipped.length === 0) {
    console.log('Nothing declared in repos.yaml yet.');
  }
}

function cmdDoctor(flags) {
  if (!flags.target) {
    console.error('usage: spine doctor --target <path> [--registry <path>] [--only-stacks a,b] [--include-meta true]');
    process.exitCode = 1;
    return;
  }
  const modulesDir = path.resolve(flags.modules || path.join(REPO_ROOT, 'modules'));
  const registryPath = path.resolve(flags.registry || path.join(REPO_ROOT, 'spine', 'registry.yaml'));
  const registry = fs.existsSync(registryPath) ? readYaml(registryPath) : null;
  const onlyStacks = flags['only-stacks'] ? flags['only-stacks'].split(',').map((s) => s.trim()) : null;

  let result;
  try {
    result = checkDrift({
      targetPath: flags.target,
      modulesDir,
      repoRoot: REPO_ROOT,
      registry,
      onlyStacks,
      excludeMeta: !boolFlag(flags, 'include-meta'),
    });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  console.log(`Recompiled ${result.targetPath} — ${result.modules.length} module(s)${result.dormant.length ? `, ${result.dormant.length} dormant` : ''}.`);
  if (!result.gitAvailable) {
    console.log('Not a git repo (or git unavailable) — recompiled successfully, but drift can\'t be reported without git.');
    return;
  }
  if (result.inSync) {
    console.log('In sync — nothing changed. This target already matched what the spine fork currently generates.');
  } else {
    console.log(`Drift found — ${result.changed.length} file(s) changed by recompiling:`);
    for (const c of result.changed) console.log(`  ${c}`);
    console.log('\nReview the diff and commit it in the target repo if this drift is expected (the spine fork moved on).');
  }
}

function dispatch(command, flags) {
  switch (command) {
    case 'init':
      return cmdInit(flags);
    case 'status':
      return cmdStatus(flags);
    case 'gate-check':
      return cmdGateCheck(flags);
    case 'advance':
      return cmdAdvance(flags);
    case 'route':
      return cmdRoute(flags);
    case 'compile':
      return cmdCompile(flags);
    case 'stack-gaps':
      return cmdStackGaps(flags);
    case 'stacks-for':
      return cmdStacksFor(flags);
    case 'build-plugin':
      return cmdBuildPlugin(flags);
    case 'overlap-check':
      return cmdOverlapCheck(flags);
    case 'migrate-skill':
      return cmdMigrateSkill(flags);
    case 'distribute-runtime':
      return cmdDistributeRuntime(flags);
    case 'start-ticket':
      return cmdStartTicket(flags);
    case 'finish-ticket':
      return cmdFinishTicket(flags);
    case 'distribute-all':
      return cmdDistributeAll(flags);
    case 'doctor':
      return cmdDoctor(flags);
    case 'spec-kitti':
    case 'speckit':
      return cmdSpecKitti(flags);
    case 'import-rules':
      return cmdImportRules(flags);
    default:
      console.log('usage: spine <init|status|gate-check|advance|route|compile|build-plugin|stack-gaps|stacks-for|overlap-check|migrate-skill|distribute-runtime|start-ticket|finish-ticket|distribute-all|doctor|spec-kitti|import-rules> [--project <ticket dir>] [--rules <rules repo>] [--catalog <rules.yaml>] [--ticket <JIRA-KEY>] [--epic <JIRA-KEY>] [--json] [--ticket <id>] [--track <name>] [--context <json>] [--repos <path>] [--threshold <0-1>] [--out <path>] [--id <ticket>] [--repo <path>] [--registry <path>] [--project-config <path>] [--worktree <path>] [--delete-branch] [--force] [--target <path>] [--only-stacks a,b] [--with-runtime false] [--include-meta] [--files a.java,b.tf] [--diff <base-ref>]');
      process.exitCode = command ? 1 : 0;
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  try {
    dispatch(command, flags);
  } catch (err) {
    // A readable one-liner, not a Node stack trace — these are run by
    // an agent on a developer's behalf and the message is what gets
    // relayed to the human.
    console.error(`spine ${command}: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
