// deprecated-v1-payments + deprecated-sdk
import { walk, stringValue } from '../ast.js';

const DEPRECATED_SDKS = {
  'paypal-rest-sdk': 'paypal-rest-sdk is deprecated on npm; PayPal points to @paypal/paypal-server-sdk.',
  '@paypal/checkout-server-sdk': '@paypal/checkout-server-sdk is deprecated on npm; PayPal points to @paypal/paypal-server-sdk.',
};

// The resources PayPal's Payments v1 reference marks deprecated. /v1/payments/payouts
// is the current Payouts API and other gateways (MercadoPago, Getnet...) have their
// own /v1/payments paths, so neither the path alone nor "v1" is enough.
const V1_DEPRECATED = /\/v1\/payments\/(payment|sale|authorization|orders|capture|refund)\b/;

export function detectDeprecated(ctx) {
  const { ast, report, paypalFile } = ctx;
  const seenLines = new Set();
  walk(ast, (node) => {
    if (paypalFile && (node.type === 'StringLiteral' || node.type === 'TemplateLiteral')) {
      const s = stringValue(node);
      if (s && V1_DEPRECATED.test(s)) {
        // A long template can hold a whole generated file: point at the line itself.
        const raw = ctx.code.slice(node.start, node.end);
        const at = raw.search(V1_DEPRECATED);
        const line = node.loc.start.line + (at === -1 ? 0 : raw.slice(0, at).split('\n').length - 1);
        if (seenLines.has(line)) return;
        seenLines.add(line);
        const endpoint = s.match(/\/v1\/payments\/[^\s'"`,)]*/)?.[0] || '/v1/payments';
        ctx.reportAt('deprecated-v1-payments', line, {
          message: `Calls the deprecated v1 Payments API (${endpoint}). PayPal marks /v1/payments as deprecated; use the v2 equivalent.`,
        });
      }
    }
    if (node.type === 'ImportDeclaration' && DEPRECATED_SDKS[node.source.value]) {
      report('deprecated-sdk', node, { message: DEPRECATED_SDKS[node.source.value] });
    }
    if (
      node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' &&
      node.arguments[0]?.type === 'StringLiteral' && DEPRECATED_SDKS[node.arguments[0].value]
    ) {
      report('deprecated-sdk', node, { message: DEPRECATED_SDKS[node.arguments[0].value] });
    }
  });
}

// package.json is JSON, not JS, so it gets its own tiny pass.
export function detectDeprecatedPackageJson(ctx) {
  const { code, reportAt } = ctx;
  let pkg;
  try {
    pkg = JSON.parse(code);
  } catch {
    return;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  for (const name of Object.keys(DEPRECATED_SDKS)) {
    if (!deps[name]) continue;
    const idx = code.indexOf(`"${name}"`);
    const line = idx === -1 ? 1 : code.slice(0, idx).split('\n').length;
    reportAt('deprecated-sdk', line, { message: `${DEPRECATED_SDKS[name]} (declared in package.json as ${deps[name]})` });
  }
}
