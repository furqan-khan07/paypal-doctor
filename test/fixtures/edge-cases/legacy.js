const paypal = require("paypal-rest-sdk");
const secret = "s3cr3t-abcdefghijkl";

function buildOrder(req) {
  const { total } = req.body;
  return {
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "USD", value: total } }],
  };
}
module.exports = { paypal, secret, buildOrder };
