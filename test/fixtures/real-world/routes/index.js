const webhooks = require('../controllers/webhooks');
module.exports = (router, sdk) => {
  router.post('/paypal/webhook', webhooks.onPayPalEvent);
  router.post('/paypal/webhook-checked', webhooks.onPayPalEventChecked);
  router.post('/stripe/webhook', webhooks.onStripeEvent);
  // Hands the headers to a provider SDK this tool can't see into.
  router.post('/paypal/webhook-sdk', async (req, res) => {
    await sdk.webhooks.process({ body: req.body, headers: req.headers });
    res.sendStatus(200);
  });
};
