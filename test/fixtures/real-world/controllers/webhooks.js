const orders = new Map();

// Unverified, and defined in a different file from its route.
exports.onPayPalEvent = async (req, res) => {
  const event = req.body;
  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') orders.set(event.resource.id, 'paid');
  res.sendStatus(200);
};

// Verified two helpers down.
exports.onPayPalEventChecked = async (req, res) => {
  if (!(await checkDelivery(req))) return res.sendStatus(400);
  orders.set(req.body.resource.id, 'paid');
  res.sendStatus(200);
};
async function checkDelivery(req) {
  return askPayPal(req.headers, req.body);
}
async function askPayPal(headers, body) {
  const res = await fetch('/v1/notifications/verify-webhook-signature', { method: 'POST', body: JSON.stringify({ headers, body }) });
  return (await res.json()).verification_status === 'SUCCESS';
}

// Stripe's webhook is none of this tool's business.
exports.onStripeEvent = async (req, res) => {
  const event = req.body;
  if (event.type === 'charge.succeeded') orders.set(event.data.object.id, 'paid');
  res.sendStatus(200);
};
