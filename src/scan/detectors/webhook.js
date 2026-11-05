// webhook-unverified: find PayPal webhook handlers and check they verify the
// signature before acting on the event. Most apps have other webhooks too
// (Stripe, GitHub...), so a handler only counts if it's visibly about PayPal.
import { walk, routeOf, memberPath, FUNCTION_TYPES } from '../ast.js';

const VERIFY_MARKERS = /verify-webhook-signature|(verify|validate)\w*(webhook|signature)|(webhook|signature)\w*verif|createVerify|crypto\.verify|crc32|verification_status|paypal-transmission-sig|transmission_sig/i;
const PAYPAL_MARKERS = /paypal|PAYMENT\.CAPTURE|CHECKOUT\.ORDER|PAYMENT\.SALE|BILLING\.SUBSCRIPTION/i;
const OTHER_PROVIDER = /stripe|razorpay|paddle|lemon_?squeezy|mollie|adyen|braintree|square|github|gitlab|slack|discord|telegram|whatsapp|twilio|clerk|shopify|resend|sendgrid|mercadopago|nowpayments/i;
const EVENT_MARKERS = /event_type|eventType|resource_type|PAYMENT\.CAPTURE|CHECKOUT\.ORDER/;
const HELPER_DEPTH = 4;
const MAX_HELPERS = 60;

// The text of the handler plus the repo functions it calls (a few levels deep).
// `delegated` means it hands the request headers to something outside the repo,
// such as a provider SDK, which we can't see into.
function reachableText(index, handler, code, file) {
  const seen = new Set([handler]);
  // sdk.webhooks.setup() isn't a call to the app's own setup(): only follow plain
  // calls, this.x(), this.service.x() and calls on a locally imported module.
  const followable = (callee, callerFile) => {
    if (callee.type === 'Identifier') return true;
    let root = callee.object;
    while (root?.type === 'MemberExpression' || root?.type === 'OptionalMemberExpression') root = root.object;
    if (root?.type === 'ThisExpression') return true;
    const direct = callee.object?.type === 'Identifier';
    return direct && /^(\.|@\/|~\/|#)/.test(index.imports.get(callerFile)?.get(callee.object.name) || '');
  };
  const parts = [code.slice(handler.start, handler.end)];
  let delegated = false;
  const visit = (fnNode, fnCode, fnFile, depth) => {
    walk(fnNode, (n) => {
      if (n.type !== 'CallExpression' && n.type !== 'OptionalCallExpression') return true;
      const c = n.callee;
      const name = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') && !c.computed ? c.property.name : null;
      const targets = name && followable(c, fnFile) ? index.functions.get(name) || [] : [];
      if (targets.length === 0) {
        const args = n.arguments.map((a) => fnCode.slice(a.start, a.end)).join(' ');
        if (/headers/i.test(args)) delegated = true;
        return true;
      }
      if (depth >= HELPER_DEPTH) return true;
      for (const t of targets) {
        if (seen.has(t.node) || seen.size > MAX_HELPERS) continue;
        seen.add(t.node);
        const tCode = index.files.get(t.file).code;
        parts.push(tCode.slice(t.node.start, t.node.end));
        visit(t.node, tCode, t.file, depth + 1);
      }
      return true;
    });
  };
  visit(handler, code, file, 1);
  return { text: parts.join('\n'), delegated };
}

export function detectWebhook(ctx) {
  const { ast, code, file, index, report } = ctx;
  const handlers = [];

  walk(ast, (node) => {
    // app.post('/api/paypal/webhook', handler)
    const route = routeOf(node);
    // this.axios.post('/v1/notifications/webhooks', body) is a call out, not a route.
    const outgoing = route && (/axios|http|client|fetch|got|request|superagent/i.test(memberPath(node.callee.object) || '') || /^\/v[12]\/(notifications|payments|checkout|oauth2)\b/.test(route.path));
    if (route && route.method !== 'GET' && !outgoing) {
      // The last argument: an inline function, a local name, or controller.method
      // (usually defined in another file).
      const fnArgs = node.arguments.slice(1).filter((a) => FUNCTION_TYPES.has(a.type) || a.type === 'Identifier' || a.type === 'MemberExpression');
      const handler = fnArgs[fnArgs.length - 1];
      if (handler) {
        let resolved = FUNCTION_TYPES.has(handler.type) ? { node: handler, file } : null;
        if (!resolved) {
          const name = handler.type === 'Identifier' ? handler.name : handler.property?.name;
          const candidates = index.functions.get(name) || [];
          resolved = candidates.find((f) => f.file === file) || candidates[0] || null;
        }
        if (resolved) {
          const hCode = index.files.get(resolved.file)?.code || code;
          const text = hCode.slice(resolved.node.start, resolved.node.end);
          if (/webhook|notify|ipn|paypal\/events/i.test(route.path) || EVENT_MARKERS.test(text)) {
            handlers.push({ node: resolved.node, code: hCode, file: resolved.file, at: node, label: `${route.method} ${route.path}`, hint: `${route.path} ${resolved.file}` });
          }
        }
      }
    }
    // NestJS: @Post('webhook') on a controller method
    if (node.type === 'ClassMethod' && node.decorators?.length) {
      for (const d of node.decorators) {
        const call = d.expression;
        if (call?.type === 'CallExpression' && call.callee.name === 'Post') {
          const path = call.arguments[0]?.type === 'StringLiteral' ? call.arguments[0].value : '';
          if (/webhook|notify|ipn/i.test(path)) handlers.push({ node, code, file, at: node, label: `POST ${path} (${file})`, hint: `${path} ${file}` });
        }
      }
    }
    // Next.js / Hono style: export async function POST(req) in a webhook route file
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'POST' && /webhook/i.test(file)) {
      handlers.push({ node, code, file, at: node, label: `POST ${file}`, hint: file });
    }
    return true;
  });

  for (const h of handlers) {
    const { text, delegated } = reachableText(index, h.node, h.code, h.file);
    // A shared helper can mention PayPal, but a handler visibly about Stripe isn't about PayPal.
    const own = h.code.slice(h.node.start, h.node.end);
    const namesPayPal = PAYPAL_MARKERS.test(h.hint) || PAYPAL_MARKERS.test(file) || PAYPAL_MARKERS.test(own);
    if (!namesPayPal && OTHER_PROVIDER.test(`${h.hint} ${own}`)) continue;
    if (!namesPayPal && !PAYPAL_MARKERS.test(text)) continue;
    if (!VERIFY_MARKERS.test(text)) {
      if (delegated) continue;
      report('webhook-unverified', h.at, {
        message: `${h.label} acts on the webhook body without verifying the PayPal signature. A forged PAYMENT.CAPTURE.COMPLETED posted to this URL is treated as real.`,
        symbol: h.label,
      });
    } else if (/verify-webhook-signature/i.test(text) && !/SUCCESS/.test(text)) {
      report('webhook-unverified', h.at, {
        message: `${h.label} calls verify-webhook-signature but never checks verification_status === "SUCCESS", so a FAILURE result is ignored.`,
        symbol: h.label,
      });
    }
  }
}

