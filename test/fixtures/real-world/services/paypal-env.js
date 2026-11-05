// Host literals that aren't a hardcoded environment.
export function resolveBase(settings, getSetting) {
  const saved = settings.find((s) => s.name === 'paypalBase');
  if (saved) return saved.value;
  return 'https://api-m.sandbox.paypal.com';
}
export const fromSetting = (getSetting) => getSetting('paypalBase', 'https://api-m.sandbox.paypal.com');
export function captureIdFromLink(link) {
  const prefix = 'https://api.paypal.com/v2/payments/captures/';
  return link.href.startsWith(prefix) ? link.href.replace(prefix, '') : null;
}
