// The rule catalog. Every rule here is backed by at least one PayPal doc
// (or the npm deprecation notice PayPal published). Rules I couldn't back
// with a doc link didn't make it in - see docs/rules.md for the list.

export const RULES = [
  {
    id: 'deprecated-v1-payments',
    title: 'Deprecated v1 Payments API',
    severity: 'high',
    summary:
      'Calls an endpoint under /v1/payments, which PayPal marks deprecated. New capabilities and fixes ship on Orders v2 and Payments v2.',
    fixGuidance:
      'Move the call to the v2 equivalent. Refunds: POST /v2/payments/captures/{capture_id}/refund (amount as {value, currency_code}). Checkout: POST /v2/checkout/orders. Keep the same route behaviour for callers.',
    docs: [
      { label: 'Payments v1 reference - "The /v1/payments endpoint is deprecated"', url: 'https://developer.paypal.com/docs/api/payments/v1/' },
      { label: 'Payments v2: refund captured payment', url: 'https://developer.paypal.com/docs/api/payments/v2/#captures_refund' },
    ],
    probe: 'v1-api',
  },
  {
    id: 'deprecated-sdk',
    title: 'Deprecated PayPal SDK',
    severity: 'medium',
    summary:
      'Depends on paypal-rest-sdk or @paypal/checkout-server-sdk. Both are marked deprecated on npm by PayPal, which points to @paypal/paypal-server-sdk.',
    fixGuidance:
      'Replace the dependency with @paypal/paypal-server-sdk, or with direct fetch calls to the v2 REST APIs.',
    docs: [
      { label: 'npm: paypal-rest-sdk (deprecated)', url: 'https://www.npmjs.com/package/paypal-rest-sdk' },
      { label: 'npm: @paypal/checkout-server-sdk (deprecated)', url: 'https://www.npmjs.com/package/@paypal/checkout-server-sdk' },
      { label: 'npm: @paypal/paypal-server-sdk (replacement)', url: 'https://www.npmjs.com/package/@paypal/paypal-server-sdk' },
    ],
    probe: null,
  },
  {
    id: 'webhook-unverified',
    title: 'Webhook trusted without signature verification',
    severity: 'critical',
    summary:
      'A webhook handler acts on the event body without verifying it came from PayPal. Anyone who can reach the URL can POST a fake PAYMENT.CAPTURE.COMPLETED and get an order marked paid.',
    fixGuidance:
      'Before acting on the event, call POST /v1/notifications/verify-webhook-signature with the paypal-auth-algo, paypal-cert-url, paypal-transmission-id, paypal-transmission-sig and paypal-transmission-time headers, your webhook id, and the event exactly as received. Only proceed when verification_status is SUCCESS; otherwise respond 400 and do nothing.',
    docs: [
      { label: 'Webhooks: verify the signature (postback or self-verification)', url: 'https://developer.paypal.com/api/rest/webhooks/rest/' },
      { label: 'Webhooks v1: verify-webhook-signature', url: 'https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature_post' },
    ],
    probe: 'webhook-forgery',
  },
  {
    id: 'missing-request-id',
    title: 'No PayPal-Request-Id on a money-moving POST',
    severity: 'medium',
    summary:
      'A create, capture, authorize or refund call is sent without a PayPal-Request-Id header (or with a constant one). If the response is lost and the call is retried, PayPal treats it as a new request instead of returning the original result.',
    fixGuidance:
      'Send a PayPal-Request-Id header. For an order capture or a full refund, derive it from the resource so retries reuse it (e.g. `capture-${orderID}`); for a partial refund, from your own refund record; for create, a fresh crypto.randomUUID() per checkout attempt. Never a constant, and never a value that changes on retry.',
    docs: [
      { label: 'REST API idempotency (PayPal-Request-Id)', url: 'https://developer.paypal.com/api/rest/reference/idempotency/' },
      { label: 'Orders v2: create / capture accept PayPal-Request-Id', url: 'https://developer.paypal.com/docs/api/orders/v2/#orders_capture' },
    ],
    probe: 'idempotency',
  },
  {
    id: 'capture-status-unchecked',
    title: 'Capture status not checked',
    severity: 'high',
    summary:
      'The order is treated as paid without checking purchase_units[].payments.captures[].status. A capture can come back PENDING (funds not credited yet - eCheck, review, receiving preferences) or DECLINED while the HTTP call itself succeeds.',
    fixGuidance:
      'Read purchase_units[0].payments.captures[0].status. Mark the order paid only on COMPLETED. Record PENDING as pending (wait for PAYMENT.CAPTURE.COMPLETED), and treat DECLINED/FAILED as unpaid. Do the same for webhook events: PAYMENT.CAPTURE.PENDING is not payment.',
    docs: [
      { label: 'Orders v2: capture response - captures[].status (COMPLETED, PENDING, DECLINED, ...)', url: 'https://developer.paypal.com/docs/api/orders/v2/#orders_capture' },
      { label: 'capture_status_details.reason values', url: 'https://developer.paypal.com/docs/api/orders/v2/#definition-capture_status_details' },
    ],
    probe: 'capture-status',
  },
  {
    id: 'client-supplied-amount',
    title: 'Order amount trusted from the client',
    severity: 'critical',
    summary:
      'The amount sent to PayPal is computed from prices or totals in the request body. A buyer can edit the cart in devtools and pay $0.01 for anything.',
    fixGuidance:
      'Take only item ids and quantities from the client. Look prices up in a server-side catalog and compute the total on the server.',
    docs: [
      { label: 'Standard checkout: the server calculates purchase units from the cart', url: 'https://developer.paypal.com/studio/checkout/standard/integrate' },
      { label: 'PayPal sample server: "use the cart information passed from the front-end to calculate the order amount"', url: 'https://github.com/paypal-examples/docs-examples/blob/main/standard-integration/server/node/server.js' },
    ],
    probe: 'client-amount',
  },
  {
    id: 'hardcoded-environment',
    title: 'PayPal environment hardcoded',
    severity: 'medium',
    summary:
      'The sandbox or live API host is hardcoded in code. Going live (or testing) means editing source, and it is easy to ship sandbox to prod or point tests at live.',
    fixGuidance:
      'Read the base URL from configuration (e.g. process.env.PAYPAL_API_BASE, defaulting to the sandbox host) instead of a literal in the request path.',
    docs: [
      { label: 'Go live: "Update your PayPal endpoint" and credentials', url: 'https://developer.paypal.com/studio/checkout/standard/integrate' },
      { label: 'Move your app to production: live host api-m.paypal.com', url: 'https://developer.paypal.com/api/rest/production/' },
    ],
    probe: 'hardcoded-env',
  },
  {
    id: 'hardcoded-credentials',
    title: 'PayPal credentials in source',
    severity: 'high',
    summary:
      'A client secret (or a client-id:secret pair) is written into the code, often as a fallback when the env var is missing. It ends up in git history and the app silently runs with the baked-in account.',
    fixGuidance:
      'Read PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from the environment only, and fail fast with a clear error when they are missing. Rotate any secret that was committed.',
    docs: [
      { label: 'Standard checkout: declare PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET as environment variables', url: 'https://developer.paypal.com/studio/checkout/standard/integrate' },
      { label: 'REST authentication: client secret - "Keep this secret safe"', url: 'https://developer.paypal.com/api/rest/' },
    ],
    probe: 'hardcoded-creds',
  },
  {
    id: 'amount-formatting',
    title: 'Amount not formatted for the currency',
    severity: 'high',
    summary:
      'amount.value is built from floating-point math without formatting (0.1 * 3 = 0.30000000000000004), or with two decimals for a zero-decimal currency like JPY. PayPal rejects it (DECIMAL_PRECISION) and checkout breaks for those carts.',
    fixGuidance:
      'Do money math in integer minor units (cents) and format with the currency\'s decimal places: 2 for most currencies, 0 for JPY, HUF and TWD. Send value as a string.',
    docs: [
      { label: 'Currency codes - JPY, HUF, TWD are zero-decimal', url: 'https://developer.paypal.com/reference/currency-codes/' },
      { label: 'Orders v2 errors: DECIMAL_PRECISION', url: 'https://developer.paypal.com/api/rest/reference/orders/v2/errors/' },
      { label: 'Orders v2: money.value is a string', url: 'https://developer.paypal.com/docs/api/orders/v2/#definition-money' },
    ],
    probe: 'amount-format',
  },
];

export const RULES_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));

export const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

// Currencies PayPal lists as zero-digit (no decimals).
export const ZERO_DECIMAL_CURRENCIES = new Set(['HUF', 'JPY', 'TWD']);

export const PAYPAL_CURRENCIES = new Set([
  'AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'HKD', 'HUF', 'ILS', 'JPY', 'MYR',
  'MXN', 'TWD', 'NZD', 'NOK', 'PHP', 'PLN', 'GBP', 'SGD', 'SEK', 'CHF', 'THB', 'USD',
]);
