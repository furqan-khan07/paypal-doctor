// A number goes straight into amount.value, and only a comment mentions the live host.
const SANDBOX = 'https://api-m.sandbox.paypal.com'; // change to https://api-m.paypal.com for production

export async function createOrderTyped(price: number, token: string) {
  return fetch(`${SANDBOX}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'PayPal-Request-Id': crypto.randomUUID() },
    body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: price } }] }),
  });
}
