// Environment switch done right: none of these should be flagged.
const HOSTS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};
export const base = HOSTS[process.env.PAYPAL_ENV || "sandbox"];
export const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
export const placeholder = { client_secret: "YOUR_CLIENT_SECRET" };
