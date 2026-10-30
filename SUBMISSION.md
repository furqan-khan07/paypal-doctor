# Devpost submission draft

Draft for the PayPal AI Hackathon page. Edit freely; it's written in your voice, but check every claim against what you actually ran (sandbox numbers especially). Submissions close **Thu Nov 12, 2026, 12:00pm PT**.

---

## Name

paypal-doctor

## Tagline (short)

Finds PayPal integration bugs, writes the fix, and proves it in the sandbox: the bug before the patch, gone after.

## Inspiration

PayPal integration bugs rarely crash anything. They lose money quietly. A webhook URL that accepts any JSON as proof of payment. A checkout whose total is summed from prices the browser sent. A capture that came back `PENDING` and got treated as paid. A timeout and a retry that answers `ORDER_ALREADY_CAPTURED`, so the shop never records a payment it actually took.

Static analysis can point at the line, but a warning is easy to ignore. I wanted something closer to a failing test: show the bug happening against PayPal, apply a fix, and show it not happening. I'd built the same find-then-verify loop before for pandas performance (pandas-doctor), and payments felt like the place where proof matters most.

## What it does

paypal-doctor runs on a Node.js codebase in three stages.

1. **Find.** AST detectors check eight rules, each backed by a PayPal doc: the deprecated v1 Payments API and deprecated SDKs, unverified webhooks, a missing or constant `PayPal-Request-Id`, an unchecked capture status, client-supplied amounts, a hardcoded environment or credentials, and float/decimal amount formatting. A small data-flow pass follows values across functions and files, so it can tell that `amount.value` in `paypal.js` comes from `item.price` in the request body in `server.js`. Then Claude reviews the PayPal-related files for what the detectors missed. On the demo it catches a webhook handler that treats `PAYMENT.CAPTURE.PENDING` as paid. Its findings are only kept if they cite a known rule and quote evidence that's really on that line.
2. **Fix.** Claude writes a minimal patch for each finding, with a plain-English explanation. The patches form a chain, each written on top of the previous ones, so each can be verified in isolation.
3. **Verify.** For every patch, the app is started twice, once before the patch and once after, with an interceptor preloaded that records every PayPal call. A probe then runs a real checkout against the PayPal sandbox. No browser is involved: the probe plays the buyer by approving the order with a sandbox test card through `confirm-payment-source`. A patch counts as verified only if the probe **fails before it and passes after it**. Then every probe runs again on the fully patched app, as a regression pass.

Some of the proofs:

- **Forged webhook:** a fake `PAYMENT.CAPTURE.COMPLETED` marks the order paid before the patch. After it, the app asks PayPal's verify-webhook-signature, gets `FAILURE`, and answers 400. A correctly signed event is still accepted.
- **Lost capture response:** PayPal processes the capture, the interceptor drops the response, and the browser retries. Before the patch: `ORDER_ALREADY_CAPTURED`, and the order stays unpaid even though the money moved. After: the retry reuses `PayPal-Request-Id` and gets the original capture back.
- **$0.01 cart:** before, PayPal is asked for $0.01. After, for the catalog price.
- **3 x $0.10 stickers:** before, `"0.30000000000000004"` gets `DECIMAL_PRECISION`. After, `"0.30"` is accepted.
- **PENDING / DECLINED captures:** PayPal's own `CCREJECT-REFUSED` card trigger produces a declined capture, and an injected `PENDING_REVIEW` capture covers the pending case. Before the patch, both get marked paid.

Everything lands in a dashboard built on AG Grid. One grid has the findings with severity, location, who found it (static or Claude), the patch and the before → after proof. A detail panel shows the flagged code, the explanation, every probe check and the diff. A second grid lists every PayPal request the probes made: phase, status, what PayPal said, the `PayPal-Request-Id`, which fault was injected, and the PayPal debug id.

## How I built it

- **Node 20, no build step.** `@babel/parser` for the AST, a hand-rolled walker and data-flow helpers, and the `diff` package for patches.
- **Claude (`claude-opus-5-5`) through the official Anthropic SDK.** It uses structured outputs (a JSON schema for findings and one for patches), prompt caching on the rule-catalog system prompt, and server-side refusal fallbacks. Patches are find/replace edits rather than unified diffs, because they apply far more reliably. A patch that doesn't apply cleanly or doesn't parse afterwards goes back to the model once with the error.
- **PayPal developer platform:**
  - Orders v2: create, `confirm-payment-source` with sandbox test cards, capture.
  - Payments v2: refund.
  - Webhooks: verify-webhook-signature, list/create.
  - OAuth2 client credentials, `PayPal-Request-Id` idempotency, the `PayPal-Mock-Response` negative-testing header, and the sandbox card rejection triggers.
- **A fetch interceptor** loaded into the app under test with `node --import`. It records traffic with secrets redacted, reroutes hosts (that's how the "base URL comes from config" probe works), injects faults, and hard-blocks the live API.
- **A local PayPal mock** implementing the behaviour the probes rely on: validation errors like `DECIMAL_PRECISION`, approval, idempotent replay, `ORDER_ALREADY_CAPTURED`, card declines, and webhook signature verification. With it, the whole thing runs with no keys and in CI.
- **AG Grid Community** (MIT) for the dashboard. It uses custom cell renderers, the theming API driven by CSS variables for light and dark, quick filters, column filters and row selection. Server-sent events stream the run log live.
- **Kiln & Co.**, a demo Express shop with nine bugs seeded on purpose.

## Challenges

- **Approving an order without a browser.** PayPal checkout normally needs a buyer clicking through a popup. `confirm-payment-source` with a sandbox test card turned out to be the clean way to get an order to `APPROVED` from a script.
- **Some states you can't trigger on demand.** There's no sandbox switch for "this capture is PENDING", so that scenario takes a real sandbox capture response and rewrites the capture status. The dashboard labels it as an injected fault, not as something PayPal did.
- **Proving a fix, not just applying one.** The before/after design means a probe has to *fail* on the buggy code. A patch that makes the app reject every webhook would pass a naive test. So each probe also has a positive check: a correctly signed event is still accepted, a normal capture still marks the order paid, an honest cart still checks out.
- **Keeping secrets out of everything.** Credentials are reduced to a fingerprint in traces, the app's own logs are redacted, and the dashboard only binds to localhost.

## Accomplishments

- On the demo store, all ten findings (nine static, one from Claude) get patched. Each one is reproduced before its patch and gone after it, the regression pass is 10/10, and a re-scan of the patched code comes back clean.
- [Fill in after running `npm run demo:real`: the number of real sandbox calls, how long it took, and anything surprising.]

## What I learned

- PayPal's order-level `status: COMPLETED` doesn't mean you were paid. The capture inside it is what counts.
- `PayPal-Request-Id` is the difference between a retry and a duplicate. It matters most exactly when something already went wrong.
- An LLM is much more useful in this loop when its output is checked: evidence has to be on the line it cites, and patches have to apply and parse before anything else happens.

## What's next

- Probe traffic made through axios and `@paypal/paypal-server-sdk`, not just fetch.
- Open the pull request on GitHub directly. Today `apply --commits` makes one commit per verified patch with the proof in each message, and writes the PR description.
- Python and Java integrations, and the rules I left out because I couldn't tie them to a PayPal doc yet (webhook event-id dedupe, refunds trusted from the client).

## Built with

node.js, javascript, paypal-rest-api, paypal-orders-v2, paypal-webhooks, claude, anthropic-api, ag-grid, babel, express

## Try it

Repo: https://github.com/furqan-khan07/paypal-doctor (MIT). `npm install && npm run demo` runs without any keys. `npm run demo:real` uses the sandbox and Claude.

---

## AI tools used (required field)

The rules ask for a list of the AI tools used. List every one honestly, including anything you used while building, not just inside the product.

- **Claude API (`claude-opus-5-5`, Anthropic):** inside the product. It runs the review pass that finds integration bugs the static detectors miss, and it writes each patch and its explanation. It's called with structured outputs, prompt caching and server-side fallbacks. Its output is validated before use: rule ids, evidence on the cited line, patches that apply and parse.
- **[You fill in:** the tools you used while building and making the video.**]**

---

## Video shot list (target 2:45, hard limit 3:00)

Record at 1440x900 or larger, dark theme, with the terminal font bumped up. Run `npm run demo:real` once beforehand so the sandbox numbers are real. Then re-run it live or cut to the finished run.

| Time | Shot | Say (roughly) |
|---|---|---|
| 0:00-0:15 | Kiln & Co. storefront with PayPal buttons (sandbox). | "This shop takes PayPal. It works, it passes its tests, and it's quietly losing money in nine different ways." |
| 0:15-0:35 | Devtools: set the mug's price to 0.01 in localStorage, check out with a sandbox buyer, PayPal shows $0.01. Then a one-line `curl` posting a fake webhook, and the order flips to "paid". | "Edit the cart, pay a cent. Or skip paying and just tell the webhook you did." |
| 0:35-0:55 | Terminal: `npm run demo:real`. Scan output with 10 findings, the one from Claude marked. | "paypal-doctor scans the code: AST detectors for eight rules backed by PayPal's docs, then Claude reviews what they missed." |
| 0:55-1:15 | Patches streaming in, then verify lines: "before: failed - bug reproduced, after: passed → verified". | "Claude writes a minimal patch per bug. Then each patch is proven: the app runs a real sandbox checkout before and after the patch." |
| 1:15-1:50 | Dashboard. Findings grid, click the $0.01 bug: the data flow across files, the explanation, before ✗ / after ✓, the diff. | "Before: PayPal was asked for one cent. After: eighteen dollars. That's the sandbox, not a mock." |
| 1:50-2:15 | Click the capture-retry finding. Open the traffic grid filtered to it: a capture with the "response dropped" fault, then the retry with the same PayPal-Request-Id returning 201. | "The scariest one: PayPal takes the money, the response gets lost, the retry fails, and the order says unpaid. With an idempotency key, the retry gets the original capture back." |
| 2:15-2:30 | Webhook finding: the forged event is rejected, verify-webhook-signature says FAILURE, and a signed event is still accepted. | |
| 2:30-2:45 | Regression pass tab at 10/10, then `apply <copy of the store> --yes --commits` and `git log --oneline` showing ten fix commits; open one commit message showing its before/after proof. | "Every probe green on the patched app, re-scan clean. You get one commit per fix, each carrying its own proof." |
| 2:45-2:55 | README rules table + "npm run demo runs without keys". | "Open source, MIT, runs offline against a PayPal mock, or against your sandbox with your keys." |

Things to double-check before recording: card payments are enabled for the sandbox app (`node bin/paypal-doctor.js preflight` is all green), the dashboard has a fresh sandbox run (the "PayPal calls" tile says "against the sandbox"), and no `.env` value is visible on screen.
