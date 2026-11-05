// Small AST toolkit on top of @babel/parser. No @babel/traverse: a plain
// recursive walk with an ancestor stack is all the detectors need.
import { parse } from '@babel/parser';

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range', 'tokens', 'comments']);

export function parseSource(code, filename = 'file.js') {
  const plugins = [];
  if (/\.tsx?$/.test(filename) || /\.[cm]ts$/.test(filename)) plugins.push('typescript');
  if (/\.(jsx|tsx|js|mjs|cjs)$/.test(filename)) plugins.push('jsx');
  return parse(code, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    plugins,
  });
}

export function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, ancestors) === false) return;
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c.type === 'string') walk(c, visit, ancestors);
      }
    } else if (child && typeof child.type === 'string') {
      walk(child, visit, ancestors);
    }
  }
  ancestors.pop();
}

export function findAll(root, predicate) {
  const out = [];
  walk(root, (node, ancestors) => {
    if (predicate(node, ancestors)) out.push({ node, ancestors: ancestors.slice() });
  });
  return out;
}

export const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod']);

export function enclosingFunction(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (FUNCTION_TYPES.has(ancestors[i].type)) return ancestors[i];
  }
  return null;
}

// Best-effort human name for a function: `async function createOrder`,
// `const createOrder = async () =>`, or the route for `app.post('/x', fn)`.
export function functionName(fn, ancestors) {
  if (!fn) return '(top level)';
  if (fn.id?.name) return fn.id.name;
  if (fn.key?.name) return fn.key.name;
  // Callers pass ancestors with or without the function itself on the end.
  const idx = ancestors.lastIndexOf(fn);
  const parent = idx === -1 ? ancestors[ancestors.length - 1] : ancestors[idx - 1];
  if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
  if ((parent?.type === 'ObjectProperty' || parent?.type === 'ClassProperty' || parent?.type === 'ClassPrivateProperty') && parent.key) return keyName(parent.key) || '(anonymous)';
  if (parent?.type === 'AssignmentExpression') return memberPath(parent.left) || '(anonymous)';
  if (parent?.type === 'CallExpression') {
    const route = routeOf(parent);
    if (route) return `${route.method} ${route.path}`;
  }
  return '(anonymous)';
}

export function keyName(key) {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  if (key.type === 'NumericLiteral') return String(key.value);
  return null;
}

export function memberPath(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const obj = memberPath(node.object);
    const prop = node.computed ? (node.property.type === 'StringLiteral' ? node.property.value : '[]') : node.property.name;
    return obj ? `${obj}.${prop}` : null;
  }
  if (node.type === 'AwaitExpression') return memberPath(node.argument);
  if (node.type === 'CallExpression') {
    const callee = memberPath(node.callee);
    return callee ? `${callee}()` : null;
  }
  return null;
}

// Concatenate string-ish expressions; non-literal pieces become ${…}.
export function stringValue(node) {
  if (!node) return null;
  switch (node.type) {
    case 'StringLiteral':
      return node.value;
    case 'TemplateLiteral': {
      let s = '';
      node.quasis.forEach((q, i) => {
        s += q.value.cooked ?? q.value.raw;
        if (i < node.expressions.length) s += '${…}';
      });
      return s;
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') return null;
      const l = stringValue(node.left);
      const r = stringValue(node.right);
      if (l == null && r == null) return null;
      return (l ?? '${…}') + (r ?? '${…}');
    }
    default:
      return null;
  }
}

export function objectProp(obj, name, { ci = false } = {}) {
  if (!obj || obj.type !== 'ObjectExpression') return null;
  for (const p of obj.properties) {
    if (p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod') continue;
    const k = keyName(p.key);
    if (k == null) continue;
    if (ci ? k.toLowerCase() === name.toLowerCase() : k === name) return p;
  }
  return null;
}

// Express/Koa/Fastify style `app.post('/path', handler)`.
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use']);
export function routeOf(call) {
  if (call?.type !== 'CallExpression') return null;
  const callee = call.callee;
  if (callee?.type !== 'MemberExpression' || callee.computed) return null;
  const method = callee.property?.name;
  if (!ROUTE_METHODS.has(method)) return null;
  const path = stringValue(call.arguments[0]);
  if (path == null || !path.startsWith('/')) return null;
  return { method: method.toUpperCase(), path };
}

// fetch(url, { method, headers, body }) / axios.post(url, data, config) /
// axios({ url, method }) / got.post(url, opts). Returns a normalised view.
export function httpCall(node) {
  if (node?.type !== 'CallExpression') return null;
  const callee = node.callee;
  const args = node.arguments;
  const name = memberPath(callee);
  if (!name) return null;
  const last = name.split('.').pop();
  if (last === 'fetch' || name === 'fetch' || name === 'globalThis.fetch') {
    const opts = args[1]?.type === 'ObjectExpression' ? args[1] : null;
    const methodNode = objectProp(opts, 'method')?.value;
    return {
      kind: 'fetch', urlNode: args[0], optionsNode: args[1] ?? null,
      method: (stringValue(methodNode) || (methodNode ? '?' : 'GET')).toUpperCase(),
      headersNode: objectProp(opts, 'headers')?.value ?? null,
      bodyNode: objectProp(opts, 'body')?.value ?? null,
    };
  }
  const base = name.split('.').slice(0, -1).join('.');
  if (/axios|got|http|client|request|ky/i.test(base) && ['post', 'put', 'patch'].includes(last)) {
    const cfg = args[2]?.type === 'ObjectExpression' ? args[2] : (base.includes('got') ? args[1] : null);
    return {
      kind: base, urlNode: args[0], optionsNode: cfg ?? null, method: last.toUpperCase(),
      headersNode: objectProp(cfg, 'headers')?.value ?? null,
      bodyNode: base.includes('got') ? objectProp(cfg, 'json')?.value ?? null : args[1] ?? null,
    };
  }
  if (name === 'axios' && args[0]?.type === 'ObjectExpression') {
    const cfg = args[0];
    return {
      kind: 'axios', urlNode: objectProp(cfg, 'url')?.value, optionsNode: cfg,
      method: (stringValue(objectProp(cfg, 'method')?.value) || 'GET').toUpperCase(),
      headersNode: objectProp(cfg, 'headers')?.value ?? null,
      bodyNode: objectProp(cfg, 'data')?.value ?? null,
    };
  }
  return null;
}

// Collect every variable binding inside a function (or the program):
// name -> { init, kind: 'var'|'destructure'|'param', key?, index? }.
// Block scoping is ignored on purpose: detectors only need "where could
// this identifier have come from".
export function bindingsOf(scope) {
  const map = new Map();
  if (!scope) return map;
  if (FUNCTION_TYPES.has(scope.type)) {
    scope.params.forEach((p, index) => addPattern(map, p, { kind: 'param', index }));
  }
  const body = FUNCTION_TYPES.has(scope.type) ? scope.body : scope;
  walk(body, (node) => {
    if (node !== body && FUNCTION_TYPES.has(node.type)) return false;
    if (node.type === 'VariableDeclarator') addPattern(map, node.id, { kind: 'var', init: node.init });
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
      if (!map.has(node.left.name)) map.set(node.left.name, { kind: 'var', init: node.right });
    }
    return true;
  });
  return map;
}

function addPattern(map, pattern, info, path = []) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      if (!map.has(pattern.name)) map.set(pattern.name, { ...info, path, node: pattern });
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') addPattern(map, prop.argument, info, path);
        else addPattern(map, prop.value, { ...info, kind: info.kind === 'param' ? 'param' : 'destructure' }, [...path, keyName(prop.key)]);
      }
      break;
    case 'ArrayPattern':
      pattern.elements.forEach((el, i) => addPattern(map, el, info, [...path, String(i)]));
      break;
    case 'AssignmentPattern':
      addPattern(map, pattern.left, { ...info, defaultValue: pattern.right }, path);
      break;
    case 'TSParameterProperty':
      addPattern(map, pattern.parameter, info, path);
      break;
    default:
      break;
  }
}

export function sourceOf(code, node) {
  return code.slice(node.start, node.end);
}

export function linesAround(code, line, before = 2, after = 4) {
  const lines = code.split('\n');
  const from = Math.max(1, line - before);
  const to = Math.min(lines.length, line + after);
  const out = [];
  for (let i = from; i <= to; i++) out.push({ line: i, text: lines[i - 1] });
  return out;
}

// Throws on any syntax error. Used to reject patches that don't parse.
export function parseStrict(code, filename = 'file.js') {
  const plugins = [];
  if (/\.tsx?$/.test(filename) || /\.[cm]ts$/.test(filename)) plugins.push('typescript');
  if (/\.(jsx|tsx|js|mjs|cjs)$/.test(filename)) plugins.push('jsx');
  return parse(code, { sourceType: 'unambiguous', allowAwaitOutsideFunction: true, plugins });
}
