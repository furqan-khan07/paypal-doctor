const PAYPAL_API = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";

export async function createYenOrder(token, totalYen) {
  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": "order-1" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "JPY", value: totalYen.toFixed(2) } }],
    }),
  });
  return res.json();
}

export async function refund(token, captureId) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const res = await fetch(`${PAYPAL_API}/v2/payments/captures/${captureId}/refund`, { method: "POST", headers });
  return res.json();
}
