// Copy-paste leftovers: this "base" is another provider, so it isn't a PayPal call.
const base = 'https://api.other-gateway.example';
export async function approve(orderId, token) {
  const url = `${base}/v2/checkout/orders/${orderId}/capture`;
  return fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
}
