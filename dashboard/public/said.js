// One line for the "PayPal said" column. The hosted demo works this out at build
// time, so the raw PayPal responses never get published.
export function saidOf(t) {
  const b = t.responseBody;
  if (t.error) return t.error;
  if (t.said) return t.said;
  if (!b || typeof b !== 'object') return '';
  if (b.details?.[0]?.issue) return b.details[0].issue;
  if (b.verification_status) return `verification ${b.verification_status}`;
  const cap = b.purchase_units?.[0]?.payments?.captures?.[0];
  if (cap) return `order ${b.status}, capture ${cap.status}`;
  if (b.access_token) return 'access token';
  if (b.status) return `${b.id ? `${b.id} ` : ''}${b.status}`;
  if (b.state) return `v1 ${b.state}`;
  return b.name || '';
}
