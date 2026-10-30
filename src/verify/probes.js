// Probes: each one drives the app through a real checkout and asserts on
// what the app did and what it sent to PayPal. A probe is run twice per
// patch - before (expected to fail: the bug is reproduced) and after
// (expected to pass: the fix works).
import crypto from 'node:crypto';
import { mockSignature } from '../mock-paypal/server.js';
import { ZERO_DECIMAL_CURRENCIES, RULES_BY_ID } from '../rules.js';

export const CANARY_BASE = 'http://paypal-api.doctor-canary.localhost';

// ---------- helpers -----------------------------------------------------------

const header = (entry, name) => entry?.requestHeaders?.[name.toLowerCase()];
const issueOf = (entry) => entry?.responseBody?.details?.[0]?.issue || entry?.responseBody?.name || '';
const isCreate = (e) => e.method === 'POST' && /^\/v2\/checkout\/orders\/?$/.test(e.path);
const isCapture = (e) => e.method === 'POST' && /^\/v2\/checkout\/orders\/[^/]+\/capture$/.test(e.path);
const isRefundV2 = (e) => e.method === 'POST' && /^\/v2\/payments\/captures\/[^/]+\/refund$/.test(e.path);
const isToken = (e) => /\/v1\/oauth2\/token$/.test(e.path);
const fp = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

async function checkout(run, app, cartName = 'standard') {
  const cart = run.config.carts?.[cartName];
  if (!cart) throw new Error(`paypal-doctor.json has no "${cartName}" cart`);
  const res = await app.call('createOrder', { body: cart.body });
  return { res, orderId: res.json?.[run.config.orderIdField || 'id'] || null };
}

async function storeStatus(run, app, orderId) {
  const r = await app.call('orderStatus', { params: { orderID: orderId } });
  return r.json?.[run.config.statusField || 'status'] ?? `(HTTP ${r.status})`;
}

const isPaid = (run, status) => (run.config.paidStatuses || ['paid']).includes(status);

// Play the buyer. Returns false (and skips the probe) when the sandbox won't
// approve with a test card, which usually means card processing is off for
// the sandbox app.
async function approve(run, app, orderId, opts) {
  const r = await app.upstream.client.approveWithCard(orderId, opts);
  if (r.ok && r.json?.status === 'APPROVED') return true;
  if (r.ok) {
    run.skip(`${app.upstream.kind} answered the test-card approval with order status ${r.json?.status} instead of APPROVED (debug id ${r.debugId || 'n/a'}). A 3-D Secure challenge needs a browser; try another test card via PAYPAL_DOCTOR_TEST_CARD.`);
    return false;
  }
  const issue = r.json?.details?.[0]?.issue || r.json?.name || '';
  run.skip(`${app.upstream.kind} would not approve the order with a test card (HTTP ${r.status} ${issue}, debug id ${r.debugId || 'n/a'}). In the sandbox this usually means card payments are off for the app - see MORNING.md.`);
  return false;
}

async function paidOrder(run, app, opts) {
  const { res, orderId } = await checkout(run, app);
  if (!run.check('store created a PayPal order', !!orderId, `HTTP ${res.status}`)) return null;
  if (!(await approve(run, app, orderId, opts))) return null;
  return orderId;
}

function webhookEvent(type, orderId) {
  const t = new Date().toISOString();
  return {
    id: `WH-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
    event_version: '1.0',
    create_time: t,
    resource_type: 'capture',
    resource_version: '2.0',
    event_type: type,
    summary: `Payment ${type.endsWith('PENDING') ? 'pending' : 'completed'} for $ 18.0 USD`,
    resource: {
      id: crypto.randomBytes(8).toString('hex').toUpperCase(),
      status: type.split('.').pop(),
      ...(type.endsWith('PENDING') ? { status_details: { reason: 'PENDING_REVIEW' } } : {}),
      amount: { currency_code: 'USD', value: '18.00' },
      final_capture: true,
      supplementary_data: { related_ids: { order_id: orderId } },
      create_time: t,
      update_time: t,
      links: [],
    },
    links: [],
  };
}

async function postWebhook(run, app, event, { genuine }) {
  const body = JSON.stringify(event);
  const transmissionId = crypto.randomUUID();
  const transmissionTime = new Date().toISOString();
  const sig = genuine
    ? mockSignature({ transmissionId, transmissionTime, webhookId: app.upstream.webhookId, body })
    : crypto.randomBytes(256).toString('base64');
  const [method, p] = run.config.routes.webhook.split(/\s+/);
  return app.raw(method, p, {
    rawBody: body,
    headers: {
      'content-type': 'application/json',
      'paypal-transmission-id': transmissionId,
      'paypal-transmission-time': transmissionTime,
      'paypal-transmission-sig': sig,
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
      'paypal-auth-algo': 'SHA256withRSA',
      'correlation-id': crypto.randomBytes(6).toString('hex'),
    },
  });
}

// ---------- probes ------------------------------------------------------------

export const PROBES = {
  'v1-api': {
    title: 'Refund goes through Payments v2',
    routes: ['createOrder', 'captureOrder', 'refundOrder'],
    async run(run) {
      const app = await run.app();
      const orderId = await paidOrder(run, app);
      if (!orderId) return;
      const cap = await app.call('captureOrder', { params: { orderID: orderId } });
      run.check('store captured the order', cap.status < 300, `HTTP ${cap.status}`);
      const ref = await app.call('refundOrder', { params: { orderID: orderId } });
      const trace = app.trace();
      const v1 = trace.filter((e) => /^\/v1\/payments\//.test(e.path));
      const v2 = trace.filter(isRefundV2);
      run.check('no calls to the deprecated /v1/payments API', v1.length === 0, v1.length ? v1.map((e) => `${e.method} ${e.path}`).join(', ') : 'none');
      run.check('refund sent to POST /v2/payments/captures/{id}/refund', v2.length > 0, v2.length ? `${v2[0].method} ${v2[0].path}` : 'no v2 refund call');
      run.check('PayPal accepted the v2 refund', v2.some((e) => e.status >= 200 && e.status < 300), v2.length ? `HTTP ${v2[v2.length - 1].status} ${issueOf(v2[v2.length - 1])}` : '-');
      run.check('store reports the refund succeeded', ref.status < 300, `HTTP ${ref.status}`);
    },
  },

  'webhook-forgery': {
    title: 'Forged webhook is rejected, real one accepted',
    routes: ['createOrder', 'webhook', 'orderStatus'],
    async run(run) {
      const app = await run.app();
      const { orderId } = await checkout(run, app);
      if (!run.check('store created a PayPal order', !!orderId)) return;
      const forged = await postWebhook(run, app, webhookEvent('PAYMENT.CAPTURE.COMPLETED', orderId), { genuine: false });
      const after = await storeStatus(run, app, orderId);
      run.check('a forged PAYMENT.CAPTURE.COMPLETED does not mark the order paid', !isPaid(run, after), `order status after the forged event: ${after}`);
      run.check('the forged event is answered with a 4xx', forged.status >= 400 && forged.status < 500, `webhook answered HTTP ${forged.status}`, { level: 'should' });
      const verify = app.trace().filter((e) => /verify-webhook-signature$/.test(e.path));
      run.check('store asked PayPal to verify the signature', verify.length > 0,
        verify.length ? `${app.upstream.kind} answered ${verify[0].responseBody?.verification_status || `HTTP ${verify[0].status}`}` : 'no verify-webhook-signature call', { level: 'should' });

      // The accept-real-events half needs a correctly signed event, which only
      // the mock can produce (the sandbox only signs events it delivers itself).
      let realApp = app;
      let realOrder = orderId;
      if (app.upstream.kind !== 'mock') {
        run.note('A genuinely signed event only comes from PayPal delivering to a public URL, so the "real event is accepted" check runs against the local mock.');
        realApp = await run.app({ useMock: true });
        realOrder = (await checkout(run, realApp)).orderId;
      }
      const genuine = await postWebhook(run, realApp, webhookEvent('PAYMENT.CAPTURE.COMPLETED', realOrder), { genuine: true });
      const after2 = await storeStatus(run, realApp, realOrder);
      run.check('a correctly signed PAYMENT.CAPTURE.COMPLETED is accepted', genuine.status < 300 && isPaid(run, after2), `HTTP ${genuine.status}, order status ${after2}`);
    },
  },

  'webhook-pending': {
    title: 'PAYMENT.CAPTURE.PENDING is not treated as paid',
    routes: ['createOrder', 'webhook', 'orderStatus'],
    async run(run) {
      const app = await run.app({ useMock: true });
      const { orderId } = await checkout(run, app);
      if (!run.check('store created a PayPal order', !!orderId)) return;
      const pending = await postWebhook(run, app, webhookEvent('PAYMENT.CAPTURE.PENDING', orderId), { genuine: true });
      const s1 = await storeStatus(run, app, orderId);
      run.check('a signed PAYMENT.CAPTURE.PENDING does not mark the order paid', !isPaid(run, s1), `HTTP ${pending.status}, order status ${s1}`);
      const done = await postWebhook(run, app, webhookEvent('PAYMENT.CAPTURE.COMPLETED', orderId), { genuine: true });
      const s2 = await storeStatus(run, app, orderId);
      run.check('the follow-up PAYMENT.CAPTURE.COMPLETED marks it paid', isPaid(run, s2), `HTTP ${done.status}, order status ${s2}`);
    },
  },

  'idempotency-create': {
    title: 'Create order is idempotent',
    routes: ['createOrder'],
    async run(run) {
      const app = await run.app();
      const a = await checkout(run, app);
      const b = await checkout(run, app);
      const creates = app.trace().filter(isCreate);
      const ids = creates.map((e) => header(e, 'PayPal-Request-Id'));
      run.check('two checkouts created two orders', !!a.orderId && !!b.orderId && a.orderId !== b.orderId, `${a.orderId} / ${b.orderId}`);
      run.check('every create order request carries a PayPal-Request-Id', creates.length >= 2 && ids.every(Boolean), ids.map((i) => i || '(none)').join(', '));
      run.check('each checkout gets its own PayPal-Request-Id', ids.length >= 2 && new Set(ids).size === ids.length, ids.length ? `${new Set(ids).size} distinct of ${ids.length}` : '-');
      if (ids[0] && a.orderId) {
        const replay = await app.upstream.client.request('POST', '/v2/checkout/orders', { body: creates[0].requestBody, headers: { 'PayPal-Request-Id': ids[0] } });
        run.check(`replaying the first request with the same id returns the same order from ${app.upstream.kind}`, replay.json?.id === a.orderId, `first ${a.orderId}, replay ${replay.json?.id || `HTTP ${replay.status}`}`, { level: 'should' });
      }
    },
  },

  'idempotency-capture': {
    title: 'Capture retry after a lost response',
    routes: ['createOrder', 'captureOrder', 'orderStatus'],
    async run(run) {
      const app = await run.app({ faults: [{ action: 'drop-response', method: 'POST', path: '^/v2/checkout/orders/[^/]+/capture$', times: 1 }] });
      const orderId = await paidOrder(run, app);
      if (!orderId) return;
      const first = await app.call('captureOrder', { params: { orderID: orderId } });
      const second = await app.call('captureOrder', { params: { orderID: orderId } });
      const caps = app.trace().filter(isCapture);
      const ids = caps.map((e) => header(e, 'PayPal-Request-Id'));
      run.note(`First capture: PayPal processed it, the response was dropped (store answered HTTP ${first.status}). The buyer's browser then retried.`);
      run.check('capture requests carry a PayPal-Request-Id', caps.length >= 2 && ids.every(Boolean), ids.map((i) => i || '(none)').join(', '));
      run.check('the retry reuses the same PayPal-Request-Id', ids.length >= 2 && ids[0] && ids[0] === ids[1], ids.length >= 2 ? `${ids[0] || '(none)'} vs ${ids[1] || '(none)'}` : '-');
      run.check('the retry gets the original capture back instead of ORDER_ALREADY_CAPTURED', caps[1] && caps[1].status < 300, caps[1] ? `PayPal answered HTTP ${caps[1].status} ${issueOf(caps[1])}` : 'no retry reached PayPal');
      const s = await storeStatus(run, app, orderId);
      run.check('the order ends up paid (money was taken, so the order must say so)', isPaid(run, s), `store status ${s}, retry HTTP ${second.status}`);
    },
  },

  'idempotency-refund': {
    title: 'Refund retry after a lost response',
    routes: ['createOrder', 'captureOrder', 'refundOrder'],
    async run(run) {
      const app = await run.app({ faults: [{ action: 'drop-response', method: 'POST', path: '^/v2/payments/captures/[^/]+/refund$', times: 1 }] });
      const orderId = await paidOrder(run, app);
      if (!orderId) return;
      await app.call('captureOrder', { params: { orderID: orderId } });
      await app.call('refundOrder', { params: { orderID: orderId } });
      const second = await app.call('refundOrder', { params: { orderID: orderId } });
      const refunds = app.trace().filter(isRefundV2);
      const ids = refunds.map((e) => header(e, 'PayPal-Request-Id'));
      run.check('refund requests carry a PayPal-Request-Id', refunds.length >= 2 && ids.every(Boolean), ids.map((i) => i || '(none)').join(', '));
      run.check('the retry reuses the same PayPal-Request-Id', ids.length >= 2 && ids[0] === ids[1], ids.join(' vs '));
      run.check('the retried refund succeeds', second.status < 300, `HTTP ${second.status}`);
    },
  },

  'capture-status': {
    title: 'Only a COMPLETED capture marks the order paid',
    routes: ['createOrder', 'captureOrder', 'orderStatus'],
    async run(run) {
      // control: a normal capture must still mark the order paid
      const app = await run.app();
      const ok = await paidOrder(run, app);
      if (!ok) return;
      await app.call('captureOrder', { params: { orderID: ok } });
      const s1 = await storeStatus(run, app, ok);
      run.check('a COMPLETED capture marks the order paid', isPaid(run, s1), `store status ${s1}`);

      // PENDING: PayPal took the capture but the funds are not credited yet
      // (eCheck, review, receiving preferences). Injected on the real response.
      const pendingApp = await run.app({ faults: [{ action: 'set-capture-status', status: 'PENDING', reason: 'PENDING_REVIEW', method: 'POST', path: '^/v2/checkout/orders/[^/]+/capture$' }] });
      const p = await paidOrder(run, pendingApp);
      if (!p) return;
      await pendingApp.call('captureOrder', { params: { orderID: p } });
      const s2 = await storeStatus(run, pendingApp, p);
      run.check('a PENDING capture (status_details PENDING_REVIEW) does not mark the order paid', !isPaid(run, s2), `store status ${s2} (capture status rewritten to PENDING on the ${pendingApp.upstream.kind} response)`);

      // DECLINED: PayPal's card rejection trigger, no injection
      const declineApp = await run.app();
      const { orderId: d } = await checkout(run, declineApp);
      const appr = d ? await declineApp.upstream.client.approveWithCard(d, { name: 'CCREJECT-REFUSED' }) : null;
      if (!appr?.ok) {
        run.note(`The decline trigger was refused at approval time (HTTP ${appr?.status}), so the declined-capture path was not reached.`);
        return;
      }
      const cap = await declineApp.call('captureOrder', { params: { orderID: d } });
      const s3 = await storeStatus(run, declineApp, d);
      const captured = declineApp.trace().filter(isCapture).pop();
      const capStatus = captured?.responseBody?.purchase_units?.[0]?.payments?.captures?.[0]?.status || issueOf(captured) || `HTTP ${cap.status}`;
      run.check('a DECLINED capture (card trigger CCREJECT-REFUSED) does not mark the order paid', !isPaid(run, s3), `PayPal capture: ${capStatus}; store status ${s3}`);
    },
  },

  'client-amount': {
    title: 'Server computes the amount',
    routes: ['createOrder'],
    async run(run) {
      const app = await run.app();
      const exp = run.config.carts.tampered.expect;
      const t = await checkout(run, app, 'tampered');
      const sent = app.trace().filter(isCreate)[0]?.requestBody?.purchase_units?.[0]?.amount;
      run.check(`PayPal is asked for ${exp.value} ${exp.currency_code}, not the price the browser sent`, !!sent && Number(sent.value) === Number(exp.value) && sent.currency_code === exp.currency_code,
        sent ? `store sent ${sent.value} ${sent.currency_code} for a cart the browser priced at ${run.config.carts.tampered.body.cart?.[0]?.price}` : `no create order call (HTTP ${t.res.status})`);
      const std = run.config.carts.standard.expect;
      const s = await checkout(run, app, 'standard');
      const sent2 = app.trace().filter(isCreate)[1]?.requestBody?.purchase_units?.[0]?.amount;
      run.check('an honest cart still checks out at the catalog price', !!s.orderId && !!sent2 && Number(sent2.value) === Number(std.value), sent2 ? `${sent2.value} ${sent2.currency_code}, order ${s.orderId}` : `HTTP ${s.res.status}`);
    },
  },

  'amount-format': {
    title: 'Fractional cart is formatted correctly',
    routes: ['createOrder'],
    async run(run) {
      const app = await run.app();
      const exp = run.config.carts.fractional.expect;
      const r = await checkout(run, app, 'fractional');
      const create = app.trace().filter(isCreate)[0];
      const sent = create?.requestBody?.purchase_units?.[0]?.amount;
      const decimals = ZERO_DECIMAL_CURRENCIES.has(exp.currency_code) ? 0 : 2;
      const shape = decimals ? new RegExp(`^\\d+\\.\\d{${decimals}}$`) : /^\d+$/;
      run.check(`amount.value is a string with ${decimals} decimals ("${exp.value}")`, typeof sent?.value === 'string' && shape.test(sent.value) && sent.value === exp.value, `store sent ${JSON.stringify(sent?.value)}`);
      run.check(`${app.upstream.kind} accepted the order`, create?.status === 201, create ? `HTTP ${create.status} ${issueOf(create)}` : 'no create call');
      run.check('the browser gets an order id back', !!r.orderId, `HTTP ${r.res.status}`);
    },
  },

  'hardcoded-env': {
    title: 'Base URL comes from configuration',
    routes: ['createOrder'],
    async run(run) {
      const envName = run.config.env?.apiBase || 'PAYPAL_API_BASE';
      const app = await run.app({ apiBase: CANARY_BASE });
      const r = await checkout(run, app);
      const calls = app.trace();
      const off = calls.filter((e) => !e.originalUrl.startsWith(CANARY_BASE));
      run.check(`every PayPal call goes to ${envName}`, calls.length > 0 && off.length === 0,
        off.length ? `${off.length} of ${calls.length} call(s) ignored ${envName} and went to ${new URL(off[0].originalUrl).origin}` : `${calls.length} call(s) went to ${envName}`);
      run.check('checkout still works', !!r.orderId, `HTTP ${r.res.status}`);
    },
  },

  'hardcoded-creds': {
    title: 'Credentials only come from the environment',
    routes: ['createOrder'],
    async run(run) {
      const e = run.config.env || {};
      const idVar = e.clientId || 'PAYPAL_CLIENT_ID';
      const secretVar = e.clientSecret || 'PAYPAL_CLIENT_SECRET';
      const app = await run.app({ useMock: true });
      await checkout(run, app);
      const { clientId, clientSecret } = run.mockUpstream.creds;
      const want = `Basic <credentials fp:${fp(`${clientId}:${clientSecret}`)}>`;
      const tok = app.trace().filter(isToken);
      run.check(`the token request uses ${idVar} / ${secretVar} from the environment`, tok.length > 0 && tok.every((x) => header(x, 'authorization') === want), tok.length ? `${tok.length} token request(s)` : 'no token request');

      const bare = await run.app({ useMock: true, env: { [idVar]: null, [secretVar]: null }, allowNotReady: true });
      if (!bare.ready) {
        run.check('with no credentials configured, nothing built-in is sent to PayPal', true, 'app refused to start without credentials');
        return;
      }
      const r = await checkout(run, bare);
      const leaked = bare.trace().filter(isToken).filter((x) => !/empty credentials/.test(header(x, 'authorization') || ''));
      run.check('with no credentials configured, nothing built-in is sent to PayPal', leaked.length === 0,
        leaked.length ? 'the app authenticated with credentials that are baked into the code' : `no credentials sent (checkout answered HTTP ${r.res.status})`);
    },
  },
};

export function selectProbe(finding, config) {
  const routes = config.routes || {};
  let id;
  switch (finding.ruleId) {
    case 'missing-request-id': {
      const t = `${finding.symbol} ${finding.message}`.toLowerCase();
      id = /refund/.test(t) ? 'idempotency-refund' : /capture/.test(t) ? 'idempotency-capture' : 'idempotency-create';
      break;
    }
    case 'capture-status-unchecked':
      id = routes.webhook && (finding.symbol === routes.webhook || /webhook|PAYMENT\.CAPTURE\.PENDING/i.test(`${finding.symbol} ${finding.message}`)) ? 'webhook-pending' : 'capture-status';
      break;
    default:
      id = RULES_BY_ID[finding.ruleId]?.probe ?? null;
  }
  if (!id || !PROBES[id]) return null;
  const missing = PROBES[id].routes.filter((r) => !routes[r]);
  return { id, ...PROBES[id], missing };
}
