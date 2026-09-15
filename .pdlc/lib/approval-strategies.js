'use strict';

// A gate's `approval:` in phase-graph.yaml is either a role name — the
// form every gate in this fork uses today, and the one that must never
// break — or an object naming a strategy. A strategy answers one
// question: given who decided what, is this gate approved, partially
// approved, declined, or still waiting?
//
// Why "partial" is its own state and not just "not approved": a
// two-signature gate that has one signature is genuinely different from
// one that has none. The status report has to be able to say "waiting on
// the builder leader" rather than "not approved", or the second approver
// never learns it is their turn — and that is the failure mode this
// whole feature exists to avoid.
//
// Why any of this exists: phase-graph.yaml's own comments record that
// the client's model has the product builder co-signing scope.md with
// the product definer, and that the spine works around it with "one
// signature plus a recorded review" because no gate takes two. This is
// the machinery for expressing it natively. It turns no gate into a
// quorum on its own — that is a client decision and one line of config.

function fail(msg) {
  throw new Error(`invalid approval in phase-graph.yaml: ${msg}`);
}

function normaliseQuorum(config) {
  const roles = config.roles;
  if (!Array.isArray(roles) || roles.length === 0) {
    fail('a quorum gate needs at least one role in `roles`');
  }
  if (roles.some((r) => typeof r !== 'string' || !r.trim())) {
    fail("every entry in a quorum's `roles` must be a non-empty role name");
  }
  if (new Set(roles).size !== roles.length) {
    fail("a quorum's `roles` must not contain a duplicate");
  }
  const min = config.min_approvals === undefined ? roles.length : config.min_approvals;
  if (!Number.isInteger(min) || min < 1 || min > roles.length) {
    fail(
      "a quorum's `min_approvals` must be an integer between 1 and "
      + `${roles.length} (the number of roles), got ${JSON.stringify(config.min_approvals)}`
    );
  }
  return {
    strategy: 'quorum',
    config: { roles: [...roles], min_approvals: min },
    roles: [...roles],
  };
}

function normaliseTier(config) {
  if (typeof config.tier !== 'string' || !config.tier.trim()) {
    fail('a tier gate needs a `tier` string');
  }
  const map = config.role_by_tier;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    fail('a tier gate needs a `role_by_tier` map');
  }
  const role = map[config.tier];
  if (typeof role !== 'string' || !role.trim()) {
    fail(
      `\`role_by_tier\` has no role for tier "${config.tier}" `
      + `(it has: ${Object.keys(map).join(', ') || 'nothing'})`
    );
  }
  return { strategy: 'tier', config: { tier: config.tier, role }, roles: [role] };
}

function normalise(approval) {
  if (typeof approval === 'string' && approval.trim()) {
    return { strategy: 'single', config: { role: approval }, roles: [approval] };
  }
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
    fail('`approval` must be a role name or an approval object with a `strategy`');
  }
  switch (approval.strategy) {
    case 'single':
      if (typeof approval.role !== 'string' || !approval.role.trim()) {
        fail('a single gate needs a `role`');
      }
      return { strategy: 'single', config: { role: approval.role }, roles: [approval.role] };
    case 'quorum':
      return normaliseQuorum(approval);
    case 'tier':
      return normaliseTier(approval);
    default:
      fail(`unknown approval strategy "${approval.strategy}" — known strategies are single, quorum, tier`);
  }
  return null; // unreachable: fail() throws
}

// A decline is absolute: it is not a vote to be outnumbered. Somebody
// with the authority to approve said no, and that is a conversation, not
// a shortfall of signatures.
function evaluate(normalised, decisions) {
  const d = decisions || {};
  if (normalised.roles.some((role) => d[role] === 'declined')) return 'declined';
  const approved = normalised.roles.filter((role) => d[role] === 'approved').length;
  const need = normalised.strategy === 'quorum'
    ? normalised.config.min_approvals
    : normalised.roles.length;
  if (approved >= need) return 'approved';
  return approved > 0 ? 'partial' : 'pending';
}

module.exports = { normalise, evaluate };
