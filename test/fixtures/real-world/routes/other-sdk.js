// A Stripe-only router whose SDK happens to have a method named like a PayPal helper.
import { paykit } from 'some-payments-sdk';
export function mount(router) {
  router.post('/webhooks', async (req, res) => {
    paykit.webhooks.captureOrder({ secret: process.env.STRIPE_WEBHOOK_SECRET });
    res.sendStatus(200);
  });
}
const webhooks = require('../controllers/webhooks');
export function mountStripe(router) {
  router.post('/stripe/hook', webhooks.receiveStripeHook);
}
