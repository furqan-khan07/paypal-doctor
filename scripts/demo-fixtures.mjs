// Writes the hand-written LLM fixtures for the demo store's fix chain and
// checks that each patch applies on top of the previous ones.
//
// These exist so `npm run demo` works with no API key. They're labelled
// handWritten: true in the report and on the dashboard. Once an
// ANTHROPIC_API_KEY is set, `paypal-doctor run demo-store --llm record`
// replaces them with real model output.
//
//   node scripts/demo-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fixturePath } from '../src/llm/client.js';
import { VirtualTree, applyEdits } from '../src/fix/patch.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'demo-store');
const TARGET = 'kiln-and-co';

const PATCHES = [
  {
    key: 'fix|deprecated-v1-payments|paypal.js|refundCapture|1',
    explanation:
      'Refunds were still sent to /v1/payments/capture/{id}/refund, part of the v1 Payments API that PayPal has deprecated. This moves the call to the Payments v2 refund endpoint, changing the body to the v2 shape ({ value, currency_code }). Because it is a new money-moving call, it also gets a PayPal-Request-Id derived from the capture id, so a retried refund cannot pay out twice.',
    notes: '',
    edits: [
      {
        file: 'paypal.js',
        find: `// Refunds still go through the old endpoint we used before the v2 migration.
export async function refundCapture(captureId, amount) {
  const accessToken = await generateAccessToken();
  const response = await fetch(\`\${base}/v1/payments/capture/\${captureId}/refund\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${accessToken}\`,
    },
    body: JSON.stringify({ amount: { total: amount, currency: "USD" } }),
  });`,
        replace: `// Refunds go through Payments v2; the /v1/payments endpoints are deprecated.
export async function refundCapture(captureId, amount) {
  const accessToken = await generateAccessToken();
  const response = await fetch(\`\${base}/v2/payments/captures/\${captureId}/refund\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${accessToken}\`,
      // same id on a retry, so a lost response can't refund twice
      "PayPal-Request-Id": \`refund-\${captureId}\`,
    },
    body: JSON.stringify({ amount: { value: amount, currency_code: "USD" } }),
  });`,
      },
    ],
  },
  {
    key: 'fix|hardcoded-environment|paypal.js|(top level)|1',
    explanation:
      'The API host was a string literal pointing at the sandbox, so going live meant editing code, and a production deploy would quietly keep sending buyers to the sandbox. The base URL now comes from PAYPAL_API_BASE and only defaults to the sandbox when it is not set.',
    notes: 'Set PAYPAL_API_BASE=https://api-m.paypal.com in production, together with live credentials.',
    edits: [
      {
        file: 'paypal.js',
        find: 'const base = "https://api-m.sandbox.paypal.com";',
        replace: `// Sandbox unless PAYPAL_API_BASE says otherwise (https://api-m.paypal.com for live).
const base = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";`,
      },
    ],
  },
  {
    key: 'fix|hardcoded-credentials|paypal.js|(top level)|1',
    explanation:
      'When PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET was missing, the code fell back to a client id and secret written into the file. That secret is now in git history, and a deploy with a missing env var would silently run against whatever account the baked-in keys belong to. Credentials now come only from the environment, and token requests fail fast with a clear error when they are missing.',
    notes: 'Rotate the secret that was committed (kiln-sandbox-secret-2024) in the PayPal developer dashboard.',
    edits: [
      {
        file: 'paypal.js',
        find: `const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "kiln-sandbox-client";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "kiln-sandbox-secret-2024";`,
        replace: 'const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;',
      },
      {
        file: 'paypal.js',
        find: `export async function generateAccessToken() {
  const auth`,
        replace: `export async function generateAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set");
  }
  const auth`,
      },
    ],
  },
  {
    key: 'fix|client-supplied-amount|server.js|POST /api/orders|1',
    explanation:
      'The order total was summed from item.price values that come straight from the browser\'s cart, so anyone could edit localStorage or the request and pay $0.01 for a $42 pour-over set. The server now takes only the sku and quantity from the client, looks each price up in CATALOG, and rejects unknown items or bad quantities with a 400.',
    notes: '',
    edits: [
      {
        file: 'server.js',
        find: `    const { cart } = req.body;
    const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);`,
        replace: `    const { cart } = req.body;
    // Only the sku and quantity come from the browser; prices come from our catalog.
    const lines = (Array.isArray(cart) ? cart : []).map((item) => ({
      product: CATALOG[item.sku],
      quantity: Number.parseInt(item.quantity, 10),
    }));
    if (lines.length === 0 || lines.some((l) => !l.product || !(l.quantity > 0))) {
      return res.status(400).json({ error: "Cart has an unknown item or a bad quantity." });
    }
    const total = lines.reduce((sum, l) => sum + l.product.price * l.quantity, 0);`,
      },
    ],
  },
  {
    key: 'fix|amount-formatting|paypal.js|createOrder|1',
    explanation:
      'amount.value was String(total) on a floating-point sum, so a cart of three $0.10 stickers was sent as "0.30000000000000004" and PayPal rejected the order with DECIMAL_PRECISION. A small helper now rounds in minor units and formats with the currency\'s decimal places (two for USD, zero for JPY, HUF and TWD) before the value goes to PayPal.',
    notes: '',
    edits: [
      {
        file: 'paypal.js',
        find: 'export async function createOrder(total) {',
        replace: `// PayPal wants amount.value as a string with the currency's decimal places
// (0 for JPY, HUF and TWD, 2 for everything else). Round in minor units so
// float noise like 0.30000000000000004 never reaches the API.
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "HUF", "TWD"]);
function toPayPalValue(amount, currency) {
  const digits = ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
  const minor = Math.round(amount * 10 ** digits);
  return (minor / 10 ** digits).toFixed(digits);
}

export async function createOrder(total) {`,
      },
      {
        file: 'paypal.js',
        find: `          currency_code: "USD",
          value: String(total),`,
        replace: `          currency_code: "USD",
          value: toPayPalValue(total, "USD"),`,
      },
    ],
  },
  {
    key: 'fix|missing-request-id|paypal.js|createOrder|1',
    explanation:
      'Create order went out without a PayPal-Request-Id, so if the response was lost and the call retried, PayPal would treat it as a new order. Each checkout attempt now sends a fresh UUID as PayPal-Request-Id, which PayPal uses to return the original order for a retried request.',
    notes: '',
    edits: [
      {
        file: 'paypal.js',
        find: `  const response = await fetch(\`\${base}/v2/checkout/orders\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${accessToken}\`,
    },`,
        replace: `  const response = await fetch(\`\${base}/v2/checkout/orders\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${accessToken}\`,
      // fresh id per checkout attempt; PayPal dedupes retries of this request on it
      "PayPal-Request-Id": crypto.randomUUID(),
    },`,
      },
    ],
  },
  {
    key: 'fix|missing-request-id|paypal.js|captureOrder|1',
    explanation:
      'Capture had no PayPal-Request-Id. When the capture response got lost and the buyer\'s browser retried, PayPal saw a second capture, answered ORDER_ALREADY_CAPTURED, and the shop never recorded a payment it had actually taken. The header is now derived from the order id, so a retried capture gets the original result back.',
    notes: '',
    edits: [
      {
        file: 'paypal.js',
        find: `  const response = await fetch(\`\${base}/v2/checkout/orders/\${orderID}/capture\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${accessToken}\`,
    },`,
        replace: `  const response = await fetch(\`\${base}/v2/checkout/orders/\${orderID}/capture\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${accessToken}\`,
      // derived from the order, so a retried capture returns the original
      // result instead of ORDER_ALREADY_CAPTURED
      "PayPal-Request-Id": \`capture-\${orderID}\`,
    },`,
      },
    ],
  },
  {
    key: 'fix|capture-status-unchecked|server.js|POST /api/orders/:orderID/capture|1',
    explanation:
      'The capture route marked the order paid whenever the order-level status was COMPLETED. PayPal reports the order as COMPLETED even when the capture inside it is PENDING (funds not credited yet) or DECLINED. The route now reads purchase_units[0].payments.captures[0].status and only marks the order paid on COMPLETED; PENDING is recorded as pending and anything else as declined.',
    notes: '',
    edits: [
      {
        file: 'server.js',
        find: `    const order = orders.get(orderID);
    if (order && jsonResponse.status === "COMPLETED") {
      order.status = "paid";
      order.captureId = jsonResponse.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    }`,
        replace: `    const order = orders.get(orderID);
    // The order can be COMPLETED while the capture in it is PENDING or DECLINED,
    // so the capture status is what decides whether we got paid.
    const capture = jsonResponse.purchase_units?.[0]?.payments?.captures?.[0];
    if (order && capture) {
      order.captureId = capture.id;
      if (capture.status === "COMPLETED") order.status = "paid";
      else if (capture.status === "PENDING") order.status = "pending";
      else order.status = "declined";
    }`,
      },
    ],
  },
  {
    key: 'fix|capture-status-unchecked|server.js|POST /api/paypal/webhook|1',
    explanation:
      'The webhook handler marked an order paid on PAYMENT.CAPTURE.PENDING as well as PAYMENT.CAPTURE.COMPLETED. A pending capture means PayPal has not credited the money yet and it can still be denied. Only COMPLETED marks the order paid now; PENDING records the order as pending until the COMPLETED event arrives.',
    notes: '',
    edits: [
      {
        file: 'server.js',
        find: `  if (order && (event.event_type === "PAYMENT.CAPTURE.COMPLETED" || event.event_type === "PAYMENT.CAPTURE.PENDING")) {
    order.status = "paid";
    order.captureId = event.resource.id;
  }`,
        replace: `  if (order && event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    order.status = "paid";
    order.captureId = event.resource.id;
  } else if (order && event.event_type === "PAYMENT.CAPTURE.PENDING" && order.status !== "paid") {
    // funds not credited yet - wait for PAYMENT.CAPTURE.COMPLETED
    order.status = "pending";
    order.captureId = event.resource.id;
  }`,
      },
    ],
  },
  {
    key: 'fix|webhook-unverified|server.js|POST /api/paypal/webhook|1',
    explanation:
      'The webhook endpoint trusted whatever JSON was posted to it, so anyone who found the URL could send a fake PAYMENT.CAPTURE.COMPLETED and get an order marked paid. The handler now asks PayPal\'s verify-webhook-signature endpoint to check the transmission headers against our webhook id, posting the event back exactly as received, and answers 400 without touching the order unless PayPal says SUCCESS.',
    notes: 'Set PAYPAL_WEBHOOK_ID to the id of the webhook subscription in the PayPal developer dashboard.',
    edits: [
      {
        file: 'server.js',
        find: 'import { createOrder, captureOrder, refundCapture } from "./paypal.js";',
        replace: 'import { createOrder, captureOrder, refundCapture, verifyWebhookSignature } from "./paypal.js";',
      },
      {
        file: 'server.js',
        find: 'app.use(express.json());',
        replace: `// Keep the raw body: webhook verification needs the event exactly as PayPal sent it.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);`,
      },
      {
        file: 'server.js',
        find: `app.post("/api/paypal/webhook", async (req, res) => {
  const event = req.body;`,
        replace: `app.post("/api/paypal/webhook", async (req, res) => {
  let verified = false;
  try {
    verified = await verifyWebhookSignature(req.headers, req.rawBody);
  } catch (error) {
    console.error("Webhook verification failed:", error);
  }
  if (!verified) {
    return res.sendStatus(400);
  }
  const event = req.body;`,
      },
      {
        file: 'paypal.js',
        find: 'async function handleResponse(response) {',
        replace: `// Ask PayPal whether a webhook really came from PayPal. The event has to be
// posted back exactly as received, so the raw body is spliced in as-is.
export async function verifyWebhookSignature(headers, rawBody) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId || !rawBody) return false;
  const fields = {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: webhookId,
  };
  if (Object.values(fields).some((v) => !v)) return false;
  const accessToken = await generateAccessToken();
  const response = await fetch(\`\${base}/v1/notifications/verify-webhook-signature\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${accessToken}\`,
    },
    body: \`\${JSON.stringify(fields).slice(0, -1)},"webhook_event":\${rawBody}}\`,
  });
  const data = await response.json();
  return data.verification_status === "SUCCESS";
}

async function handleResponse(response) {`,
      },
    ],
  },
];

let tree = new VirtualTree((file) => {
  const abs = path.join(ROOT, file);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
});

for (const p of PATCHES) {
  tree = applyEdits(tree, p.edits).tree; // throws if a find doesn't match
  const file = fixturePath(TARGET, p.key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fixture = {
    key: p.key,
    model: 'claude-opus-5-5',
    handWritten: true,
    note: 'Hand-written stand-in for a model response so the demo runs without an API key. Re-record with --llm record.',
    output: { explanation: p.explanation, edits: p.edits, notes: p.notes },
  };
  fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log('wrote', path.relative(process.cwd(), file));
}

if (process.argv.includes('--print')) {
  for (const [file, content] of tree.overrides) console.log(`\n===== ${file}\n${content}`);
}
