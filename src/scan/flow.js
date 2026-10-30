// Just enough data flow to answer two questions about an amount expression:
//   1. does it come from a price/total the client sent? (client-supplied-amount)
//   2. is it float math that never got formatted? (amount-formatting)
// It follows local bindings, then hops to call sites of the enclosing
// function anywhere in the repo (two hops max). Approximate on purpose; the
// LLM pass and the sandbox probes back it up.
import { walk, FUNCTION_TYPES, functionName, bindingsOf, keyName, memberPath } from './ast.js';

const PRICE_KEYS = /^(price|unit_?price|unitPrice|amount|total|totalPrice|total_price|value|cost|subtotal|sub_total|grandTotal|grand_total|unit_amount)$/i;
const ARRAY_METHODS = new Set(['reduce', 'map', 'forEach', 'filter', 'find', 'some', 'every', 'flatMap']);
const MAX_HOPS = 2;

export class RepoIndex {
  constructor() {
    this.files = new Map(); // rel -> { ast, code }
    this.functions = new Map(); // name -> [{ file, node, ancestors }]
    this.calls = new Map(); // callee name -> [{ file, node, ancestors }]
    this.bindings = new WeakMap(); // fn/program node -> Map
    this.imports = new Map(); // file -> Map(localName -> source)
  }

  addFile(file, ast, code) {
    this.files.set(file, { ast, code });
    const imports = new Map();
    this.imports.set(file, imports);
    walk(ast, (node, ancestors) => {
      if (node.type === 'ImportDeclaration') {
        for (const sp of node.specifiers) imports.set(sp.local.name, node.source.value);
      }
      if (node.type === 'VariableDeclarator' && node.init?.type === 'CallExpression' && node.init.callee.name === 'require' && node.init.arguments[0]?.type === 'StringLiteral') {
        const src = node.init.arguments[0].value;
        if (node.id.type === 'Identifier') imports.set(node.id.name, src);
        if (node.id.type === 'ObjectPattern') for (const p of node.id.properties) if (p.value?.type === 'Identifier') imports.set(p.value.name, src);
      }
      if (FUNCTION_TYPES.has(node.type)) {
        const name = functionName(node, ancestors);
        if (name && !name.startsWith('(') && !name.includes(' ')) {
          if (!this.functions.has(name)) this.functions.set(name, []);
          this.functions.get(name).push({ file, node, ancestors: ancestors.slice() });
        }
      }
      if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
        const c = node.callee;
        const name = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') && !c.computed ? c.property.name : null;
        if (name) {
          if (!this.calls.has(name)) this.calls.set(name, []);
          this.calls.get(name).push({ file, node, ancestors: ancestors.slice() });
        }
      }
    });
  }

  bindingsFor(scope) {
    if (!this.bindings.has(scope)) this.bindings.set(scope, bindingsOf(scope));
    return this.bindings.get(scope);
  }

  // Walk outwards through enclosing functions, then the program.
  lookup(name, ancestors) {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i];
      if (FUNCTION_TYPES.has(a.type) || a.type === 'Program') {
        const b = this.bindingsFor(a).get(name);
        if (b) return { binding: b, scope: a, scopeAncestors: ancestors.slice(0, i) };
      }
    }
    return null;
  }

  // Call sites that plausibly call this function: a plain call in the same
  // file, or a call through a name imported from a local (relative) module.
  // Calls like `ordersController.createOrder()` on some library object are
  // not callers of the app's own createOrder().
  callersOf(fnNode, fnAncestors) {
    const name = functionName(fnNode, fnAncestors);
    if (!name || name.startsWith('(') || name.includes(' ')) return [];
    const fnFile = [...this.files.entries()].find(([, f]) => fnAncestors[0] === f.ast || fnAncestors[0] === f.ast.program)?.[0];
    const isLocal = (src) => typeof src === 'string' && src.startsWith('.');
    return (this.calls.get(name) || []).filter((c) => {
      if (c.ancestors.includes(fnNode)) return false;
      const callee = c.node.callee;
      const imports = this.imports.get(c.file) || new Map();
      if (callee.type === 'Identifier') return c.file === fnFile || isLocal(imports.get(callee.name));
      const obj = callee.object;
      if (obj?.type === 'ThisExpression') return c.file === fnFile;
      if (obj?.type === 'Identifier') return isLocal(imports.get(obj.name));
      return false;
    });
  }
}

// Ancestors for a child node: walk down from the program to find it.
export function ancestorsOf(ast, target) {
  let found = null;
  walk(ast, (node, ancestors) => {
    if (found) return false;
    if (node === target) {
      found = ancestors.slice();
      return false;
    }
    return node.start <= target.start && node.end >= target.end;
  });
  return found || [];
}

const isReqBody = (node) => {
  const p = memberPath(node);
  return !!p && /(^|\.)(req|request|ctx\.request|event)\.body(\.|$)/.test(p);
};

const isReqJson = (node) => {
  // await req.json() / await request.json() (Next.js, Hono, Workers)
  const inner = node?.type === 'AwaitExpression' ? node.argument : node;
  return inner?.type === 'CallExpression' && /^(req|request|c\.req)\.json$/.test(memberPath(inner.callee) || '');
};

// --- 1. client price taint -------------------------------------------------

// Returns null, or { steps: [{file, line, text}] } describing how a client
// price reaches `expr`.
export function clientPriceTaint(index, file, expr, ancestors, hops = 0, seen = new Set()) {
  if (!expr || seen.has(expr)) return null;
  seen.add(expr);
  const code = index.files.get(file)?.code || '';
  const step = (node, why) => ({ file, line: node.loc?.start.line, text: why || code.slice(node.start, node.end).split('\n')[0].slice(0, 120) });

  switch (expr.type) {
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const prop = expr.computed ? (expr.property.type === 'StringLiteral' ? expr.property.value : null) : expr.property.name;
      if (prop && PRICE_KEYS.test(prop) && bodyDerived(index, file, expr.object, ancestors, hops, new Set())) {
        return { steps: [step(expr)] };
      }
      return null;
    }
    case 'Identifier': {
      const found = index.lookup(expr.name, ancestors);
      if (!found) return null;
      const { binding, scope, scopeAncestors } = found;
      if (binding.kind === 'destructure' || (binding.kind === 'var' && binding.path?.length)) {
        const last = binding.path[binding.path.length - 1];
        if (last && PRICE_KEYS.test(last)) {
          const declarator = findDeclarator(scope, expr.name);
          if (declarator && bodyDerived(index, file, declarator.init, [...scopeAncestors, scope], hops, new Set())) {
            return { steps: [step(declarator)] };
          }
        }
      }
      if (binding.kind === 'var' && binding.init) {
        const t = clientPriceTaint(index, file, binding.init, [...scopeAncestors, scope], hops, seen);
        if (t) return { steps: [...t.steps] };
      }
      if (binding.kind === 'param' && hops < MAX_HOPS) {
        return viaCallers(index, file, scope, scopeAncestors, binding, hops, (cFile, arg, argAnc) =>
          clientPriceTaint(index, cFile, arg, argAnc, hops + 1, seen));
      }
      return null;
    }
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const callee = expr.callee;
      // cart.reduce((s, item) => s + item.price * item.quantity, 0)
      if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && ARRAY_METHODS.has(callee.property?.name)) {
        if (bodyDerived(index, file, callee.object, ancestors, hops, new Set())) {
          const cb = expr.arguments[0];
          if (cb && FUNCTION_TYPES.has(cb.type)) {
            const itemParam = callee.property.name === 'reduce' ? cb.params[1] : cb.params[0];
            const hit = itemParam && readsPriceOf(cb.body, itemParam);
            if (hit) return { steps: [step(hit), step(callee.object, `${code.slice(callee.object.start, callee.object.end)} comes from the request body`)] };
          }
        }
      }
      const parts = [...expr.arguments];
      if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') parts.unshift(callee.object);
      else parts.unshift(callee);
      for (const a of parts) {
        const t = clientPriceTaint(index, file, a, ancestors, hops, seen);
        if (t) return t;
      }
      return null;
    }
    case 'AwaitExpression':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      return clientPriceTaint(index, file, expr.argument ?? expr.expression, ancestors, hops, seen);
    case 'BinaryExpression':
    case 'LogicalExpression':
      return clientPriceTaint(index, file, expr.left, ancestors, hops, seen) || clientPriceTaint(index, file, expr.right, ancestors, hops, seen);
    case 'ConditionalExpression':
      return clientPriceTaint(index, file, expr.consequent, ancestors, hops, seen) || clientPriceTaint(index, file, expr.alternate, ancestors, hops, seen);
    case 'TemplateLiteral':
      for (const e of expr.expressions) {
        const t = clientPriceTaint(index, file, e, ancestors, hops, seen);
        if (t) return t;
      }
      return null;
    default:
      return null;
  }
}

function readsPriceOf(body, param) {
  const names = new Set();
  if (param.type === 'Identifier') names.add(param.name);
  let hit = null;
  if (param.type === 'ObjectPattern') {
    for (const p of param.properties) {
      const k = keyName(p.key);
      if (k && PRICE_KEYS.test(k)) return p;
    }
  }
  walk(body, (node) => {
    if (hit) return false;
    if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && node.object.type === 'Identifier' && names.has(node.object.name)) {
      const prop = node.computed ? node.property.value : node.property.name;
      if (prop && PRICE_KEYS.test(prop)) hit = node;
    }
    return true;
  });
  return hit;
}

function findDeclarator(scope, name) {
  let out = null;
  walk(scope, (node) => {
    if (out) return false;
    if (node.type === 'VariableDeclarator') {
      let match = false;
      walk(node.id, (n) => {
        if (n.type === 'Identifier' && n.name === name) match = true;
      });
      if (match) out = node;
    }
    return true;
  });
  return out;
}

// Does this expression evaluate to (part of) the request body?
export function bodyDerived(index, file, expr, ancestors, hops, seen) {
  if (!expr || seen.has(expr)) return false;
  seen.add(expr);
  if (isReqBody(expr) || isReqJson(expr)) return true;
  switch (expr.type) {
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return bodyDerived(index, file, expr.object, ancestors, hops, seen);
    case 'AwaitExpression':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
      return bodyDerived(index, file, expr.argument ?? expr.expression, ancestors, hops, seen);
    case 'LogicalExpression':
      return bodyDerived(index, file, expr.left, ancestors, hops, seen) || bodyDerived(index, file, expr.right, ancestors, hops, seen);
    case 'CallExpression': {
      // JSON.parse(rawBody), Array.from(cart), structuredClone(body)...
      return expr.arguments.some((a) => bodyDerived(index, file, a, ancestors, hops, seen)) ||
        (expr.callee.type === 'MemberExpression' && bodyDerived(index, file, expr.callee.object, ancestors, hops, seen));
    }
    case 'Identifier': {
      const found = index.lookup(expr.name, ancestors);
      if (!found) return false;
      const { binding, scope, scopeAncestors } = found;
      if (binding.kind === 'destructure' || (binding.kind === 'var' && binding.path?.length)) {
        const d = findDeclarator(scope, expr.name);
        return !!d && bodyDerived(index, file, d.init, [...scopeAncestors, scope], hops, seen);
      }
      if (binding.kind === 'var') return bodyDerived(index, file, binding.init, [...scopeAncestors, scope], hops, seen);
      if (binding.kind === 'param') {
        // (req, res) handlers: `req` itself is not the body, only req.body is.
        if (hops >= MAX_HOPS) return false;
        return !!viaCallers(index, file, scope, scopeAncestors, binding, hops, (cFile, arg, argAnc) =>
          (bodyDerived(index, cFile, arg, argAnc, hops + 1, new Set()) ? { steps: [] } : null));
      }
      return false;
    }
    default:
      return false;
  }
}

function viaCallers(index, file, fnNode, fnAncestors, binding, hops, check) {
  if (binding.path?.length) return null; // destructured params: skip, too fuzzy
  for (const call of index.callersOf(fnNode, fnAncestors)) {
    const arg = call.node.arguments[binding.index];
    if (!arg) continue;
    const t = check(call.file, arg, call.ancestors.concat(call.node));
    if (t) {
      const code = index.files.get(call.file).code;
      const line = call.node.loc.start.line;
      return { steps: [...t.steps, { file: call.file, line, text: code.slice(call.node.start, call.node.end).split('\n')[0].slice(0, 120) }] };
    }
  }
  return null;
}

// --- 2. amount formatting ---------------------------------------------------

// Classifies what an amount expression evaluates to:
//   'string'     string literal or something formatted (toFixed, a format helper)
//   'fixed:N'    x.toFixed(N)
//   'float'      unformatted number math (or a raw number)
//   'float-str'  String(float) / `${float}` / float.toString()
//   'unknown'
export function amountKind(index, file, expr, ancestors, hops = 0, seen = new Set()) {
  if (!expr || seen.has(expr)) return { kind: 'unknown' };
  seen.add(expr);
  switch (expr.type) {
    case 'StringLiteral':
      return { kind: 'string', literal: expr.value };
    case 'NumericLiteral':
      return { kind: 'float', node: expr, why: 'a raw number literal' };
    case 'BinaryExpression':
      if (['*', '/', '-', '%', '**'].includes(expr.operator)) return { kind: 'float', node: expr, why: 'floating-point arithmetic' };
      if (expr.operator === '+') {
        const l = amountKind(index, file, expr.left, ancestors, hops, seen);
        const r = amountKind(index, file, expr.right, ancestors, hops, seen);
        if (l.kind === 'string' || r.kind === 'string') return { kind: 'unknown' };
        return { kind: 'float', node: expr, why: 'floating-point arithmetic' };
      }
      return { kind: 'unknown' };
    case 'TemplateLiteral': {
      if (expr.expressions.length === 1 && expr.quasis.every((q) => !q.value.cooked)) {
        const inner = amountKind(index, file, expr.expressions[0], ancestors, hops, seen);
        if (inner.kind === 'float') return { ...inner, kind: 'float-str' };
        return inner;
      }
      return { kind: 'unknown' };
    }
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const callee = expr.callee;
      const name = memberPath(callee) || '';
      const last = name.split('.').pop();
      if (last === 'toFixed') {
        const digits = expr.arguments[0]?.type === 'NumericLiteral' ? expr.arguments[0].value : null;
        return { kind: digits == null ? 'string' : `fixed:${digits}`, node: expr };
      }
      if (name === 'String' || last === 'toString') {
        const target = name === 'String' ? expr.arguments[0] : callee.object;
        const inner = amountKind(index, file, target, ancestors, hops, seen);
        if (inner.kind === 'float') return { ...inner, kind: 'float-str' };
        return inner;
      }
      if (['Number', 'parseFloat', 'parseInt'].includes(name)) return { kind: 'float', node: expr, why: `${name}(...) produces a number` };
      if (/^Math\.round$/.test(name)) return { kind: 'float', node: expr, why: 'Math.round(...) returns a number' };
      if (last === 'reduce') return { kind: 'float', node: expr, why: 'a summed (reduce) floating-point total' };
      if (/format|money|amount|cents|decimal|currency|paypal/i.test(last)) return { kind: 'string', node: expr };
      return { kind: 'unknown' };
    }
    case 'Identifier': {
      const found = index.lookup(expr.name, ancestors);
      if (!found) return { kind: 'unknown' };
      const { binding, scope, scopeAncestors } = found;
      if (binding.kind === 'var' && binding.init && !binding.path?.length) {
        return amountKind(index, file, binding.init, [...scopeAncestors, scope], hops, seen);
      }
      if (binding.kind === 'param' && !binding.path?.length && hops < MAX_HOPS) {
        for (const call of index.callersOf(scope, scopeAncestors)) {
          const arg = call.node.arguments[binding.index];
          if (!arg) continue;
          const k = amountKind(index, call.file, arg, call.ancestors.concat(call.node), hops + 1, seen);
          if (k.kind !== 'unknown') return { ...k, via: { file: call.file, line: call.node.loc.start.line } };
        }
      }
      return { kind: 'unknown' };
    }
    case 'AwaitExpression':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
      return amountKind(index, file, expr.argument ?? expr.expression, ancestors, hops, seen);
    default:
      return { kind: 'unknown' };
  }
}
