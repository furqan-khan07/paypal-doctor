// A fallback behind config isn't hardcoded; a secret in array destructuring is.
const keys = { paypal: {} };
export const verifyUrl = keys.paypal.verifyUrl || 'https://api.sandbox.paypal.com/v1/notifications/verify-webhook-signature';
const [SANDBOX_ID, SANDBOX_SECRET] = ['pp-sandbox-id-value', 'pp-sandbox-secret-value'];
export { SANDBOX_ID, SANDBOX_SECRET };

// An SDK controller passed in from elsewhere, with no import of the SDK in this file.
export async function captureWithController(ordersController, id, record) {
  const res = await ordersController.captureOrder({ id });
  if (res.result.status === 'COMPLETED') record.state = 'paid';
}
