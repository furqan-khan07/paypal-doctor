# paypal-doctor

Finds PayPal integration bugs in a Node.js codebase, writes the fix, and then proves the fix works by running a real checkout against the PayPal sandbox, before and after the patch.

![paypal-doctor dashboard](docs/dashboard.png)

## Why

Most PayPal bugs don't crash anything. They lose money quietly. A webhook handler that believes any JSON posted to it. A cart total summed from prices the browser sent. A capture that came back `PENDING` but got treated as paid. A retry after a timeout that hits `ORDER_ALREADY_CAPTURED`, so the shop never records a payment it actually took.

A linter can flag the line, but "this might be wrong" is easy to ignore. I wanted a tool that shows the bug happening and then shows it gone. It's the same find-then-verify idea as my earlier project pandas-doctor, which finds slow pandas code and checks the faster version gives the same answer.

## What it does

```
scan  ──►  fix  ──►  verify
```

**Scan.** Two passes. First, AST detectors (Babel parser, plus a small data-flow pass that follows a value across functions and files) for eight rules, each tied to a PayPal doc. Then a Claude review pass gets the PayPal-related files plus the static findings and looks for what they missed. Its findings are only kept if they name a known rule and quote evidence that's really on that line.

**Fix.** For each finding, Claude writes a minimal patch (find/replace edits) and a plain-English explanation. Patches form a chain: patch N is written against the code with patches 1..N-1 already applied, so each one can be tested on its own. A patch that doesn't apply cleanly, or doesn't parse afterwards, gets one retry with the error, then it's rejected.

**Verify.** For each patch, the app is copied twice (before and after the patch), started with a fetch interceptor preloaded, and driven through a scripted checkout:

- The **probe** plays the buyer with no browser: it approves the order through `confirm-payment-source` using PayPal's published sandbox test card, then lets the app capture.
- The **interceptor** records every PayPal call (credentials reduced to a fingerprint, card numbers masked). It can reroute hosts, and it can inject faults: drop a response after PayPal processed it, rewrite a capture to `PENDING`, add PayPal's negative-testing header. It refuses to let anything reach the live API.
- A patch is **verified** when the probe fails before it (the bug is reproduced) and passes after it. Then every probe runs once more on the fully patched app, and the static scan runs again, as a regression pass.

**Dashboard.** An AG Grid page with the findings, their patches and the before/after proof, plus a second grid with every PayPal request the probes made: status, `PayPal-Request-Id`, what PayPal said, which fault was injected, and the debug id.

## The rules

| Rule | What goes wrong |
|---|---|
| `client-supplied-amount` | Order total computed from prices in the request body; anyone can pay $0.01 |
| `webhook-unverified` | Webhook acted on without verify-webhook-signature; a forged event marks orders paid |
| `capture-status-unchecked` | Order marked paid without checking `captures[0].status` (PENDING / DECLINED) |
| `deprecated-v1-payments` | Calls to the deprecated `/v1/payments` API |
| `hardcoded-credentials` | Client secret in source, often as an env-var fallback |
| `amount-formatting` | Float math sent as the amount (`"0.30000000000000004"`), or decimals on JPY/HUF/TWD |
| `missing-request-id` | No (or a constant) `PayPal-Request-Id` on create/capture/refund |
| `hardcoded-environment` | Sandbox/live host hardcoded instead of configured |
| `deprecated-sdk` | `paypal-rest-sdk` / `@paypal/checkout-server-sdk` |

[docs/rules.md](docs/rules.md) has the exact detection logic, how each probe proves it, and the PayPal doc each rule rests on.

## Quick start (no keys needed)

Needs Node 20.10+.

```bash
git clone https://github.com/furqan-khan07/paypal-doctor.git
cd paypal-doctor
npm install
npm run demo
```

That scans the demo store in `demo-store/` (a small shop with nine bugs seeded on purpose), applies the patches, verifies each one against a local PayPal mock, and opens the dashboard at http://localhost:4417.

Without an `ANTHROPIC_API_KEY`, the Claude steps replay recorded answers from `src/llm/fixtures/`. The dashboard marks those as recorded, and the ones shipped for the demo are labelled hand-written. Without PayPal keys, the probes talk to the mock in `src/mock-paypal/`.

## With real keys: Claude + the PayPal sandbox

1. Create a sandbox app at [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials (Sandbox). Make sure card payments are enabled for it: the probes approve orders with a sandbox test card.
2. Get an API key from [console.anthropic.com](https://console.anthropic.com).
3. `cp .env.example .env` and fill in `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `ANTHROPIC_API_KEY`. `.env` is gitignored, and the tool never prints or logs the values.
4. Check the sandbox app can do everything the probes need:

```bash
node bin/paypal-doctor.js preflight
```

5. Run everything for real:

```bash
npm run demo:real
```

This is `paypal-doctor run demo-store --mode sandbox --llm live --dashboard`: live Claude calls for the review and the patches, and real sandbox orders, captures and refunds for the probes. A few checks always run on the mock, and the dashboard says which:

- the "a correctly signed webhook is accepted" check, because only PayPal can sign an event, and it only does that when delivering to a public URL;
- the credentials probe, so fake credentials never get sent to PayPal.

If `PAYPAL_WEBHOOK_ID` is empty, the doctor creates (or reuses) a webhook on your sandbox app pointing at `https://example.com/paypal-doctor-probe`. It needs a webhook id to call verify-webhook-signature.

To save the live answers as fixtures for offline demos, run with `--llm record` instead of `live`.

## Using it on your own app

paypal-doctor needs to know how to start your app and which routes do what. Put a `paypal-doctor.json` in the app's root. Here's the demo store's:

```json
{
  "name": "kiln-and-co",
  "start": "node server.js",
  "readyPath": "/healthz",
  "env": { "port": "PORT", "apiBase": "PAYPAL_API_BASE", "clientId": "PAYPAL_CLIENT_ID",
           "clientSecret": "PAYPAL_CLIENT_SECRET", "webhookId": "PAYPAL_WEBHOOK_ID" },
  "routes": {
    "createOrder": "POST /api/orders",
    "captureOrder": "POST /api/orders/:orderID/capture",
    "refundOrder": "POST /api/orders/:orderID/refund",
    "webhook": "POST /api/paypal/webhook",
    "orderStatus": "GET /api/store-orders/:orderID"
  },
  "orderIdField": "id",
  "statusField": "status",
  "paidStatuses": ["paid"],
  "carts": {
    "standard":   { "body": { "cart": [{ "sku": "mug", "price": 18, "quantity": 1 }] },     "expect": { "currency_code": "USD", "value": "18.00" } },
    "tampered":   { "body": { "cart": [{ "sku": "mug", "price": 0.01, "quantity": 1 }] },   "expect": { "currency_code": "USD", "value": "18.00" } },
    "fractional": { "body": { "cart": [{ "sku": "sticker", "price": 0.1, "quantity": 3 }] }, "expect": { "currency_code": "USD", "value": "0.30" } }
  }
}
```

`orderStatus` should return your app's own record of the order, so a probe can tell whether the app thinks it got paid. Then:

```bash
node bin/paypal-doctor.js run path/to/app --mode sandbox
node bin/paypal-doctor.js dashboard
node bin/paypal-doctor.js apply path/to/app --yes   # write the verified patches into the app
```

The static scan works on any repo, config or not. Probes need the config, and an app that talks to PayPal through `fetch`.

## CLI

```
paypal-doctor run <dir> [--mode mock|sandbox] [--llm auto|live|replay|record|off] [--dashboard]
paypal-doctor scan <dir>       static detectors + Claude review
paypal-doctor fix <dir>        one patch per finding
paypal-doctor verify <dir>     before/after probes, then the regression pass
paypal-doctor apply <dir> --yes
paypal-doctor dashboard [--port 4417]
paypal-doctor mock [--port 4455]     the PayPal mock on its own (point PAYPAL_API_BASE at it)
paypal-doctor preflight              sandbox readiness check
paypal-doctor status                 which keys are set (never prints them)
```

`--keep` on verify/run keeps the temp copies of the app and the raw traces around for poking at.

## How it's built

```
bin/paypal-doctor.js        CLI
src/scan/                   Babel AST detectors, data-flow helpers, Claude review pass
src/fix/                    patch chain, find/replace edits, diffing
src/llm/                    Claude client (live / record / replay), fixtures
src/verify/                 app runner, fetch interceptor, probes, sandbox client
src/mock-paypal/            local stand-in for the Orders v2 / Payments v2 / Webhooks APIs the probes use
dashboard/                  AG Grid dashboard + tiny HTTP server (SSE for live logs)
demo-store/                 Kiln & Co., the deliberately broken shop
```

- **Claude**: `claude-opus-5-5` through the official `@anthropic-ai/sdk`, with structured outputs (a JSON schema for findings and for patches), prompt caching on the rule-catalog system prompt, and server-side refusal fallbacks. Override the model with `PAYPAL_DOCTOR_MODEL`.
- **PayPal**: Orders v2 (create, confirm-payment-source, capture), Payments v2 (refund), Webhooks (verify-webhook-signature, webhook list/create), OAuth2 client credentials, `PayPal-Request-Id` idempotency, the `PayPal-Mock-Response` negative-testing header, and sandbox card rejection triggers.
- **AG Grid Community** (MIT) for both grids: custom cell renderers, the theming API wired to the page's CSS variables (light and dark), quick filters, column filters and sorting.
- No build step, no database. Node 20 built-ins plus four dependencies.

## Safety

- Requests to `api-m.paypal.com` (live) are blocked inside the app under test, whatever it's configured with.
- Secrets are read from `.env` or the environment and never printed. Log lines, the app's own output and traces all go through a redactor. Authorization headers are stored as a 12-character fingerprint.
- The dashboard only listens on 127.0.0.1 and refuses cross-origin POSTs, so another site can't make it run things.
- `apply` doesn't touch your code without `--yes`.

## Limitations

- JavaScript/TypeScript on Node only. The probes see traffic made with global `fetch`; apps using axios or `@paypal/paypal-server-sdk` still get the static scan and the patches, but not the before/after proof (yet).
- The data-flow pass is deliberately small: local bindings plus two hops across call sites. It will miss things a real taint engine would catch. The Claude pass is there partly to cover that.
- The mock is not a PayPal emulator. It implements the behaviour the probes rely on, and every check that matters can also run against the real sandbox.
- `PENDING` captures can't be triggered on demand in the sandbox, so that scenario rewrites a real sandbox capture response to `PENDING` with `PENDING_REVIEW`. The dashboard labels it as an injected fault.

## Tests

```bash
npm test
```

The tests cover the detectors (true positives and the exemptions that keep them quiet on correct code) and the mock's PayPal behaviour. There's an end-to-end scan → fix → verify of the demo store, the sandbox code path with the mock standing in for PayPal, and the Claude client's request shape against a fake API.

## License

MIT. See [LICENSE](LICENSE).
