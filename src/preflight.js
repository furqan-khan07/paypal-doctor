// `paypal-doctor preflight`: a 30-second check that the sandbox app can do
// everything the probes need, so problems show up here instead of as
// skipped probes later.
import crypto from 'node:crypto';
import { PayPalClient, SANDBOX_BASE } from './verify/paypal-client.js';
import { loadSecrets, hasPayPalKeys } from './env.js';
import { log } from './log.js';

export async function preflight() {
  if (!hasPayPalKeys()) {
    log.error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are empty. Paste your sandbox app credentials into .env first.');
    return false;
  }
  const s = loadSecrets();
  const pp = new PayPalClient({ base: SANDBOX_BASE, clientId: s.paypalClientId, clientSecret: s.paypalClientSecret });
  let ok = true;
  const step = async (name, fn) => {
    try {
      const detail = await fn();
      log.ok(`  ✓ ${name}${detail ? ` - ${detail}` : ''}`);
      return true;
    } catch (err) {
      ok = false;
      log.error(`  ✗ ${name} - ${err.message}`);
      return false;
    }
  };
  const expectOk = (r, what) => {
    if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${r.json?.details?.[0]?.issue || r.json?.name || ''} (debug id ${r.debugId || 'n/a'})`);
    return r;
  };

  log.step(`Preflight against ${SANDBOX_BASE}`);
  if (!(await step('OAuth token', async () => (await pp.accessToken(), 'credentials accepted')))) return false;

  let orderId;
  let captureId;
  await step('Create order (no buyer needed)', async () => {
    const r = expectOk(await pp.request('POST', '/v2/checkout/orders', {
      body: { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' } }] },
      headers: { 'PayPal-Request-Id': crypto.randomUUID() },
    }), 'create');
    orderId = r.json.id;
    return `${orderId} ${r.json.status}`;
  });
  const approved = orderId && await step('Approve with a sandbox test card (confirm-payment-source)', async () => {
    const r = expectOk(await pp.approveWithCard(orderId), 'confirm-payment-source');
    if (r.json.status !== 'APPROVED') throw new Error(`order status ${r.json.status}, expected APPROVED`);
    return 'APPROVED';
  });
  if (!approved) {
    log.warn('    Capture probes need this. In developer.paypal.com > Apps & Credentials > your sandbox app,');
    log.warn('    make sure card payments (Advanced Credit and Debit Card Payments) are enabled, then retry.');
  }
  if (approved) {
    await step('Capture', async () => {
      const r = expectOk(await pp.request('POST', `/v2/checkout/orders/${orderId}/capture`, { headers: { 'PayPal-Request-Id': `capture-${orderId}` } }), 'capture');
      const cap = r.json.purchase_units?.[0]?.payments?.captures?.[0];
      captureId = cap?.id;
      return `capture ${cap?.status}`;
    });
    await step('Capture again with the same PayPal-Request-Id (idempotent replay)', async () => {
      const r = expectOk(await pp.request('POST', `/v2/checkout/orders/${orderId}/capture`, { headers: { 'PayPal-Request-Id': `capture-${orderId}` } }), 'replayed capture');
      const again = r.json.purchase_units?.[0]?.payments?.captures?.[0]?.id;
      if (again !== captureId) throw new Error(`got capture ${again}, expected ${captureId}`);
      return 'same capture returned';
    });
    if (captureId) {
      await step('Refund through Payments v2', async () => {
        const r = expectOk(await pp.request('POST', `/v2/payments/captures/${captureId}/refund`, { body: {}, headers: { 'PayPal-Request-Id': `refund-${captureId}` } }), 'refund');
        return `refund ${r.json.status}`;
      });
    }
  }
  let webhookId = s.paypalWebhookId;
  await step('Webhook for signature checks', async () => {
    if (webhookId) return `using PAYPAL_WEBHOOK_ID ${webhookId}`;
    webhookId = await pp.ensureProbeWebhook();
    return `${webhookId} (created or reused, points at https://example.com/paypal-doctor-probe)`;
  });
  if (webhookId) {
    await step('verify-webhook-signature rejects a forged event', async () => {
      const r = expectOk(await pp.request('POST', '/v1/notifications/verify-webhook-signature', {
        body: {
          auth_algo: 'SHA256withRSA',
          cert_url: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
          transmission_id: crypto.randomUUID(),
          transmission_sig: crypto.randomBytes(256).toString('base64'),
          transmission_time: new Date().toISOString(),
          webhook_id: webhookId,
          webhook_event: { id: 'WH-PREFLIGHT', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} },
        },
      }), 'verify');
      if (r.json.verification_status !== 'FAILURE') throw new Error(`expected FAILURE, got ${r.json.verification_status}`);
      return 'FAILURE (as it should be)';
    });
  }
  log[ok ? 'ok' : 'warn'](ok ? '\nSandbox is ready: run `npm run demo:real`.' : '\nSome checks failed - probes that depend on them will be skipped or fail. See above.');
  return ok;
}
