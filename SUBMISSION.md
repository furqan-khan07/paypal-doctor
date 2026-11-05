# Devpost submission draft

Draft for the PayPal AI Hackathon page. Edit freely; it's written in your voice, but check every claim against what you actually ran. Submissions close **Thu Nov 12, 2026, 12:00pm PT**. Sponsor prize to pick: **AG Grid**.

The numbers here come from the real runs on 2026-11-05, with real Claude and the real PayPal sandbox. `docs/real-runs.md` has both runs, including the one that got 3 of 11.

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

1. **Find.** AST detectors check nine rules, each backed by a PayPal doc: the deprecated v1 Payments API and deprecated SDKs, unverified webhooks, a missing or constant `PayPal-Request-Id`, an unchecked capture status, client-supplied amounts, a hardcoded environment or credentials, and float/decimal amount formatting. A small data-flow pass follows values across functions and files, so it can tell that `amount.value` in `paypal.js` comes from `item.price` in the request body in `server.js`. Then Claude reviews the PayPal-related files for what the detectors missed. On the demo it caught a webhook handler that treats `PAYMENT.CAPTURE.PENDING` as paid, which I'd seeded for it, and a refund call with no `PayPal-Request-Id`, which I hadn't. Its findings are only kept if they cite a known rule and quote evidence that's really on that line.
2. **Fix.** Claude writes a minimal patch for each finding, with a plain-English explanation. It sees the file with the bug, the files around it, and a sample request. The patches form a chain, each written on top of the previous ones, so each can be verified in isolation.
3. **Verify.** As soon as a patch is written, the app is started twice, once before the patch and once after, with an interceptor preloaded that records every PayPal call. A probe then runs a real checkout against the PayPal sandbox. No browser is involved: the probe plays the buyer by approving the order with a sandbox test card through `confirm-payment-source`. A patch counts as verified only if the probe **fails before it and passes after it**. One that fails goes back to Claude once with the failing checks, and if it still fails it's left out of the chain. At the end, every probe runs again on the fully patched app, as a regression pass.

Two of the eleven probes run on a local mock even in sandbox mode: the `PENDING` webhook, because only PayPal can sign an event, and the credentials probe, so fake credentials never get sent to PayPal. The dashboard says which proof used what.

Some of the proofs:

- **Forged webhook:** a fake `PAYMENT.CAPTURE.COMPLETED` marks the order paid before the patch. After it, the app asks PayPal's verify-webhook-signature, gets `FAILURE`, and answers 400. A correctly signed event is still accepted, which is checked on the mock.
- **Lost capture response:** PayPal processes the capture, the interceptor drops the response, and the browser retries. Before the patch: `ORDER_ALREADY_CAPTURED`, and the order stays unpaid even though the money moved. After: the retry reuses `PayPal-Request-Id` and gets the original capture back.
- **$0.01 cart:** before, PayPal is asked for $0.01. After, for the catalog price.
- **3 x $0.10 stickers:** before, `"0.30000000000000004"` gets `DECIMAL_PRECISION`. After, `"0.30"` is accepted.
- **PENDING / DECLINED captures:** PayPal's own `CCREJECT-REFUSED` card trigger produces a declined capture, and an injected `PENDING_REVIEW` capture covers the pending case. Before the patch, both get marked paid.

Everything lands in a dashboard built on AG Grid. One grid has the findings with severity, location, who found it (static or Claude), the patch and the before → after proof. A detail panel shows the flagged code, the explanation, every probe check and the diff. A second grid lists every PayPal request the probes made: phase, status, what PayPal said, the `PayPal-Request-Id`, which fault was injected, and the PayPal debug id.

## How I built it

- **Node 20, no build step.** `@babel/parser` for the AST, a hand-rolled walker and data-flow helpers, and the `diff` package for patches.
- **Claude (`claude-opus-5-5`) through the official Anthropic SDK.** It uses structured outputs (a JSON schema for findings and one for patches), prompt caching on the rule-catalog system prompt, and server-side refusal fallbacks. Patches are find/replace edits rather than unified diffs, because they apply far more reliably. A patch that doesn't apply cleanly, doesn't parse afterwards or fails its probe goes back to the model once with the error.
- **PayPal developer platform:**
  - Orders v2: create, `confirm-payment-source` with sandbox test cards, capture.
  - Payments v2: refund.
  - Webhooks: verify-webhook-signature, list/create.
  - OAuth2 client credentials, `PayPal-Request-Id` idempotency, the `PayPal-Mock-Response` negative-testing header, and the sandbox card rejection triggers.
- **An interceptor** loaded into the app under test with `node --import`. It wraps `fetch`, and bridges `node:http`/`https` through a Unix socket back into the same wrapper. It records traffic with secrets redacted, reroutes hosts (that's how the "base URL comes from config" probe works), injects faults, and hard-blocks the live API.
- **A local PayPal mock** implementing the behaviour the probes rely on: validation errors like `DECIMAL_PRECISION`, approval, idempotent replay, `ORDER_ALREADY_CAPTURED`, card declines, and webhook signature verification. With it, the whole thing runs with no keys and in CI.
- **AG Grid Community** (MIT) for the dashboard. It uses custom cell renderers, the theming API driven by CSS variables for light and dark, quick filters, column filters and row selection. Server-sent events stream the run log live.
- **Kiln & Co.**, a demo Express shop with ten bugs seeded on purpose. Nine are for the static detectors, and one is subtle enough that only the Claude review catches it. Claude also found an eleventh I hadn't planned.

## Challenges

- **My first real run verified 3 of 11 patches, and that was my tool's fault.** I was only showing Claude the file with the bug. The one-cent cart patch needed prices from a file it couldn't see, so it guessed cart items had an `id`. They have a `sku`, so every checkout broke. That patch stayed in the chain, so the next seven failed too. Claude's notes even said it couldn't see the file. I fixed the prompt and made each patch pass its probe before the next one gets written.
- **Approving an order without a browser.** PayPal checkout normally needs a buyer clicking through a popup. `confirm-payment-source` with a sandbox test card turned out to be the clean way to get an order to `APPROVED` from a script.
- **Some states you can't trigger on demand.** There's no sandbox switch for "this capture is PENDING", so that scenario takes a real sandbox capture response and rewrites the capture status. The dashboard labels it as an injected fault, not as something PayPal did.
- **Proving a fix, not just applying one.** The before/after design means a probe has to *fail* on the buggy code. A patch that makes the app reject every webhook would pass a naive test. So each probe also has a positive check: a correctly signed event is still accepted, a normal capture still marks the order paid, an honest cart still checks out.
- **Keeping secrets out of everything.** Credentials are reduced to a fingerprint in traces, the app's own logs are redacted, and the dashboard only binds to localhost.
- **Real code is nothing like your own demo.** The detectors were perfect on my seeded store and 80% wrong on real repos. They flagged Stripe webhooks and UI labels, one rule was simply wrong (`/v1/payments/payouts` is PayPal's current Payouts API), and about 1,900 files silently failed to parse because of TypeScript decorators, which took out whole NestJS apps.

## Accomplishments

- On the demo store, with real Claude and the real PayPal sandbox: 11 findings (nine static, two from Claude), 11 patches, all 11 verified on their first attempt. Each bug showed up before its patch and was gone after it, the regression pass is 11/11, and a re-scan of the patched code comes back clean. That's my second real run. The first got 3 of 11, and that's in Challenges.
- That run made 162 calls to the PayPal sandbox and took about four and a half minutes. Claude cost $0.51 for 12 calls, going by `response.usage`.
- Two things I didn't expect. Claude found a bug I hadn't seeded: a refund call with no `PayPal-Request-Id`. And the deprecated v1 refund endpoint still works on the sandbox, so that patch is about getting off a deprecated API, not fixing something broken today.
- I ran the static scan on 60 public PayPal repos and checked the findings by hand. The first run was bad: 189 of 237 findings were wrong. After fixing the detectors on a tuning set, I tested on 20 repos they'd never seen, and 23 of 27 findings were correct. I also read the PayPal code in those repos by hand and found 3 more it missed. The method and the caveats are in `docs/validation.md`.

## What I learned

- PayPal's order-level `status: COMPLETED` doesn't mean you were paid. The capture inside it is what counts.
- `PayPal-Request-Id` is the difference between a retry and a duplicate. It matters most exactly when something already went wrong.
- An LLM is much more useful in this loop when its output is checked: evidence has to be on the line it cites, and patches have to apply and parse before anything else happens.
- What looked like bad model output in my first run was mostly bad context from my own tool. The model's notes said so.
- A demo you seeded yourself proves very little. Holding back a set of repos and only running on it once was the only way I could get a number I believed.

## What's next

- Run the Claude steps and the probes on real apps, not only my demo. 11 of 11 on a shop I seeded says the loop works, not that the patches will pass on your app. That includes apps built on axios and `@paypal/paypal-server-sdk`: the interceptor already bridges `node:http`/`https`, but the demo only exercises fetch.
- Open the pull request on GitHub directly. Today `apply --commits` makes one commit per verified patch with the proof in each message, and writes the PR description.
- Python and Java integrations, and the rules I left out because I couldn't tie them to a PayPal doc yet (webhook event-id dedupe, refunds trusted from the client).

## Built with

node.js, javascript, paypal-rest-api, paypal-orders-v2, paypal-webhooks, claude, anthropic-api, ag-grid, babel, express

## Try it

Repo: https://github.com/furqan-khan07/paypal-doctor (MIT). `npm install && npm run demo` runs without any keys, replaying what Claude answered in a real run against a local PayPal mock. `npm run demo:real` uses the sandbox and live Claude.

---

## AI tools used (required field)

The rules ask for a list of the AI tools used. List every one honestly, including anything you used while building, not just inside the product.

- **Claude API (`claude-opus-5-5`, Anthropic):** inside the product. It runs the review pass that finds integration bugs the static detectors miss, and it writes each patch and its explanation. It's called with structured outputs, prompt caching and server-side fallbacks. Its output is validated before use: rule ids, evidence on the cited line, patches that apply and parse.
- **[You fill in:** the tools you used while building and making the video.**]**

---

## Devpost draft status

Draft: https://devpost.com/submit-to/31302-paypal-ai-hackathon/manage/submissions/1282940-paypal-doctor/project-overview

Filled in and saved: name, elevator pitch, the story (everything above, with the real numbers), Built with tags, the repo link, Individual, N/A for organization, New project, the technology requirement answer, AG Grid as the sponsor tool, the repo URL, the demo URL and testing instructions.

Left for you, because they're your own answers:

- **Project details:** the YouTube link (required; public or unlisted, per the form), and images if you want them.
- **Additional info:**
  - Submitter country of residence, and the Canada province field (or `N/A`).
  - Your PayPal integration rating, why, and whether they can contact you.
  - Your AG Grid experience (optional).
  - **Which AI tools you leveraged while working on this project.** This one asks about your whole process, so the Claude API line below isn't the full answer. List everything you used to build it and make the video.
  - The level of learning, and whether you gained AI value for your career.
  - The three eligibility boxes: age of majority, eligible jurisdiction, not an employee of a promotion entity.
- **Submit step:** the rules checkbox and the Submit button.

Check first that "Submitter type: Individual" is right. If Pierce, Otabek or anyone else is on this with you, it should be Team.

## Video

See `VIDEO_SCRIPT.md`: the timed voiceover, the commands that record the footage and merge your voice in, and what changes after the real run.
