// The doctor's own PayPal client. Probes use it to play the buyer (approve
// an order with a sandbox test card through confirm-payment-source) and to
// set up the sandbox (find or create the webhook used for signature checks).
import crypto from 'node:crypto';
import { redact } from '../env.js';

export const REAL_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
// Test hook: point "sandbox" mode at another server (e.g. the mock) to
// exercise the sandbox code path without credentials.
export const SANDBOX_BASE = process.env.PAYPAL_DOCTOR_SANDBOX_BASE || REAL_SANDBOX_BASE;
// From PayPal's sandbox card testing page; any future expiry and CVV work.
export const TEST_CARD = process.env.PAYPAL_DOCTOR_TEST_CARD || '4012888888881881';

export class PayPalClient {
  constructor({ base, clientId, clientSecret }) {
    this.base = base;
    this.creds = { clientId, clientSecret };
    this.token = null;
    this.calls = [];
  }

  async request(method, path, { body, headers = {}, auth = true } = {}) {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (auth) h.Authorization = `Bearer ${await this.accessToken()}`;
    const started = Date.now();
    let res;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new Error(`Could not reach PayPal at ${this.base}: ${redact(err.cause?.message || err.message)}`);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    this.calls.push({ method, path, status: res.status, ms: Date.now() - started, debugId: res.headers.get('paypal-debug-id') });
    return { status: res.status, ok: res.ok, json, debugId: res.headers.get('paypal-debug-id') };
  }

  async accessToken() {
    if (this.token) return this.token;
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64');
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    }).catch((err) => {
      throw new Error(`Could not reach PayPal at ${this.base}: ${redact(err.cause?.message || err.message)}`);
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new Error(`PayPal rejected the client id / secret (HTTP ${res.status}${json.error ? `, ${json.error}` : ''}). Check the sandbox credentials in .env.`);
    }
    this.token = json.access_token;
    return this.token;
  }

  // Act as the buyer: attach a sandbox test card to the order, which moves it
  // to APPROVED without a browser. `name` can be a PayPal rejection trigger
  // such as CCREJECT-REFUSED.
  async approveWithCard(orderId, { name = 'Doctor Probe' } = {}) {
    return this.request('POST', `/v2/checkout/orders/${orderId}/confirm-payment-source`, {
      body: {
        payment_source: {
          card: {
            number: TEST_CARD,
            expiry: '2030-12',
            security_code: '123',
            name,
            billing_address: { address_line_1: '2211 N First St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' },
            attributes: { verification: { method: 'SCA_WHEN_REQUIRED' } },
          },
        },
      },
      headers: { 'PayPal-Request-Id': crypto.randomUUID() },
    });
  }

  getOrder(orderId) {
    return this.request('GET', `/v2/checkout/orders/${orderId}`);
  }

  // A webhook id is needed for verify-webhook-signature. Reuse one that
  // points at our probe URL, or create it once.
  async ensureProbeWebhook() {
    const list = await this.request('GET', '/v1/notifications/webhooks');
    if (!list.ok) throw new Error(`Could not list sandbox webhooks (HTTP ${list.status}).`);
    const existing = (list.json?.webhooks || []).find((w) => /paypal-doctor-probe/.test(w.url || ''));
    if (existing) return existing.id;
    const created = await this.request('POST', '/v1/notifications/webhooks', {
      body: {
        url: 'https://example.com/paypal-doctor-probe',
        event_types: [{ name: 'PAYMENT.CAPTURE.COMPLETED' }, { name: 'PAYMENT.CAPTURE.PENDING' }, { name: 'PAYMENT.CAPTURE.DENIED' }],
      },
    });
    if (!created.ok) throw new Error(`Could not create the probe webhook in the sandbox (HTTP ${created.status}: ${created.json?.name || ''}). Set PAYPAL_WEBHOOK_ID in .env to an existing webhook id instead.`);
    return created.json.id;
  }
}
