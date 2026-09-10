'use strict';

// Which stack conventions does this diff touch?
//
// Every rule `spine import-rules` brought in already carries its own
// "Applies to:" globs from the client's catalog — 14 for java, 33 for
// react, 52 for flutter. Nothing read them. This is the machinery that
// finally does: a module declares the union as `applies_to` in its
// module.yaml, and a diff is matched against it.
//
// Why it matters: a repo can have more than one stack (a service with
// its own Terraform, a monorepo with a frontend and a BFF), so picking
// the reviewer is a per-FILE question, not a per-repo one. It was being
// answered by matching a module's prose description, which is fine with
// two stacks installed and degrades badly with eleven.
//
// The matcher is hand-written rather than pulling in minimatch: the
// catalog only ever uses **, * and literals, and this repo's single
// dependency is a deliberate property, not an accident.

// `**/` matches any number of directories INCLUDING none, so `**/*.java`
// has to match a bare `App.java` too. A lone `*` stops at a separator.
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

const cache = new Map();

function matches(glob, filePath) {
  if (!cache.has(glob)) cache.set(glob, globToRegExp(glob));
  const normalised = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
  return cache.get(glob).test(normalised);
}

// A module with no applies_to is absent from the result, never present
// with an empty match list: "we cannot decide this from filenames" is a
// different answer from "this does not apply", and the caller has to be
// able to tell them apart to fall back correctly. plsql, python and
// angular are in that position today — their imported rules declare no
// patterns — and they must keep being reachable by description.
function stacksForFiles(modules, files) {
  const hits = [];
  for (const mod of modules) {
    const globs = mod.manifest && mod.manifest.applies_to;
    if (!Array.isArray(globs) || globs.length === 0) continue;
    const matched = files.filter((f) => globs.some((g) => matches(g, f)));
    if (matched.length) hits.push({ id: mod.manifest.id, matched });
  }
  return hits.sort((a, b) => b.matched.length - a.matched.length || a.id.localeCompare(b.id));
}

module.exports = { matches, stacksForFiles, globToRegExp };
