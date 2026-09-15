'use strict';

// Cheap, deterministic first pass: flags module pairs whose
// descriptions overlap enough to be worth a human/LLM look — not a
// claim they actually contradict each other, just "these two look
// like they might be covering the same ground, check before this
// grows to dozens of modules nobody's cross-referencing." The actual
// semantic judgment (duplicate vs. intentionally composing vs.
// genuinely contradicting) is modules/meta/module-auditor's job, not
// this one's — this only shortlists candidates so that expensive LLM
// review doesn't have to run over every possible pair.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with',
  'this', 'that', 'is', 'are', 'not', 'any', 'using', 'use', 'used',
  'client', 'code', 'their', 'its',
]);

function significantWords(text) {
  return new Set(
    (text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// threshold default chosen empirically-ish: low enough to catch
// "code-review" vs "code-reviewer" style near-duplicates, high enough
// that unrelated modules (jira-intake vs data-science) don't flag.
function findOverlappingPairs(modules, threshold = 0.35) {
  const words = modules.map((m) => significantWords(m.manifest.description || ''));
  const pairs = [];
  for (let i = 0; i < modules.length; i += 1) {
    for (let j = i + 1; j < modules.length; j += 1) {
      const score = jaccard(words[i], words[j]);
      if (score >= threshold) {
        pairs.push({ a: modules[i].manifest.id, b: modules[j].manifest.id, score: Math.round(score * 100) / 100 });
      }
    }
  }
  return pairs.sort((x, y) => y.score - x.score);
}

module.exports = { findOverlappingPairs, jaccard, significantWords };
