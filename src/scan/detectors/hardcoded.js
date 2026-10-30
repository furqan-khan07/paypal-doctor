// hardcoded-environment + hardcoded-credentials
import { walk, stringValue, keyName, memberPath } from '../ast.js';

const SANDBOX_HOST = /\bapi(-m)?\.sandbox\.paypal\.com\b/;
const LIVE_HOST = /\bapi(-m)?\.paypal\.com\b/;
const SECRET_NAME = /(client_?secret|clientsecret|paypal_?secret|api_?secret|secret_?key|^secret$|password)/i;
const PLACEHOLDER = /^(your[-_ ]|<|x{3,}|placeholder|changeme|replace|todo|\*+$|\$\{)/i;

const readsEnv = (node) => {
  const p = memberPath(node) || '';
  return /process\.env|import\.meta\.env|Deno\.env|env\./.test(p) || (node?.type === 'CallExpression' && /env|config|getenv/i.test(memberPath(node.callee) || ''));
};

function envFallback(node, parent) {
  // process.env.X || "literal"   /   process.env.X ?? "literal"
  return parent?.type === 'LogicalExpression' && parent.right === node && ['||', '??'].includes(parent.operator) && readsEnv(parent.left);
}

function inEnvSwitch(ancestors) {
  // { sandbox: "https://api-m.sandbox...", live: "https://api-m.paypal.com" }
  // or  env === 'live' ? LIVE : SANDBOX
  for (let i = ancestors.length - 1; i >= Math.max(0, ancestors.length - 4); i--) {
    const a = ancestors[i];
    if (a.type === 'ObjectExpression') {
      const vals = a.properties.map((p) => stringValue(p.value) || '').join(' ');
      if (SANDBOX_HOST.test(vals) && LIVE_HOST.test(vals.replace(SANDBOX_HOST, ''))) return true;
    }
    if (a.type === 'ConditionalExpression') {
      const both = `${stringValue(a.consequent) || ''} ${stringValue(a.alternate) || ''}`;
      if (SANDBOX_HOST.test(both) && LIVE_HOST.test(both.replace(SANDBOX_HOST, ''))) return true;
    }
  }
  return false;
}

export function detectHardcoded(ctx) {
  const { ast, report, isClient } = ctx;
  let reportedEnv = false;

  walk(ast, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];

    // ---- environment host literals ----
    if (!reportedEnv && (node.type === 'StringLiteral' || node.type === 'TemplateLiteral')) {
      const s = stringValue(node) || '';
      const isSandbox = SANDBOX_HOST.test(s);
      const isLive = !isSandbox && LIVE_HOST.test(s) && /https?:\/\//.test(s);
      if ((isSandbox || isLive) && /https?:\/\//.test(s) && !/\/sdk\/js/.test(s) && !/www\.paypal/.test(s)) {
        const insideUrlBuild = parent?.type === 'TemplateLiteral' || parent?.type === 'BinaryExpression';
        if (!envFallback(node, parent) && !inEnvSwitch(ancestors) && !(insideUrlBuild && envFallback(parent, ancestors[ancestors.length - 2]))) {
          reportedEnv = true;
          report('hardcoded-environment', node, {
            message: `The ${isSandbox ? 'sandbox' : 'LIVE'} API host is hardcoded (${s.match(/https?:\/\/[^/'"`\s$]+/)?.[0] || s}). Switching environments means editing code${isSandbox ? ' - and shipping this to production would send real buyers to the sandbox' : ''}.`,
          });
        }
      }
    }

    // ---- secret literals ----
    if (isClient) return true;
    let name = null;
    let valueNode = null;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      name = node.id.name;
      valueNode = node.init;
    } else if (node.type === 'ObjectProperty') {
      name = keyName(node.key);
      valueNode = node.value;
    } else if (node.type === 'AssignmentExpression') {
      name = memberPath(node.left);
      valueNode = node.right;
    }
    if (name && valueNode && SECRET_NAME.test(name.split('.').pop())) {
      let literal = null;
      if (valueNode.type === 'StringLiteral') literal = valueNode;
      else if (valueNode.type === 'LogicalExpression' && valueNode.right.type === 'StringLiteral' && readsEnv(valueNode.left)) literal = valueNode.right;
      if (literal && literal.value.length >= 8 && !PLACEHOLDER.test(literal.value)) {
        const fallback = literal !== valueNode;
        report('hardcoded-credentials', node, {
          message: fallback
            ? `${name} falls back to a hardcoded secret when the env var is missing. The secret is in git history, and a misconfigured deploy silently runs on the baked-in account.`
            : `${name} is a hardcoded secret.`,
        });
      }
    }
    // Buffer.from("id:secret") / btoa("id:secret")
    if (node.type === 'CallExpression' && /^(Buffer\.from|btoa)$/.test(memberPath(node.callee) || '')) {
      const s = node.arguments[0]?.type === 'StringLiteral' ? node.arguments[0].value : null;
      if (s && /^[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{8,}$/.test(s)) {
        report('hardcoded-credentials', node, { message: 'A literal client-id:secret pair is base64-encoded for Basic auth.' });
      }
    }
    return true;
  });
}
