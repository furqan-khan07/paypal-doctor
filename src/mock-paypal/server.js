// A local stand-in for the parts of the PayPal REST API the probes touch.
// It is not a full emulator: it implements the behaviour the probes rely on
// (validation errors, approval, idempotency, already-captured, card declines,
// negative-testing headers, webhook verification) closely enough that a
// probe that passes here is worth running against the real sandbox.
import http from 'node:http';
import crypto from 'node:crypto';
import { ZERO_DECIMAL_CURRENCIES, PAYPAL_CURRENCIES } from '../rules.js';

export const MOCK_WEBHOOK_ID = 'WH-MOCK-PROBE';
const MOCK_SIGNING_KEY = 'paypal-doctor-mock-signing-key';
const MONEY_RE = /^((-?[0-9]+)|(-?([0-9]+)?[.][0-9]+))$/;

// CRC32 (IEEE), as used in PayPal's self-verification string.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(str) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(str, 'utf8')) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Mock events are "signed" with an HMAC over the same fields PayPal signs.
export function mockSignature({ transmissionId, transmissionTime, webhookId, body }) {
  const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(body)}`;
  return crypto.createHmac('sha256', MOCK_SIGNING_KEY).update(message).digest('base64');
}

const id17 = () => {
  const chars = 'ABCDEFGHJKLMNPRSTUVWXY0123456789';
  let s = '';
  for (const b of crypto.randomBytes(17)) s += chars[b % chars.length];
  return s;
};
const debugId = () => crypto.randomBytes(7).toString('hex');
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function decimalsOf(currency) {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
}
function toMinor(value, currency) {
  const d = decimalsOf(currency);
  const [i, f = ''] = value.split('.');
  return Number(i) * 10 ** d + Number((f + '00').slice(0, d) || 0);
}

class ApiError extends Error {
  constructor(status, name, issue, description, field, value) {
    super(description);
    Object.assign(this, { status, name, issue, description, field, value });
  }
}
const unprocessable = (issue, description, field, value) => new ApiError(422, 'UNPROCESSABLE_ENTITY', issue, description, field, value);
const invalid = (issue, description, field, value) => new ApiError(400, 'INVALID_REQUEST', issue, description, field, value);

const NEGATIVE_CODES = {
  INSTRUMENT_DECLINED: 'The instrument presented was either declined by the processor or bank, or it can\'t be used for this payment.',
  TRANSACTION_REFUSED: 'The request was refused.',
  DUPLICATE_INVOICE_ID: 'Duplicate Invoice ID detected.',
  PAYER_ACTION_REQUIRED: 'Transaction cannot complete successfully, instruct the buyer to return to PayPal.',
  INTERNAL_SERVER_ERROR: 'An internal server error has occurred.',
};

function validateMoney(money, field) {
  if (!money || typeof money !== 'object') throw invalid('MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.', field);
  const { currency_code: cur, value } = money;
  if (typeof cur !== 'string' || cur.length !== 3) throw invalid('MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.', `${field}/currency_code`);
  if (!PAYPAL_CURRENCIES.has(cur)) throw unprocessable('INVALID_CURRENCY_CODE', 'Currency code is invalid or is not currently supported.', `${field}/currency_code`, cur);
  if (typeof value !== 'string' || !MONEY_RE.test(value)) throw invalid('INVALID_PARAMETER_SYNTAX', 'The value of a field does not conform to the expected format.', `${field}/value`, String(value));
  const decimals = (value.split('.')[1] || '').length;
  if (decimals > decimalsOf(cur)) throw unprocessable('DECIMAL_PRECISION', 'If the currency supports decimals, only two decimal place precision is supported.', `${field}/value`, value);
  return toMinor(value, cur);
}

function validateOrder(body) {
  if (!['CAPTURE', 'AUTHORIZE'].includes(body?.intent)) throw invalid('INVALID_PARAMETER_VALUE', 'The value of a field is invalid.', '/intent', String(body?.intent));
  const units = body.purchase_units;
  if (!Array.isArray(units) || units.length === 0) throw invalid('MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.', '/purchase_units');
  units.forEach((u, i) => {
    const field = `/purchase_units/@reference_id=='${u.reference_id || 'default'}'/amount`;
    const total = validateMoney(u.amount, field);
    if (total <= 0) throw unprocessable('CANNOT_BE_ZERO_OR_NEGATIVE', 'Must be greater than zero.', `${field}/value`, u.amount.value);
    const b = u.amount.breakdown;
    if (u.items?.length && !b?.item_total) throw unprocessable('ITEM_TOTAL_REQUIRED', 'If item details are specified (items.unit_amount and items.quantity) corresponding amount.breakdown.item_total is required.', `${field}/breakdown/item_total`);
    if (b) {
      const part = (k) => (b[k] ? validateMoney(b[k], `${field}/breakdown/${k}`) : 0);
      const sum = part('item_total') + part('tax_total') + part('shipping') + part('handling') + part('insurance') - part('shipping_discount') - part('discount');
      if (sum !== total) throw unprocessable('AMOUNT_MISMATCH', 'Should equal item_total + tax_total + shipping + handling + insurance - shipping_discount - discount.', field, u.amount.value);
      if (u.items?.length) {
        const items = u.items.reduce((s, it, j) => s + validateMoney(it.unit_amount, `/purchase_units/${i}/items/${j}/unit_amount`) * Number(it.quantity || 0), 0);
        if (items !== part('item_total')) throw unprocessable('ITEM_TOTAL_MISMATCH', 'Should equal sum of (unit_amount * quantity) across all items for a given purchase_unit.', `${field}/breakdown/item_total/value`, b.item_total.value);
      }
    }
  });
}

export function createMockPayPal({ quiet = true } = {}) {
  const state = {
    tokens: new Map(), // token -> creds fingerprint
    orders: new Map(),
    captures: new Map(),
    refunds: new Map(),
    idempotency: new Map(), // `${op}|${requestId}` -> { status, body }
    webhooks: [{ id: MOCK_WEBHOOK_ID, url: 'https://example.com/paypal-doctor-probe', event_types: [{ name: '*' }] }],
    calls: [],
  };
  let server = null;
  let baseUrl = null;

  const links = (order) => [
    { href: `${baseUrl}/v2/checkout/orders/${order.id}`, rel: 'self', method: 'GET' },
    { href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`, rel: 'approve', method: 'GET' },
    { href: `${baseUrl}/v2/checkout/orders/${order.id}`, rel: 'update', method: 'PATCH' },
    { href: `${baseUrl}/v2/checkout/orders/${order.id}/capture`, rel: 'capture', method: 'POST' },
  ];
  const orderView = (o) => ({
    id: o.id,
    intent: o.intent,
    status: o.status,
    ...(o.payment_source ? { payment_source: o.payment_source } : {}),
    purchase_units: o.purchase_units,
    create_time: o.create_time,
    ...(o.update_time ? { update_time: o.update_time } : {}),
    links: links(o),
  });

  function idempotent(req, op, fn) {
    const rid = req.headers['paypal-request-id'];
    if (rid) {
      const hit = state.idempotency.get(`${op}|${rid}`);
      if (hit) return { ...hit, replayed: true };
    }
    const result = fn();
    if (rid && result.status < 500) state.idempotency.set(`${op}|${rid}`, result);
    return result;
  }

  function negativeTesting(req) {
    const raw = req.headers['paypal-mock-response'];
    if (!raw) return;
    let code;
    try {
      code = JSON.parse(raw).mock_application_codes;
    } catch {
      throw invalid('INVALID_PARAMETER_SYNTAX', 'PayPal-Mock-Response is not valid JSON.', 'PayPal-Mock-Response');
    }
    if (code === 'INTERNAL_SERVER_ERROR') throw new ApiError(500, 'INTERNAL_SERVER_ERROR', code, NEGATIVE_CODES[code]);
    if (NEGATIVE_CODES[code]) throw unprocessable(code, NEGATIVE_CODES[code]);
  }

  function requireBearer(req) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || !state.tokens.has(token)) {
      throw Object.assign(new ApiError(401, 'AUTHENTICATION_FAILURE', 'INVALID_TOKEN', 'Authentication failed due to invalid authentication credentials or a missing Authorization header.'), { plain: true });
    }
  }

  const routes = [
    ['POST', /^\/v1\/oauth2\/token$/, (req) => {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Basic ')) return { status: 401, body: { error: 'invalid_client', error_description: 'Client Authentication failed' } };
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const [id, secret] = decoded.split(':');
      if (!id || !secret || id === 'undefined' || secret === 'undefined') {
        return { status: 401, body: { error: 'invalid_client', error_description: 'Client Authentication failed' } };
      }
      const token = `MOCK-${crypto.randomBytes(18).toString('base64url')}`;
      state.tokens.set(token, crypto.createHash('sha256').update(decoded).digest('hex').slice(0, 12));
      return { status: 200, body: { scope: 'https://uri.paypal.com/services/payments/payment', access_token: token, token_type: 'Bearer', app_id: 'APP-MOCK', expires_in: 32400, nonce: `${now()}${debugId()}` } };
    }],

    ['POST', /^\/v2\/checkout\/orders$/, (req, body) => {
      requireBearer(req);
      return idempotent(req, 'create', () => {
        negativeTesting(req);
        validateOrder(body);
        const order = {
          id: id17(),
          intent: body.intent,
          status: body.payment_source?.paypal ? 'PAYER_ACTION_REQUIRED' : 'CREATED',
          purchase_units: body.purchase_units.map((u) => ({ reference_id: u.reference_id || 'default', ...u })),
          create_time: now(),
        };
        state.orders.set(order.id, order);
        return { status: 201, body: orderView(order) };
      });
    }],

    ['GET', /^\/v2\/checkout\/orders\/([^/]+)$/, (req, body, [id]) => {
      requireBearer(req);
      const o = state.orders.get(id);
      if (!o) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Specified resource ID does not exist. Please check the resource ID and try again.');
      return { status: 200, body: orderView(o) };
    }],

    ['POST', /^\/v2\/checkout\/orders\/([^/]+)\/confirm-payment-source$/, (req, body, [id]) => {
      requireBearer(req);
      const o = state.orders.get(id);
      if (!o) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Specified resource ID does not exist.');
      if (o.status === 'COMPLETED') throw unprocessable('ORDER_ALREADY_CAPTURED', 'Order already captured. If \'intent=CAPTURE\' only one capture per order is allowed.');
      const card = body?.payment_source?.card;
      if (!card?.number || !card?.expiry) throw invalid('MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.', '/payment_source/card');
      o.status = 'APPROVED';
      o.decline = /^CCREJECT-/.test(card.name || '') ? card.name : null;
      o.payment_source = { card: { name: card.name, last_digits: card.number.slice(-4), brand: 'VISA', type: 'CREDIT' } };
      o.update_time = now();
      return { status: 200, body: orderView(o) };
    }],

    ['POST', /^\/v2\/checkout\/orders\/([^/]+)\/capture$/, (req, body, [id]) => {
      requireBearer(req);
      return idempotent(req, 'capture', () => {
        const o = state.orders.get(id);
        if (!o) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Specified resource ID does not exist.');
        if (o.status === 'COMPLETED') throw unprocessable('ORDER_ALREADY_CAPTURED', 'Order already captured. If \'intent=CAPTURE\' only one capture per order is allowed.');
        if (o.status !== 'APPROVED') throw unprocessable('ORDER_NOT_APPROVED', 'Payer has not yet approved the Order for payment. Please redirect the payer to the \'rel\':\'approve\' url returned as part of the HATEOAS links within the Create Order call or provide a valid payment_source in the request.');
        negativeTesting(req);
        const unit = o.purchase_units[0];
        const declined = !!o.decline;
        const capture = {
          id: id17(),
          status: declined ? 'DECLINED' : 'COMPLETED',
          amount: { currency_code: unit.amount.currency_code, value: unit.amount.value },
          final_capture: true,
          seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'] },
          ...(declined ? { processor_response: { avs_code: 'G', cvv_code: 'P', response_code: '0500' } } : {}),
          create_time: now(),
          update_time: now(),
        };
        state.captures.set(capture.id, { ...capture, orderId: o.id });
        unit.payments = { captures: [capture] };
        o.status = 'COMPLETED';
        o.update_time = now();
        return { status: 201, body: orderView(o) };
      });
    }],

    ['POST', /^\/v2\/payments\/captures\/([^/]+)\/refund$/, (req, body, [id]) => {
      requireBearer(req);
      return idempotent(req, 'refund', () => {
        const c = state.captures.get(id);
        if (!c) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Specified resource ID does not exist.');
        negativeTesting(req);
        if (c.status !== 'COMPLETED') throw unprocessable('CAPTURE_FULLY_REFUNDED', 'The capture has already been fully refunded.');
        const amount = body?.amount ? body.amount : c.amount;
        if (body?.amount) validateMoney(body.amount, '/amount');
        const refund = { id: id17(), status: 'COMPLETED', amount, create_time: now(), update_time: now(), links: [{ href: `${baseUrl}/v2/payments/refunds/X`, rel: 'self', method: 'GET' }] };
        state.refunds.set(refund.id, refund);
        c.status = 'REFUNDED';
        return { status: 201, body: refund };
      });
    }],

    // Deprecated v1 refund endpoints. They still answer, like the real ones do.
    ['POST', /^\/v1\/payments\/(capture|sale)\/([^/]+)\/refund$/, (req, body, [, id]) => {
      requireBearer(req);
      const c = state.captures.get(id);
      if (!c) throw new ApiError(404, 'INVALID_RESOURCE_ID', 'INVALID_RESOURCE_ID', 'The requested resource ID was not found');
      c.status = 'REFUNDED';
      return { status: 201, headers: { deprecation: 'true' }, body: { id: id17(), state: 'completed', amount: body?.amount || { total: c.amount.value, currency: c.amount.currency_code }, capture_id: id, create_time: now() } };
    }],

    ['POST', /^\/v1\/notifications\/verify-webhook-signature$/, (req, body) => {
      requireBearer(req);
      const need = ['auth_algo', 'cert_url', 'transmission_id', 'transmission_sig', 'transmission_time', 'webhook_id', 'webhook_event'];
      const missing = need.filter((k) => !body?.[k]);
      if (missing.length) throw invalid('MISSING_REQUIRED_PARAMETER', `Missing: ${missing.join(', ')}`, `/${missing[0]}`);
      const known = state.webhooks.some((w) => w.id === body.webhook_id);
      const eventText = typeof body.webhook_event === 'string' ? body.webhook_event : JSON.stringify(body.webhook_event);
      const expected = mockSignature({ transmissionId: body.transmission_id, transmissionTime: body.transmission_time, webhookId: body.webhook_id, body: eventText });
      const ok = known && body.transmission_sig === expected;
      return { status: 200, body: { verification_status: ok ? 'SUCCESS' : 'FAILURE' } };
    }],

    ['GET', /^\/v1\/notifications\/webhooks$/, (req) => {
      requireBearer(req);
      return { status: 200, body: { webhooks: state.webhooks } };
    }],
    ['POST', /^\/v1\/notifications\/webhooks$/, (req, body) => {
      requireBearer(req);
      const wh = { id: `WH-${id17()}`, url: body?.url, event_types: body?.event_types || [] };
      state.webhooks.push(wh);
      return { status: 201, body: wh };
    }],
  ];

  function handle(req, res, rawBody) {
    const url = new URL(req.url, 'http://mock');
    let body = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const send = (status, payload, headers = {}) => {
      const text = payload == null ? '' : JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json', 'paypal-debug-id': debugId(), ...headers });
      res.end(text);
    };
    for (const [method, re, fn] of routes) {
      const m = req.method === method && url.pathname.match(re);
      if (!m) continue;
      try {
        const out = fn(req, body, m.slice(1));
        state.calls.push({ method, path: url.pathname, status: out.status });
        return send(out.status, out.body, out.headers);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        state.calls.push({ method, path: url.pathname, status: err.status, issue: err.issue });
        const debug = debugId();
        if (err.plain) return send(err.status, { name: err.name, message: err.description, debug_id: debug });
        return send(err.status, {
          name: err.name,
          details: [{ ...(err.field ? { field: err.field } : {}), ...(err.value !== undefined ? { value: err.value } : {}), location: 'body', issue: err.issue, description: err.description }],
          message: err.status === 422 ? 'The requested action could not be performed, semantically incorrect, or failed business validation.' : 'Request is not well-formed, syntactically incorrect, or violates schema.',
          debug_id: debug,
          links: [{ href: `https://developer.paypal.com/api/rest/reference/orders/v2/errors/#${err.issue}`, rel: 'information_link', method: 'GET' }],
        });
      }
    }
    state.calls.push({ method: req.method, path: url.pathname, status: 404 });
    return send(404, { name: 'RESOURCE_NOT_FOUND', message: `The mock does not implement ${req.method} ${url.pathname}` });
  }

  return {
    state,
    get url() {
      return baseUrl;
    },
    start(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            try {
              handle(req, res, Buffer.concat(chunks).toString('utf8'));
            } catch (err) {
              if (!quiet) console.error('[mock-paypal]', err);
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ name: 'INTERNAL_SERVER_ERROR', message: err.message }));
            }
          });
        });
        server.on('error', reject);
        server.listen(port, host, () => {
          baseUrl = `http://${host}:${server.address().port}`;
          resolve(baseUrl);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
