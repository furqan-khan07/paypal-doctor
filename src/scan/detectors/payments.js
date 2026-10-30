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
  /\bcaptures?\w*(\?\.|\.)\s*status\b/i,
  /captures(\?\.)?\.(find|filter|every|some|map|forEach)\([^;]*\bstatus\b/,
];

function urlOf(call) {
  return stringValue(call.urlNode) ?? memberPath(call.urlNode) ?? '';
}

function headersHaveRequestId(index, file, headersNode, ancestors) {
  // returns 'present' | 'constant' | 'missing' | 'unknown'
  let obj = headersNode;
  if (obj?.type === 'Identifier') {
    const found = index.lookup(obj.name, ancestors);
    obj = found?.binding?.init ?? null;
  }
  if (obj?.type === 'CallExpression' && /Headers$/.test(memberPath(obj.callee) || '')) obj = obj.arguments[0];
  if (!obj || obj.type !== 'ObjectExpression') return 'unknown';
  const prop = objectProp(obj, 'paypal-request-id', { ci: true });
  if (prop) return prop.value?.type === 'StringLiteral' ? 'constant' : 'present';
  if (obj.properties.some((p) => p.type === 'SpreadElement')) return 'unknown';
  return 'missing';
}

export function detectPayments(ctx) {
  const { ast, code, file, index, report } = ctx;
  const usesServerSdk = /@paypal\/paypal-server-sdk/.test(code);

  walk(ast, (node, ancestors) => {
    // ---- REST calls made with fetch/axios/got ----
    const call = httpCall(node);
    if (call && (call.method === 'POST' || call.method === '?')) {
      const url = urlOf(call);
      const money = MONEY_POSTS.find((m) => m.re.test(url));
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
        }
      }
      if (CAPTURE_URL.test(url)) checkCaptureStatus(ctx, node, ancestors);
    }

    // ---- @paypal/paypal-server-sdk controller calls ----
    if (usesServerSdk && (node.type === 'CallExpression') && node.callee.type === 'MemberExpression') {
      const method = node.callee.property?.name;
      if (['createOrder', 'captureOrder', 'authorizeOrder', 'refundCapturedPayment', 'captureAuthorizedPayment'].includes(method)) {
        const arg = node.arguments[0];
        if (arg?.type === 'ObjectExpression' && !objectProp(arg, 'paypalRequestId')) {
          report('missing-request-id', node, { message: `${method}() is called without paypalRequestId, so retries are not idempotent.` });
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
  const scopes = [{ file, node: fn ?? ctx.ast, code }];
  let reportAt = { file, line: callNode.loc.start.line };
  if (fn) {
    const fnAncestors = ancestors.slice(0, ancestors.lastIndexOf(fn));
    for (const caller of index.callersOf(fn, fnAncestors)) {
      const callerFn = enclosingFunction(caller.ancestors);
      const callerCode = index.files.get(caller.file).code;
      scopes.push({ file: caller.file, node: callerFn ?? index.files.get(caller.file).ast, code: callerCode });
      reportAt = { file: caller.file, line: caller.node.loc.start.line };
    }
  }
  const texts = scopes.map((s) => s.code.slice(s.node.start, s.node.end));
  if (texts.some((t) => CAPTURE_STATUS_CHECK.some((re) => re.test(t)))) return;
  const orderLevel = texts.some((t) => /\.status\s*===?\s*["'`]COMPLETED["'`]/.test(t));
  ctx.reportAtLocation('capture-status-unchecked', reportAt.file, reportAt.line, {
    message: orderLevel
      ? 'The order is marked paid from the order-level status (=== "COMPLETED") without reading purchase_units[0].payments.captures[0].status. A PENDING or DECLINED capture still comes back with order status COMPLETED.'
      : 'The capture result is used without checking purchase_units[0].payments.captures[0].status (COMPLETED vs PENDING / DECLINED).',
    related: reportAt.file === file && reportAt.line === callNode.loc.start.line ? [] : [{ file, line: callNode.loc.start.line }],
  });
}
