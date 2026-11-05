// Detectors that look at how the app talks to Orders v2 / Payments v2:
// missing-request-id, capture-status-unchecked, client-supplied-amount,
// amount-formatting.
import { walk, httpCall, stringValue, objectProp, enclosingFunction, memberPath } from '../ast.js';
import { clientPriceTaint, amountKind } from '../flow.js';
import { ZERO_DECIMAL_CURRENCIES, PAYPAL_CURRENCIES } from '../../rules.js';

const MONEY_POSTS = [
  { re: /\/v2\/checkout\/orders\/?$/, op: 'create order' },
  { re: /\/v2\/checkout\/orders\/[^/]+\/capture\/?$/, op: 'capture order' },
  { re: /\/v2\/checkout\/orders\/[^/]+\/authorize\/?$/, op: 'authorize order' },
  { re: /\/v2\/payments\/authorizations\/[^/]+\/(capture|reauthorize|void)\/?$/, op: 'authorization $1' },
  { re: /\/v2\/payments\/captures\/[^/]+\/refund\/?$/, op: 'refund capture' },
];

const CAPTURE_URL = /\/v2\/checkout\/orders\/[^/]+\/capture\/?$|\/v2\/payments\/authorizations\/[^/]+\/capture\/?$/;
const CAPTURE_STATUS_CHECK = [
  /captures(\?\.)?\s*\[\s*\d+\s*\]\s*(\?\.|\.)\s*status\b/,
  // capture.status, captureDetails.status - but not captureResponse.status (HTTP) or captureResult.status (the order)
  /\bcaptures?(?!\w*res)\w*(\?\.|\.)\s*status\b/i,
  /captures(\?\.)?\.(find|filter|every|some|map|forEach)\([^;]*\bstatus\b/,
  // const c = ...captures?.[0]; ... c.status
  /\b(\w+)\s*=\s*[^;\n]*captures(\?\.)?\s*\[\s*\d+\s*\][^;\n]*[\s\S]*?\b\1(\?\.|\.)\s*status\b/,
];
// Evidence the code decides "we got paid". Without it the function is a wrapper or
// relays the capture to its caller or the browser, so there's nothing to flag yet.
const PAID_EVIDENCE = [
  /\.status\s*(===?|=)\s*["'`]COMPLETED["'`]/,
  /["'`](paid|captured|succeeded)["'`]/i,
  /\b(mark\w*(Paid|Complete)\w*|setPaid|isPaid|is_paid|paidAt|paid_at|fulfil\w*)\b/i,
];
const PER_CALL_ID = /randomUUID|uuid|nanoid|Date\.now|Math\.random|new Date/i;
const ORDER_CAPTURE_URL = /\/v2\/checkout\/orders\/[^/]+\/capture\/?$/;
const PER_CALL_MESSAGE = 'The capture call generates a new PayPal-Request-Id every time it runs, so a retry after a lost response is not recognised as a retry and gets ORDER_ALREADY_CAPTURED. Derive the id from the order id.';

function urlOf(call, index, ancestors) {
  let node = call.urlNode;
  if (node?.type === 'Identifier') node = index.lookup(node.name, ancestors)?.binding?.init ?? node;
  return stringValue(node) ?? memberPath(node) ?? '';
}

// `${base}/v2/checkout/orders` where base is plainly some other host (leftover copy-paste).
function baseIsPayPalOrUnknown(call, index, ancestors) {
  let node = call.urlNode;
  if (node?.type === 'Identifier') node = index.lookup(node.name, ancestors)?.binding?.init ?? node;
  const first = node?.type === 'TemplateLiteral' ? node.expressions[0] : null;
  if (first?.type !== 'Identifier') return true;
  const init = index.lookup(first.name, ancestors)?.binding?.init;
  const host = init?.type === 'StringLiteral' && /^https?:\/\//.test(init.value) ? init.value : null;
  return !host || /paypal/i.test(host);
}

// paypalRequest(creds, `/v2/checkout/orders/${id}/capture`, {...}) or this.makeRequest(path, 'POST').
// The wrapper may add the header itself, so look inside it too.
function wrapperCall(ctx, node, ancestors) {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return null;
  if (httpCall(node)) return null;
  const c = node.callee;
  const name = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') && !c.computed ? c.property.name : null;
  if (!name) return null;
  let url = null;
  for (const a of node.arguments) {
    const s = stringValue(a);
    if (s && (MONEY_POSTS.some((m) => m.re.test(s)))) url = s;
  }
  if (!url) return null;
  const { index, code } = ctx;
  const fn = enclosingFunction(ancestors);
  const argsText = node.arguments.map((a) => code.slice(a.start, a.end)).join(' ');
  const scope = fn ? code.slice(fn.start, fn.end) : '';
  const wrappers = (index.functions.get(name) || []).map((f) => index.files.get(f.file).code.slice(f.node.start, f.node.end)).join('\n');
  const hasId = /paypal-request-id|paypalRequestId|idempotency/i.test(`${argsText}\n${scope}\n${wrappers}`);
  return { url, hasId };
}

function headersHaveRequestId(index, file, headersNode, ancestors) {
  // returns 'present' | 'constant' | 'missing' | 'unknown'
  let obj = headersNode;
  if (obj?.type === 'Identifier') {
    const found = index.lookup(obj.name, ancestors);
    obj = found?.binding?.init ?? null;
  }
  // new Headers({...}), or const headers = await client.getHeaders() where the helper may add it.
  const made = obj?.type === 'AwaitExpression' ? obj.argument : obj;
  if (made?.type === 'NewExpression' && memberPath(made.callee) === 'Headers') {
    obj = made.arguments[0];
  } else if (made?.type === 'CallExpression') {
    const name = memberPath(made.callee)?.split('.').pop();
    const body = (index.functions.get(name) || []).map((f) => index.files.get(f.file).code.slice(f.node.start, f.node.end)).join('\n');
    return /paypal-request-id/i.test(body) ? 'present' : 'unknown';
  }
  if (!obj || obj.type !== 'ObjectExpression') return 'unknown';
  const prop = objectProp(obj, 'paypal-request-id', { ci: true });
  if (prop) {
    if (prop.value?.type === 'StringLiteral') return 'constant';
    const text = index.files.get(file)?.code.slice(prop.value.start, prop.value.end) || '';
    return PER_CALL_ID.test(text) ? 'per-call' : 'present';
  }
  if (obj.properties.some((p) => p.type === 'SpreadElement')) return 'unknown';
  return 'missing';
}

export function detectPayments(ctx) {
  const { ast, code, file, index, report } = ctx;
  // The SDK can be imported in another file, so a *Controller receiver in a PayPal file counts too.
  const mentionsPayPal = /paypal/i.test(file) || /paypal/i.test(code);
  const usesServerSdk = /@paypal\/paypal-server-sdk/.test(code);

  walk(ast, (node, ancestors) => {
    // ---- REST calls made with fetch/axios/got ----
    const call = httpCall(node);
    if (call && (call.method === 'POST' || call.method === '?')) {
      const url = urlOf(call, index, ancestors);
      const money = baseIsPayPalOrUnknown(call, index, ancestors) ? MONEY_POSTS.find((m) => m.re.test(url)) : null;
      if (money) {
        const op = money.op.replace('$1', url.match(money.re)?.[1] || '');
        let state = headersHaveRequestId(index, file, call.headersNode, ancestors);
        if (state === 'unknown') {
          const fn = enclosingFunction(ancestors);
          const scopeText = fn ? code.slice(fn.start, fn.end) : code;
          state = /paypal-request-id/i.test(scopeText) ? 'present' : 'missing';
        }
        if (state === 'missing') {
          report('missing-request-id', node, { message: `The ${op} call sends no PayPal-Request-Id header, so a retry after a lost response is processed as a brand-new request.` });
        } else if (state === 'constant') {
          report('missing-request-id', node, { message: `The ${op} call sends a constant PayPal-Request-Id. Every request then looks like a retry of the first one.` });
        } else if (state === 'per-call' && ORDER_CAPTURE_URL.test(url)) {
          report('missing-request-id', node, { message: PER_CALL_MESSAGE });
        }
      }
      if (money && CAPTURE_URL.test(url)) checkCaptureStatus(ctx, node, ancestors);
    }

    // ---- the app's own request helper ----
    const wrapped = wrapperCall(ctx, node, ancestors);
    if (wrapped) {
      const money = MONEY_POSTS.find((m) => m.re.test(wrapped.url));
      if (money && !wrapped.hasId) {
        const op = money.op.replace('$1', wrapped.url.match(money.re)?.[1] || '');
        report('missing-request-id', node, { message: `The ${op} call sends no PayPal-Request-Id header, so a retry after a lost response is processed as a brand-new request.` });
      }
      if (CAPTURE_URL.test(wrapped.url)) checkCaptureStatus(ctx, node, ancestors);
    }

    // ---- @paypal/paypal-server-sdk controller calls ----
    const receiver = node.type === 'CallExpression' && node.callee.type === 'MemberExpression' ? memberPath(node.callee.object) || '' : '';
    if ((usesServerSdk || (mentionsPayPal && /controller/i.test(receiver))) && node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const method = node.callee.property?.name;
      if (['createOrder', 'captureOrder', 'authorizeOrder', 'refundCapturedPayment', 'captureAuthorizedPayment'].includes(method)) {
        let arg = node.arguments[0];
        if (arg?.type === 'Identifier') arg = index.lookup(arg.name, ancestors)?.binding?.init ?? arg;
        if (arg?.type === 'TSAsExpression') arg = arg.expression;
        const idProp = arg?.type === 'ObjectExpression' ? objectProp(arg, 'paypalRequestId') : null;
        if (arg?.type === 'ObjectExpression' && !idProp) {
          report('missing-request-id', node, { message: `${method}() is called without paypalRequestId, so retries are not idempotent.` });
        } else if (idProp && method === 'captureOrder' && PER_CALL_ID.test(code.slice(idProp.value.start, idProp.value.end))) {
          report('missing-request-id', node, { message: PER_CALL_MESSAGE });
        }
        if (method === 'captureOrder') checkCaptureStatus(ctx, node, ancestors);
      }
    }

    // ---- order payloads: { intent, purchase_units: [...] } ----
    if (node.type === 'ObjectExpression') {
      const pu = objectProp(node, 'purchase_units') || objectProp(node, 'purchaseUnits');
      if (pu && pu.value?.type === 'ArrayExpression') {
        for (const unit of pu.value.elements) {
          if (unit?.type === 'ObjectExpression') checkPurchaseUnit(ctx, unit, [...ancestors, node, pu, pu.value]);
        }
      }
    }
  });
}

function checkPurchaseUnit(ctx, unit, ancestors) {
  const { index, file, report } = ctx;
  const amount = objectProp(unit, 'amount')?.value;
  const targets = [];
  if (amount?.type === 'ObjectExpression') targets.push({ obj: amount, where: 'amount' });
  const items = objectProp(unit, 'items')?.value;
  if (items?.type === 'ArrayExpression') {
    for (const it of items.elements) {
      const ua = it?.type === 'ObjectExpression' ? objectProp(it, 'unit_amount')?.value || objectProp(it, 'unitAmount')?.value : null;
      if (ua?.type === 'ObjectExpression') targets.push({ obj: ua, where: 'items[].unit_amount' });
    }
  }
  for (const { obj, where } of targets) {
    const anc = [...ancestors, unit, obj];
    const valueProp = objectProp(obj, 'value');
    const currencyProp = objectProp(obj, 'currency_code') || objectProp(obj, 'currencyCode');
    const currency = currencyProp?.value?.type === 'StringLiteral' ? currencyProp.value.value.toUpperCase() : null;
    if (currency && !PAYPAL_CURRENCIES.has(currency)) {
      report('amount-formatting', currencyProp, { message: `currency_code "${currency}" is not one of the currencies PayPal's REST APIs accept.` });
    }
    if (!valueProp) continue;
    const value = valueProp.value;

    // client-supplied-amount: where does the number come from?
    const taint = clientPriceTaint(index, file, value, anc);
    if (taint) {
      const origin = taint.steps[0];
      const chain = [...taint.steps.map((s) => `${s.text.trim()} (${s.file}:${s.line})`), `${where}.value (${file}:${value.loc.start.line})`].join(' -> ');
      ctx.reportAtLocation('client-supplied-amount', origin.file, origin.line, {
        message: `The ${where}.value sent to PayPal (${file}:${value.loc.start.line}) is computed from a price the browser sent. Data flow: ${chain}.`,
        related: [{ file, line: value.loc.start.line }],
      });
    }

    // amount-formatting
    const kind = amountKind(index, file, value, anc);
    if (kind.kind === 'float' || kind.kind === 'float-str') {
      const what = kind.kind === 'float' ? 'a JavaScript number' : 'a stringified float';
      ctx.reportAtLocation('amount-formatting', file, value.loc.start.line, {
        message: `${where}.value is ${what} built from ${kind.why || 'number math'}${kind.via ? ` (via ${kind.via.file}:${kind.via.line})` : ''}. Carts like 3 x $0.10 produce "0.30000000000000004", which PayPal rejects with DECIMAL_PRECISION.`,
        related: kind.via ? [{ file: kind.via.file, line: kind.via.line }] : [],
      });
    } else if (kind.kind.startsWith('fixed:')) {
      const digits = Number(kind.kind.split(':')[1]);
      if (currency && ZERO_DECIMAL_CURRENCIES.has(currency) && digits > 0) {
        ctx.reportAtLocation('amount-formatting', file, value.loc.start.line, {
          message: `${currency} is a zero-decimal currency but the value is formatted with toFixed(${digits}).`,
        });
      }
    } else if (kind.kind === 'string' && kind.literal && currency) {
      const decimals = (kind.literal.split('.')[1] || '').length;
      if ((ZERO_DECIMAL_CURRENCIES.has(currency) && decimals > 0) || decimals > 2) {
        report('amount-formatting', value, { message: `"${kind.literal}" has ${decimals} decimals, which ${currency} does not support.` });
      }
    }
  }
}

function checkCaptureStatus(ctx, callNode, ancestors) {
  const { index, file, code } = ctx;
  const fn = enclosingFunction(ancestors);
  const scopes = [{ file, line: callNode.loc.start.line, text: code.slice((fn ?? ctx.ast).start, (fn ?? ctx.ast).end) }];
  if (fn) {
    const fnAncestors = ancestors.slice(0, ancestors.lastIndexOf(fn));
    for (const caller of index.callersOf(fn, fnAncestors)) {
      const callerFn = enclosingFunction(caller.ancestors);
      const callerFile = index.files.get(caller.file);
      const scopeNode = callerFn ?? callerFile.ast;
      scopes.push({ file: caller.file, line: caller.node.loc.start.line, text: callerFile.code.slice(scopeNode.start, scopeNode.end) });
    }
  }
  const texts = scopes.map((s) => s.text);
  if (texts.some((t) => CAPTURE_STATUS_CHECK.some((re) => re.test(t)))) return;
  const deciding = scopes.filter((s) => PAID_EVIDENCE.some((re) => re.test(s.text)));
  if (deciding.length === 0) return;
  const reportAt = deciding[deciding.length - 1];
  const orderLevel = texts.some((t) => /\.status\s*(===?|=)\s*["'`]COMPLETED["'`]/.test(t));
  ctx.reportAtLocation('capture-status-unchecked', reportAt.file, reportAt.line, {
    message: orderLevel
      ? 'The order is marked paid from the order-level status (=== "COMPLETED") without reading purchase_units[0].payments.captures[0].status. A PENDING or DECLINED capture still comes back with order status COMPLETED.'
      : 'The payment is treated as done without checking purchase_units[0].payments.captures[0].status (COMPLETED vs PENDING / DECLINED).',
    related: reportAt.file === file && reportAt.line === callNode.loc.start.line ? [] : [{ file, line: callNode.loc.start.line }],
  });
}
