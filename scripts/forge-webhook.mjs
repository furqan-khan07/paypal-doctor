// For the demo video: post a forged PAYMENT.CAPTURE.COMPLETED to the running
// store and show what it did to the order.
//
//   npm run forge-webhook -- <PayPal order id> [store url]
const [orderId, base = 'http://localhost:8888'] = process.argv.slice(2);
if (!orderId) {
  console.error('usage: npm run forge-webhook -- <PayPal order id> [store url]');
  process.exit(2);
}

const event = {
  id: 'WH-FORGED-0000000000',
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource_type: 'capture',
  resource: {
    id: 'FAKE-CAPTURE',
    status: 'COMPLETED',
    amount: { currency_code: 'USD', value: '18.00' },
    supplementary_data: { related_ids: { order_id: orderId } },
  },
};

const before = await (await fetch(`${base}/api/store-orders/${orderId}`)).json();
const res = await fetch(`${base}/api/paypal/webhook`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'paypal-transmission-id': crypto.randomUUID(),
    'paypal-transmission-time': new Date().toISOString(),
    'paypal-transmission-sig': 'definitely-not-a-real-signature',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
    'paypal-auth-algo': 'SHA256withRSA',
  },
  body: JSON.stringify(event),
});
const after = await (await fetch(`${base}/api/store-orders/${orderId}`)).json();
console.log(`order ${orderId}: ${before.status} -> webhook answered ${res.status} -> ${after.status}`);
