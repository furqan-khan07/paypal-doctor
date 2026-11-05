// Calls through the app's own request helper, and a URL held in a variable.
async function paypalRequest(creds, path, options) {
  return fetch(`${creds.base}${path}`, options).then((r) => r.json());
}
export const captureViaHelper = (creds, id) => paypalRequest(creds, `/v2/checkout/orders/${id}/capture`, { method: 'POST', body: '{}' });

export async function refundViaVariable(base, id, token) {
  const url = `${base}/v2/payments/captures/${id}/refund`;
  return fetch(url, { method: 'post', headers: { Authorization: `Bearer ${token}` } });
}

// This helper adds the header itself, so calls through it are fine.
async function safeRequest(base, path, id) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'PayPal-Request-Id': id } });
}
export const createViaSafeHelper = (base, id) => safeRequest(base, '/v2/checkout/orders', id);

// The header comes from a helper on the client.
class PayPalClient {
  async getHeaders() {
    return { Authorization: 'Bearer x', 'PayPal-Request-Id': this.requestId };
  }
}
export async function createWithClientHeaders(client, axios, url2) {
  const headers = await client.getHeaders();
  const url = `${url2}/v2/checkout/orders`;
  return axios.post(url, {}, { headers });
}
export { PayPalClient };
