// captureResponse.status is the HTTP status, not the capture's. This marks the checkout done anyway.
export async function finishCheckout(base, id, token, checkout) {
  const captureResponse = await fetch(`${base}/v2/checkout/orders/${id}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'PayPal-Request-Id': `capture-${id}` },
  });
  if (!captureResponse.ok) throw new Error(`capture failed ${captureResponse.status}`);
  checkout.status = 'COMPLETED';
  return checkout;
}

// A variable holding the capture counts as checking it.
export async function finishCheckoutProperly(base, id, token, order) {
  const res = await fetch(`${base}/v2/checkout/orders/${id}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'PayPal-Request-Id': `capture-${id}` },
  });
  const data = await res.json();
  const tx = data.purchase_units?.[0]?.payments?.captures?.[0];
  if (tx?.status === 'COMPLETED') order.state = 'paid';
}

// A fresh id on every call: a retry is not recognised as a retry.
export async function captureFreshId(base, id, token) {
  const res = await fetch(`${base}/v2/checkout/orders/${id}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'PayPal-Request-Id': crypto.randomUUID() },
  });
  return res.json();
}
