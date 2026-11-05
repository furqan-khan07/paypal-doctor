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
        const line = node.loc.start.line;
        if (seenLines.has(line)) return;
        seenLines.add(line);
        const endpoint = s.replace(/^.*?(\/v1\/payments\/)/, '$1');
        report('deprecated-v1-payments', node, {
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
