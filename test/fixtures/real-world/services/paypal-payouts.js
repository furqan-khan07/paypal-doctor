// PayPal: payouts live under /v1/payments and are current; the sale refund is the deprecated one.
export const payout = (base, body) => fetch(`${base}/v1/payments/payouts`, { method: 'POST', body });
export const oldRefund = (base, id) => fetch(`${base}/v1/payments/sale/${id}/refund`, { method: 'POST' });
