// /v1/payments on other gateways, and PayPal's current Payouts API: not deprecated Payments v1.
export const mercado = (id) => fetch(`https://api.example-gateway.com/v1/payments/${id}`);
export const getnet = () => fetch('https://api.example-gateway.com/v1/payments/credit', { method: 'POST' });
