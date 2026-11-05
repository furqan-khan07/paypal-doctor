// A multi-provider config file: only the PayPal secret is this tool's business.
export default {
  sendgrid: { password: process.env.SENDGRID_PASSWORD || 'sg-not-a-paypal-secret' },
  facebook: { clientSecret: process.env.FACEBOOK_SECRET || 'fb-not-a-paypal-secret' },
  labels: { Password: 'Password', resetPassword: 'Reset your password' },
  paypal: {
    host: 'api.sandbox.paypal.com',
    client_secret: process.env.PAYPAL_SECRET || 'pp-baked-in-sandbox-secret',
  },
};
