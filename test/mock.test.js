import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockPayPal } from '../src/mock-paypal/server.js';
import { PayPalClient } from '../src/verify/paypal-client.js';

const order = (value, currency = 'USD') => ({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: currency, value } }] });

test('mock PayPal: validation, approval, idempotency and already-captured', async () => {
  const mock = createMockPayPal();
  const base = await mock.start();
  const pp = new PayPalClient({ base, clientId: 'a-client', clientSecret: 'a-secret' });
  try {
    const bad = await pp.request('POST', '/v2/checkout/orders', { body: order('0.30000000000000004') });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.details[0].issue, 'DECIMAL_PRECISION');
    assert.equal((await pp.request('POST', '/v2/checkout/orders', { body: order('1500.00', 'JPY') })).json.details[0].issue, 'DECIMAL_PRECISION');
    assert.equal((await pp.request('POST', '/v2/checkout/orders', { body: order(0.3) })).json.details[0].issue, 'INVALID_PARAMETER_SYNTAX');

    const created = await pp.request('POST', '/v2/checkout/orders', { body: order('18.00') });
    assert.equal(created.status, 201);
    const id = created.json.id;
    assert.equal((await pp.request('POST', `/v2/checkout/orders/${id}/capture`)).json.details[0].issue, 'ORDER_NOT_APPROVED');
    assert.equal((await pp.approveWithCard(id)).json.status, 'APPROVED');

    const h = { 'PayPal-Request-Id': `capture-${id}` };
    const first = await pp.request('POST', `/v2/checkout/orders/${id}/capture`, { headers: h });
    assert.equal(first.json.purchase_units[0].payments.captures[0].status, 'COMPLETED');
    const replay = await pp.request('POST', `/v2/checkout/orders/${id}/capture`, { headers: h });
    assert.equal(replay.json.purchase_units[0].payments.captures[0].id, first.json.purchase_units[0].payments.captures[0].id);
    const noId = await pp.request('POST', `/v2/checkout/orders/${id}/capture`);
    assert.equal(noId.json.details[0].issue, 'ORDER_ALREADY_CAPTURED');

    const declined = (await pp.request('POST', '/v2/checkout/orders', { body: order('5.00') })).json.id;
    await pp.approveWithCard(declined, { name: 'CCREJECT-REFUSED' });
    const d = await pp.request('POST', `/v2/checkout/orders/${declined}/capture`);
    assert.equal(d.json.status, 'COMPLETED', 'order-level status stays COMPLETED');
    assert.equal(d.json.purchase_units[0].payments.captures[0].status, 'DECLINED');

    const neg = (await pp.request('POST', '/v2/checkout/orders', { body: order('5.00'), headers: { 'PayPal-Mock-Response': '{"mock_application_codes":"INSTRUMENT_DECLINED"}' } }));
    assert.equal(neg.json.details[0].issue, 'INSTRUMENT_DECLINED');
  } finally {
    await mock.stop();
  }
});
