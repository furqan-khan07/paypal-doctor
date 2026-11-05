// hardcoded-environment + hardcoded-credentials
import { walk, stringValue, keyName, memberPath, enclosingFunction } from '../ast.js';

const SANDBOX_HOST = /\bapi(-m)?\.sandbox\.paypal\.com\b/;
const LIVE_HOST = /\bapi(-m)?\.paypal\.com\b/;
const BARE_HOST = /^api(-m)?\.(sandbox\.)?paypal\.com$/;
const CLIENT_SECRET_NAME = /(client_?secret|^secret$|secret_?key|api_?secret|app_?secret)/i;
const ANY_SECRET_NAME = /(secret|password|passwd)/i;
const PLACEHOLDER = /^(your[-_ ]|<|x{3,}|placeholder|changeme|replace|todo|\*+$|\$\{)/i;
const FAKE_VALUE = /\b(fake|mock|dummy|example|placeholder|changeme|test)\b/i;
const PAYPAL_FILE = /paypal-rest-sdk|checkout-server-sdk|paypal-server-sdk|api(-m)?\.(sandbox\.)?paypal\.com/;

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

function inSdkEnvSwitch(ancestors) {
  // cond ? Environment.Production : Environment.Sandbox
  for (let i = ancestors.length - 1; i >= Math.max(0, ancestors.length - 3); i--) {
    const a = ancestors[i];
    if (a.type === 'ConditionalExpression' || a.type === 'LogicalExpression') return true;
    if (a.type === 'ObjectExpression' && a.properties.length > 1) {
      const vals = a.properties.map((p) => memberPath(p.value) || '').join(' ');
      if (/Environment\.Sandbox/.test(vals) && /Environment\.Production/.test(vals)) return true;
    }
  }
  return false;
}

// getSetting('paypalEnvironment', 'https://api-m.sandbox.paypal.com')
function isConfigDefault(node, parent) {
  return parent?.type === 'CallExpression' && parent.arguments.includes(node) && parent.arguments[0] !== node &&
    /config|setting|env|option/i.test(memberPath(parent.callee) || '');
}

// A host used to recognise a URL, not to call it: href.startsWith(HOST), certUrl.replace(HOST, '')...
function usedOnlyToParse(node, parent, ancestors, code) {
  if (parent?.type === 'CallExpression' && /\.(startsWith|includes|indexOf|replace|match|endsWith)$/.test(memberPath(parent.callee) || '')) return true;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    const fn = enclosingFunction(ancestors);
    const scope = code.slice((fn ?? { start: 0 }).start, (fn ?? { end: code.length }).end);
    const name = parent.id.name;
    const uses = [...scope.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length - 1;
    const parsing = [...scope.matchAll(new RegExp(`\\.(startsWith|includes|indexOf|replace|match|endsWith)\\(\\s*${name}\\b`, 'g'))].length;
    return uses > 0 && uses === parsing;
  }
  return false;
}

// getConfig(...) || ...; return 'https://api-m.sandbox...' as the last-resort default.
function inConfigReader(ancestors, code) {
  const fn = enclosingFunction(ancestors);
  return !!fn && /\b(getConfig|getSetting|process\.env|config\.|settings?\b)/.test(code.slice(fn.start, fn.end));
}

// `paypal: { client_secret: ... }` -> "paypal.client_secret"
function nameChain(ancestors, own) {
  const names = [];
  for (const a of ancestors) {
    if (a.type === 'ObjectProperty') names.push(keyName(a.key));
    if (a.type === 'VariableDeclarator' && a.id.type === 'Identifier') names.push(a.id.name);
  }
  names.push(own);
  return names.filter(Boolean).join('.');
}

export function detectHardcoded(ctx) {
  const { ast, report, isClient, code, file } = ctx;
  let reportedEnv = false;
  const usesServerSdk = /@paypal\/paypal-server-sdk/.test(code);
  // A file that names both hosts is choosing between them.
  const knowsBothHosts = SANDBOX_HOST.test(code) && LIVE_HOST.test(code.replace(new RegExp(SANDBOX_HOST.source, 'g'), ''));
  const paypalFile = /paypal/i.test(file) || PAYPAL_FILE.test(code);

  walk(ast, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];

    // ---- @paypal/paypal-server-sdk: environment: Environment.Sandbox ----
    if (usesServerSdk && !reportedEnv && node.type === 'MemberExpression' && !node.computed &&
        node.object.type === 'Identifier' && node.object.name === 'Environment' && ['Sandbox', 'Production'].includes(node.property.name)) {
      if (!inSdkEnvSwitch(ancestors)) {
        reportedEnv = true;
        report('hardcoded-environment', node, {
          message: `The SDK client is pinned to Environment.${node.property.name}. Switching environments means editing code${node.property.name === 'Sandbox' ? ', and a production deploy would keep talking to the sandbox' : ''}.`,
        });
      }
    }

    // ---- environment host literals ----
    if (!reportedEnv && !knowsBothHosts && (node.type === 'StringLiteral' || node.type === 'TemplateLiteral')) {
      const s = stringValue(node) || '';
      const isSandbox = SANDBOX_HOST.test(s);
      const isLive = !isSandbox && LIVE_HOST.test(s);
      const isUrl = /https?:\/\//.test(s);
      const bareHostProp = parent?.type === 'ObjectProperty' && /^host(name)?$/i.test(keyName(parent.key) || '') && BARE_HOST.test(s);
      if ((isSandbox || isLive) && (isUrl || bareHostProp) && !/\/sdk\/js/.test(s) && !/www\.paypal/.test(s) && !/\/notifications\/certs/.test(s)) {
        const insideUrlBuild = parent?.type === 'TemplateLiteral' || parent?.type === 'BinaryExpression';
        const exempt = envFallback(node, parent) || inEnvSwitch(ancestors) || isConfigDefault(node, parent) ||
          usedOnlyToParse(node, parent, ancestors, code) || inConfigReader(ancestors, code) || (insideUrlBuild && envFallback(parent, ancestors[ancestors.length - 2]));
        if (!exempt) {
          reportedEnv = true;
          report('hardcoded-environment', node, {
            message: `The ${isSandbox ? 'sandbox' : 'LIVE'} API host is hardcoded (${s.match(/https?:\/\/[^/'"`\s$]+/)?.[0] || s}). Switching environments means editing code${isSandbox ? ' - and shipping this to production would send real buyers to the sandbox' : ''}.`,
          });
        }
      }
    }

    // ---- PayPal secret literals ----
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
    if (name && valueNode) {
      const own = name.split('.').pop();
      const chain = nameChain(ancestors, name);
      const namedPayPal = /paypal/i.test(chain) && ANY_SECRET_NAME.test(own);
      // In a PayPal file an unqualified client secret counts, but not one filed
      // under another provider: { facebook: { clientSecret: ... } }.
      const holder = [...ancestors].reverse().find((a) => a.type === 'ObjectProperty');
      const holderKey = holder ? keyName(holder.key) || '' : '';
      const otherProvider = holderKey && !/paypal|credential|auth|oauth|config|option|client|env|setting/i.test(holderKey);
      if (namedPayPal || (paypalFile && !otherProvider && CLIENT_SECRET_NAME.test(own))) {
        let literal = null;
        if (valueNode.type === 'StringLiteral') literal = valueNode;
        else if (valueNode.type === 'LogicalExpression' && valueNode.right.type === 'StringLiteral' && readsEnv(valueNode.left)) literal = valueNode.right;
        if (literal && literal.value.length >= 8 && !/\s/.test(literal.value) && !PLACEHOLDER.test(literal.value) && !FAKE_VALUE.test(literal.value)) {
          const fallback = literal !== valueNode;
          report('hardcoded-credentials', node, {
            message: fallback
              ? `${name} falls back to a hardcoded secret when the env var is missing. The secret is in git history, and a misconfigured deploy silently runs on the baked-in account.`
              : `${name} is a hardcoded secret.`,
          });
        }
      }
    }
    // Buffer.from("id:secret") / btoa("id:secret")
    if (paypalFile && node.type === 'CallExpression' && /^(Buffer\.from|btoa)$/.test(memberPath(node.callee) || '')) {
      const s = node.arguments[0]?.type === 'StringLiteral' ? node.arguments[0].value : null;
      if (s && /^[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{8,}$/.test(s)) {
        report('hardcoded-credentials', node, { message: 'A literal client-id:secret pair is base64-encoded for Basic auth.' });
      }
    }
    return true;
  });
}
