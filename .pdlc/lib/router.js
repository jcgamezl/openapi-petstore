'use strict';

// Deterministic, rule-based track router — see architecture plan §02
// ("Tracks") and the follow-up on why routing has to be automatic and
// auditable rather than an agent judgment call.
//
// Rules are a small, deliberately non-Turing-complete expression
// language over ticket fields (issue_type, priority, labels, ...).
// Evaluated with a hand-written parser, not eval(), so a client's
// routing config can never execute arbitrary code.
//
// Grammar:
//   expr       := orExpr
//   orExpr     := andExpr ('or' andExpr)*
//   andExpr    := notExpr ('and' notExpr)*
//   notExpr    := 'not' notExpr | comparison
//   comparison := '(' expr ')' | IDENT op operand
//   op         := '==' | '!=' | 'in' | 'contains'
//   operand    := STRING | LIST
//   LIST       := '[' STRING (',' STRING)* ']'

function tokenize(src) {
  const re = /\s*(==|!=|\(|\)|\[|\]|,|'[^']*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)\s*/g;
  const tokens = [];
  let m;
  let lastIndex = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index !== lastIndex) {
      throw new Error(`unrecognized routing rule syntax near: ${src.slice(lastIndex)}`);
    }
    tokens.push(m[1]);
    lastIndex = re.lastIndex;
  }
  if (lastIndex !== src.length) {
    throw new Error(`unrecognized routing rule syntax near: ${src.slice(lastIndex)}`);
  }
  return tokens;
}

function unquote(tok) {
  return tok.slice(1, -1);
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (tok) => {
    if (peek() !== tok) throw new Error(`expected "${tok}", got "${peek()}"`);
    return next();
  };

  function parseOperand() {
    if (peek() === '[') {
      next();
      const items = [];
      if (peek() !== ']') {
        items.push(unquote(next()));
        while (peek() === ',') {
          next();
          items.push(unquote(next()));
        }
      }
      expect(']');
      return { type: 'list', value: items };
    }
    const tok = next();
    if (tok.startsWith("'") || tok.startsWith('"')) return { type: 'string', value: unquote(tok) };
    return { type: 'ident', value: tok };
  }

  function parseComparison() {
    if (peek() === '(') {
      next();
      const inner = parseOr();
      expect(')');
      return inner;
    }
    const left = parseOperand();
    const op = next();
    if (!['==', '!=', 'in', 'contains'].includes(op)) {
      throw new Error(`expected comparison operator, got "${op}"`);
    }
    const right = parseOperand();
    return { type: 'cmp', op, left, right };
  }

  function parseNot() {
    if (peek() === 'not') {
      next();
      return { type: 'not', expr: parseNot() };
    }
    return parseComparison();
  }

  function parseAnd() {
    let node = parseNot();
    while (peek() === 'and') {
      next();
      node = { type: 'and', left: node, right: parseNot() };
    }
    return node;
  }

  function parseOr() {
    let node = parseAnd();
    while (peek() === 'or') {
      next();
      node = { type: 'or', left: node, right: parseAnd() };
    }
    return node;
  }

  const ast = parseOr();
  if (pos !== tokens.length) throw new Error(`unexpected trailing tokens: ${tokens.slice(pos).join(' ')}`);
  return ast;
}

function resolveOperand(node, context) {
  if (node.type === 'ident') {
    // A typo'd field name used to evaluate to undefined and the rule
    // quietly went false — every ticket then fell through to the default
    // track with no hint why (audit finding). Fail loudly instead.
    if (!Object.prototype.hasOwnProperty.call(context, node.value)) {
      throw new Error(`unknown field "${node.value}" in routing rule — the intake context has: ${Object.keys(context).join(', ')}`);
    }
    return context[node.value];
  }
  if (node.type === 'string') return node.value;
  if (node.type === 'list') return node.value;
  throw new Error(`cannot resolve operand of type ${node.type}`);
}

function evaluate(ast, context) {
  switch (ast.type) {
    case 'and':
      return evaluate(ast.left, context) && evaluate(ast.right, context);
    case 'or':
      return evaluate(ast.left, context) || evaluate(ast.right, context);
    case 'not':
      return !evaluate(ast.expr, context);
    case 'cmp': {
      const left = resolveOperand(ast.left, context);
      const right = resolveOperand(ast.right, context);
      switch (ast.op) {
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        case 'in':
          return Array.isArray(right) && right.includes(left);
        case 'contains':
          return Array.isArray(left) && left.includes(right);
        default:
          throw new Error(`unknown operator ${ast.op}`);
      }
    }
    default:
      throw new Error(`unknown AST node ${ast.type}`);
  }
}

function evaluateRule(ruleSrc, context) {
  return evaluate(parse(tokenize(ruleSrc)), context);
}

// Picks a track for the given intake context (e.g. { issue_type, priority,
// labels }) using phase-graph.yaml's routing.rules in order; first match
// wins; falls back to routing.default. Fully deterministic — same input,
// same output, every time, so it's reproducible for an audit.
// routing.reject: rules for issues that are not something a developer
// resolves through the phases at all (an Epic is a container; a
// discovery or QA-certification issue produces a document, not a
// release). Checked before the track rules; the caller (start-ticket)
// refuses with the reason instead of routing to the default and
// quietly opening a worktree for work that will never clear a gate.
function route(graph, context) {
  const routing = graph.routing || {};
  for (const rule of routing.reject || []) {
    if (evaluateRule(rule.if, context)) {
      return { track: null, matched_rule: rule.if, rejected: true, reason: rule.reason || 'this issue type is not routed through the PDLC' };
    }
  }
  for (const rule of routing.rules || []) {
    if (evaluateRule(rule.if, context)) {
      return { track: rule.track, matched_rule: rule.if };
    }
  }
  return { track: routing.default, matched_rule: null };
}

module.exports = { route, evaluateRule, tokenize, parse };
