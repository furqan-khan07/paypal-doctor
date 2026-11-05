# Does it work on real code?

The demo store is my own seeded bugs, so passing it proves very little. To find out how the static scan behaves on code I didn't write, I ran it over public PayPal integrations and checked the findings by hand against the source.

The short version: the first run was bad, and that was the useful part.

## How I picked the repos

GitHub code search for `/v2/checkout/orders`, `verify-webhook-signature`, `purchase_units`, `paypal-server-sdk`, `paypal-rest-sdk` and `checkout-server-sdk` in JavaScript and TypeScript gave 681 repos. I dropped forks and archived repos and ranked the rest by stars. I fixed the split before looking at any results:

- **Tuning set:** PayPal's own samples plus every other repo from the top 40. Findings here were allowed to change the detectors.
- **Held-out set 1:** the rest of the top 40. Scanned once with the detectors frozen, then triaged.
- **Held-out set 2:** the next 20 by stars. I needed this because fixing what set 1 exposed meant set 1 could no longer give an independent number. Scanned once, frozen, triaged.

The clones are sparse (source files only) and nothing in them is run. The scan only parses. To reproduce the selection and the scan: `node scripts/validate-public.mjs <scratch-folder>`. Search results and repos change over time, so a re-run won't match exactly (a later search found 680 repos, and the same top three).

A finding counts as **correct** if the code really does what the rule says. **Low value** means it's true but doesn't matter in that spot, such as a one-off admin script. **Wrong** means the rule doesn't apply.

## Results

| Run | Repos | Files | Findings | Correct | Low value | Wrong |
|---|---|---|---|---|---|---|
| First run, before any fixes (tuning set) | 22 | 56,795 | 237 | 48 | - | **189 (80%)** |
| Held-out 1 (after tuning) | 18 | 18,138 | 23 | 16 | 6 | 1 |
| Held-out 2 (after more fixes) | 20 | 23,821 | 27 | 23 | 0 | 4 (3 are one file copied three times) |

Held-out 2 is the number to quote for precision: **23 of 27 correct, on 20 repos the detectors had never seen.** The fixes made after that run aren't reflected in it.

### What it misses

Precision is the easy half, so I also read the server-side PayPal code in those repos by hand and counted what the scan should have reported and didn't.

| Run | Repos read | Misses found |
|---|---|---|
| Held-out 1 | 13 | 10 |
| Held-out 2 | 6 | 3 |

This is a spot check, not a measured recall number, because nobody has a ground-truth list of PayPal bugs in these repos. There are certainly more misses than I found. Most of them are fixed now and covered by tests. One class isn't: a rule can't catch what it doesn't describe, such as webhook verification that's skipped when the webhook id isn't configured. That's the kind of thing the Claude review pass is there for.

## What the first run taught me

Every one of these became a detector fix and a regression test in `test/fixtures/real-world/`.

- **Secrets and webhooks weren't scoped to PayPal.** `hardcoded-credentials` flagged UI labels like `Password: 'Password'` and other providers' keys (136 findings, 2 correct). `webhook-unverified` flagged Stripe's webhooks.
- **One rule was simply wrong.** `/v1/payments/payouts` is PayPal's current Payouts API, not the deprecated Payments API, and other gateways have their own `/v1/payments` paths. The rule now matches only the resources PayPal's reference marks deprecated (35 findings, 0 correct).
- **Wrappers and relays aren't bugs.** A function that returns the capture to its caller, or a server that passes it to the browser, hasn't decided anything. The capture rule now needs evidence that the code treats the payment as done.
- **The scan was blind in places.** About 1,900 files across the first two runs failed to parse because the parser needed the decorators plugin, which took out whole NestJS apps. Arrow functions weren't followed across files. Handlers wired as `controller.method`, calls through an app's own request helper, and URLs held in a variable were all invisible.
- **A new variant turned up.** A capture that generates a fresh `PayPal-Request-Id` on every call looks fine but doesn't survive a retry, so that's now flagged too.

PayPal's own samples were in the tuning set, and they mostly leave out `PayPal-Request-Id`. That's a reasonable shortcut in a sample, and also exactly what gets copied.

## What this doesn't show

- `webhook-unverified` has no correct findings on real code yet. It has no findings left on these 60 repos, and the PayPal webhook handlers I read all do verify, so it has only proved itself on my fixtures and the demo store. These are starred projects, so a real miss would more likely show up further down the list.
- It covers the static scan only. The Claude review pass and the patches haven't been run on these repos, and the sandbox probes need an app set up to run, so they've only run on the demo store.
- One person (me) did the triage. "Correct" means the code matches the rule as I read it, and I didn't run any of these apps.
- Stars are a rough proxy for "real", and these 60 repos include tutorials, SDKs and a few that only mention PayPal in passing.
