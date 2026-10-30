// Thin wrapper around the PayPal REST API.
// Started from PayPal's sample server and grew from there.

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "kiln-sandbox-client";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "kiln-sandbox-secret-2024";
const base = "https://api-m.sandbox.paypal.com";

export async function generateAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    body: "grant_type=client_credentials",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const data = await response.json();
  if (!data.access_token) {
    throw new Error(`PayPal auth failed (${response.status})`);
  }
  return data.access_token;
}

export async function createOrder(total) {
  const accessToken = await generateAccessToken();
  const payload = {
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: "USD",
          value: String(total),
        },
      },
    ],
  };

  const response = await fetch(`${base}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  return handleResponse(response);
}

export async function captureOrder(orderID) {
  const accessToken = await generateAccessToken();
  const response = await fetch(`${base}/v2/checkout/orders/${orderID}/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return handleResponse(response);
}

// Refunds still go through the old endpoint we used before the v2 migration.
export async function refundCapture(captureId, amount) {
  const accessToken = await generateAccessToken();
  const response = await fetch(`${base}/v1/payments/capture/${captureId}/refund`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ amount: { total: amount, currency: "USD" } }),
  });

  return handleResponse(response);
}

async function handleResponse(response) {
  let jsonResponse = {};
  try {
    jsonResponse = await response.json();
  } catch {
    // some endpoints return an empty body
  }
  return { jsonResponse, httpStatusCode: response.status };
}
