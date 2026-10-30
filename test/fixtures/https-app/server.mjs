// Tiny app that talks to PayPal with node:https (like axios or the server SDK
// would), to test that the interceptor sees that traffic too.
import http from 'node:http';
import { request } from 'node:https';

function call(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request({ method, hostname: 'api-m.sandbox.paypal.com', path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

http.createServer(async (req, res) => {
  if (req.url === '/healthz') return res.end('ok');
  try {
    const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const tok = await call('POST', '/v1/oauth2/token', { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, 'grant_type=client_credentials');
    const body = JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '5.00' } }] });
    const order = await call('POST', '/v2/checkout/orders', { Authorization: `Bearer ${tok.json.access_token}`, 'Content-Type': 'application/json' }, body);
    res.writeHead(order.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(order.json));
  } catch (err) {
    res.writeHead(502);
    res.end(String(err.code || err.message));
  }
}).listen(process.env.PORT);
