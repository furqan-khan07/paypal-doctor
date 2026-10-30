// webhook-unverified: find webhook handlers and check they verify the
// PayPal signature before acting on the event.
import { walk, routeOf, FUNCTION_TYPES } from '../ast.js';

const VERIFY_MARKERS = /verify-webhook-signature|verifyWebhookSignature|createVerify|crypto\.verify|crc32|verification_status/i;
const EVENT_MARKERS = /event_type|eventType|resource_type|PAYMENT\.CAPTURE|CHECKOUT\.ORDER/;

export function detectWebhook(ctx) {
  const { ast, code, file, index, report } = ctx;
  const handlers = [];

  walk(ast, (node, ancestors) => {
    // app.post('/api/paypal/webhook', handler)
    const route = routeOf(node);
    if (route && route.method !== 'GET') {
      const fnArgs = node.arguments.slice(1).filter((a) => FUNCTION_TYPES.has(a.type) || a.type === 'Identifier');
      const handler = fnArgs[fnArgs.length - 1];
      if (handler) {
        const resolved = handler.type === 'Identifier' ? index.functions.get(handler.name)?.find((f) => f.file === file)?.node : handler;
        if (resolved) {
          const text = code.slice(resolved.start, resolved.end);
          if (/webhook|notify|ipn|paypal\/events/i.test(route.path) || EVENT_MARKERS.test(text)) {
            handlers.push({ node: resolved, at: node, label: `${route.method} ${route.path}` });
          }
        }
      }
    }
    // Next.js / Hono style: export async function POST(req) in a webhook route file
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'POST' && /webhook/i.test(file)) {
      handlers.push({ node, at: node, label: `POST ${file}` });
    }
    return true;
  });

  for (const h of handlers) {
    const text = code.slice(h.node.start, h.node.end);
    // follow helper calls made from the handler, one level deep
    const helperText = [];
    walk(h.node, (n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier') {
        for (const f of index.functions.get(n.callee.name) || []) {
          const fc = index.files.get(f.file).code;
          helperText.push(fc.slice(f.node.start, f.node.end));
        }
      }
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed) {
        for (const f of index.functions.get(n.callee.property.name) || []) {
          const fc = index.files.get(f.file).code;
          helperText.push(fc.slice(f.node.start, f.node.end));
        }
      }
      return true;
    });
    const all = [text, ...helperText].join('\n');
    if (!VERIFY_MARKERS.test(all)) {
      report('webhook-unverified', h.at, {
        message: `${h.label} acts on the webhook body without verifying the PayPal signature. A forged PAYMENT.CAPTURE.COMPLETED posted to this URL is treated as real.`,
        symbol: h.label,
      });
    } else if (/verify-webhook-signature|verifyWebhookSignature/i.test(all) && !/SUCCESS/.test(all)) {
      report('webhook-unverified', h.at, {
        message: `${h.label} calls verify-webhook-signature but never checks verification_status === "SUCCESS", so a FAILURE result is ignored.`,
        symbol: h.label,
      });
    }
  }
}

