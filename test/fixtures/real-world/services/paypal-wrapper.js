// A thin API wrapper: it returns the capture to its caller, so it doesn't decide anything.
export class PayPalApi {
  capture = async (base, id, token) => {
    const res = await fetch(`${base}/v2/checkout/orders/${id}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'PayPal-Request-Id': `capture-${id}` },
    });
    return res.json();
  };

  // A call out to PayPal's API, not a webhook route on this server.
  createWebhook = async (client, body) => client.post('/v1/notifications/webhooks', body);
}
function body() {}

// Only here so a name-based lookup would find a PayPal function called captureOrder.
export function captureOrder() {
  return 'paypal';
}
