# Good morning

The **Repo** is https://github.com/furqan-khan07/paypal-doctor. It's **private**, has an MIT LICENSE, and about 18 commits, all pushed.

**TL;DR**
- Find → fix → verify works end to end on the demo store, with a local PayPal mock and recorded Claude answers.
- All ten findings come out *verified*: each bug is reproduced before its patch and gone after it.
- The regression pass is 10/10 and the static re-scan is clean. The AG Grid dashboard is done.
- What's left is real-world: your keys, one real sandbox + Claude run, the video, flipping the repo public, submitting.

Your `.env` keys were still empty when I finished, so **nothing here has touched the real PayPal sandbox or the real Claude API yet**. See "What's mocked or untested" below.

---

## What works (try these)

```bash
cd ~/Documents/PROJECTS/paypal-doctor
npm install            # already done on this machine
npm test               # 13 tests, ~9s: detectors (REST + server SDK), mock, interceptor, end-to-end, sandbox code path, apply --commits, Claude client
npm run demo           # scan -> fix -> verify on the mock, then the dashboard at http://localhost:4417
```

Other things worth poking at:

```bash
node bin/paypal-doctor.js status           # which keys are set (prints set/empty only)
node bin/paypal-doctor.js scan demo-store   # just the findings
node bin/paypal-doctor.js dashboard         # dashboard for the latest report
npm run store                               # the demo shop on :8888 with your .env (PayPal buttons need PAYPAL_CLIENT_ID)
npm run forge-webhook -- <orderId>          # post a fake PAYMENT.CAPTURE.COMPLETED to the running shop
node bin/paypal-doctor.js apply <dir> --yes --commits   # one git commit per verified patch + PULL_REQUEST.md
```

Careful with that last one on `demo-store` itself: it would commit the fixes into this repo and the demo would have no bugs left. Try it on a copy (see `test/apply.test.js` for how).

On the dashboard:
- Click a finding to see the flagged code, Claude's explanation, the before ✗ / after ✓ probe checks, and the diff.
- The bottom grid shows every PayPal request the probes made. Tick "only the selected finding" to filter it.
- Scan / Fix / Verify / Run all work from the page, and the log streams live.
- Both grids export to CSV.

**The demo, in numbers:**
- 9 seeded bugs found by the static pass, plus 1 that only the (recorded) Claude review finds: the webhook treating `PAYMENT.CAPTURE.PENDING` as paid.
- 10 patches, each verified before/after.
- A mock run takes about 8 seconds and makes about 140 PayPal calls.

## What's mocked or untested

| Thing | State |
|---|---|
| Real PayPal sandbox | **Never run.** The sandbox code path is tested with the mock standing in for `api-m.sandbox.paypal.com`, so routing, the webhook lookup, mixed sandbox/mock probes and secret redaction are covered. Real sandbox behaviour isn't. |
| Approving orders with a test card (`confirm-payment-source`) | Built from PayPal's docs, untested for real. Needs card payments enabled on your sandbox app. If it fails, every capture-related probe gets **skipped**, with the reason in the dashboard. |
| Declined capture via the `CCREJECT-REFUSED` card name | Built from PayPal's card-testing page, untested. If the sandbox rejects at approval instead of at capture, the probe notes it and relies on the other two scenarios. |
| Claude live calls | **Never run.** The request shape is tested against a fake Anthropic server (model, JSON-schema output, cached system prompt, fallback beta), and so is parsing and fixture record/replay. |
| The Claude answers the demo uses | **Hand-written by me**, in `src/llm/fixtures/kiln-and-co/`, so `npm run demo` works without a key. They're marked `handWritten: true`, the CLI says "(hand-written fixture)", and the dashboard says so in each finding's provenance line. Replace them with real ones (step 4 below) before the video. |
| `PENDING` capture | Can't be triggered on demand in the sandbox, so it's a fault the interceptor injects on the real response. Labelled as injected in the UI. |
| Signed webhook accepted | Only PayPal can sign a webhook, and only when delivering to a public URL. So the "real event is still accepted" half of the webhook probes always runs on the mock. The forged-event half runs against the real verify endpoint. |
| Apps using axios / `@paypal/paypal-server-sdk` | The interceptor now also bridges `node:http`/`https`, with a test using a raw `https.request` app. It has never been run against a real axios or SDK-based app. |

## Decisions I made at roadblocks

1. **Plain JavaScript (ESM), no TypeScript build.** Zero build steps for judges cloning it. Node 20.17 can't strip types natively.
2. **Pinned dependency versions at least ~2 weeks old.**
   - `@babel/parser` 7.29.9: v8 needs Node 22.
   - `@anthropic-ai/sdk` 0.135.0: the 1.x line was under 10 days old.
   - `ag-grid-community` 36.2.0, `diff` 9.0.0, `express` 5.3.0.
3. **No-browser buyer approval** via `confirm-payment-source` with PayPal's published sandbox Visa (`4012888888881881`, override with `PAYPAL_DOCTOR_TEST_CARD`). It was the only way I found to get an order to `APPROVED` from a script.
4. **The fix chain is sequential.** Patch N is written on top of patches 1..N-1, in a fixed order (config → money math → API calls → webhook), so every patch can be proven on its own.
5. **Patches are find/replace edits, not unified diffs.** LLM-written diffs often don't apply. Edits must match exactly once and the file must still parse; in live mode a failed patch gets one retry with the error.
6. **The `client-supplied-amount` rule stays.** PayPal's docs *imply* it rather than state it: the server computes purchase units from the cart, and the official sample does the same. Noted in `docs/rules.md`. Rules I couldn't back with a doc are listed there as "considered, not shipped".
7. **The webhook id for probes.** If `PAYPAL_WEBHOOK_ID` is empty, sandbox mode **creates a webhook on your sandbox app**, pointing at `https://example.com/paypal-doctor-probe`, or reuses one with that URL. It's needed for verify-webhook-signature. It's harmless, but you'll see it in the dashboard; delete it whenever.
8. **Credential probes always run on the mock**, so fake/baked-in credentials never get sent to PayPal.
9. **The live API is hard-blocked** in the interceptor, regardless of config.
10. **Model `claude-opus-5-5`.** Structured outputs, effort `high`, prompt caching on the system prompt, and server-side fallbacks (`fallbacks: "default"`). If your account rejects the fallback beta, it retries without it. Override with `PAYPAL_DOCTOR_MODEL`.
11. **The dashboard is localhost-only and rejects cross-origin POSTs**, since it can start processes.
12. **AG Grid Community only.** It's MIT-licensed (checked the LICENSE in the package), with no enterprise features, loaded from `node_modules` rather than a CDN.
13. **The verifier checks the app can start before probing.** Otherwise a missing `npm install` showed up as "10 patches failed".
14. **The demo store** is an npm workspace, so `npm install` at the root installs its Express too.
15. **README tone.** Personal but without invented anecdotes. It mentions pandas-doctor as the predecessor, since that's in your brief. Edit to taste.
16. **Added after the core worked:**
    - `apply --commits`: one commit per verified patch, with the proof in the message, plus PULL_REQUEST.md.
    - `node:http`/`https` interception, for axios and the SDK.
    - Detector support for `@paypal/paypal-server-sdk`, with a TypeScript fixture.
    - CSV export on the dashboard.
    - A Host-header check on the dashboard against DNS rebinding.
17. **No CI workflow.** I didn't add a GitHub Actions workflow, since it would spend Actions minutes on your account while the repo is private. If you want a badge, add `.github/workflows/test.yml` running `npm ci && npm test` on Node 20 after flipping it public.

## What you need to do next

1. **Keys.** Paste into `.env`:
   - `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`: developer.paypal.com → Apps & Credentials → **Sandbox** → your app.
   - `ANTHROPIC_API_KEY`.
   - `PAYPAL_WEBHOOK_ID` is optional (see decision 7).
2. **Card payments on the sandbox app.** In the app's settings, make sure card payments (Advanced Credit and Debit Card Payments) are enabled. New US sandbox apps usually have it on.
3. **Preflight:**
   ```bash
   npm run preflight
   ```
   This walks token → create → approve with the test card → capture → idempotent replay → v2 refund → webhook → forged signature. Everything should be ✓. If "Approve with a sandbox test card" fails, it's step 2.
4. **The real run, recording Claude's answers over my hand-written ones:**
   ```bash
   node bin/paypal-doctor.js run demo-store --mode sandbox --llm record --dashboard
   ```
   (`npm run demo:real` is the same thing but with `--llm live`, so nothing is saved.)
   - Look at each patch Claude wrote. If one fails verification, that's real data and honestly a better demo than everything passing. But if a patch is plainly bad, re-run that one.
   - Cost estimate: 11 Opus 5.5 calls with high effort, roughly $1-3 per full run.
   - After it records, commit the new fixtures (`git add src/llm/fixtures && git commit -m "Record Claude fixtures from a live run"`), so `npm run demo` replays the real thing.
5. **Check the dashboard after the sandbox run.**
   - The "PayPal calls" tile should say "against the sandbox".
   - The traffic grid should show real `paypal-debug-id`s.
   - Note the numbers for SUBMISSION.md's "Accomplishments" placeholder.
6. **Retake `docs/dashboard.png`.** Mine is an 800px-wide capture from a preview pane; a real full-width screenshot will look much better.
7. **Video.** Follow the shot list in `SUBMISSION.md`.
   - For the storefront shots you need `npm run store` with your sandbox client id, plus a sandbox *personal* account to log into the PayPal popup. I didn't sign into anything.
   - Upload it to YouTube yourself, public, under 3 minutes.
8. **Fill in `SUBMISSION.md`:** the "AI tools used" list must include everything you used, and fill in the accomplishments numbers.
9. **Flip the repo public right before submitting:**
   ```bash
   gh repo edit furqan-khan07/paypal-doctor --visibility public --accept-visibility-change-consequences
   ```
   Then check GitHub shows "MIT license" in the sidebar.
10. **Submit on Devpost before Thu Nov 12, 12:00pm PT.** Pick a Grand/Honorable track, and **AG Grid** as the sponsor prize.

## Where things are

- `README.md` covers setup, how it works, the CLI, config for your own app, safety and limitations.
- `docs/rules.md` has each rule's detection logic, how its probe proves it, and the doc link; plus the rules I dropped.
- `SUBMISSION.md` is the Devpost description draft, the AI tools section and the video shot list.
- `scripts/demo-fixtures.mjs` regenerates the hand-written fixtures if you change the demo store.
- Commits are all under your git identity, with no co-author trailers.

## If something breaks

- `paypal-doctor: Could not start the app …`: the verifier couldn't boot the target. For the demo store, re-run `npm install` at the repo root.
- Probes **skipped** with "would not approve the order with a test card": card payments are off for the sandbox app (step 2).
- `PayPal rejected the client id / secret`: these are sandbox keys, not live. Watch for whitespace in `.env`.
- `DEBUG=1 node bin/paypal-doctor.js …` prints stack traces.
- `--keep` on `run`/`verify` keeps the temp copies of the app and the raw JSONL traces. The path is printed in the report under `verify.workRoot`.
