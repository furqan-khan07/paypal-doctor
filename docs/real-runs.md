# Real runs

Two runs on the demo store on 2026-11-05, with real Claude (`claude-opus-5-5`) and the real PayPal sandbox. Both used:

```bash
node bin/paypal-doctor.js run demo-store --mode sandbox --llm record
```

Costs are the token counts in each `response.usage`, multiplied by the published prices ($4 input, $20 output, $0.20 cache read and $5 cache write per million tokens).

| | First run | Second run |
|---|---|---|
| Commit | `e659116` | `d76c505` |
| Findings | 11 (9 static, 2 from Claude) | 11 (9 static, 2 from Claude) |
| Claude findings rejected by validation | 0 | 0 |
| Patches that applied first time | 11 of 11 | 11 of 11 |
| **Verified: bug shown before, gone after** | **3 of 11** | **11 of 11** |
| Patches needing a repair | not possible yet | 0 |
| Regression pass | 0 of 11 | 11 of 11 |
| Static re-scan of the patched code | clean | clean |
| Claude calls | 12 | 12 |
| Cost | $0.5069 | $0.5134 |
| Time | about 3m15s | about 4m30s |

In the second run, one call cost between $0.0237 and $0.0845. The review pass cost $0.043. The probes made 162 calls to the sandbox and 28 to the local mock.

## Why the first run got 3 of 11

Claude's patches weren't the main problem. The doctor was.

1. **The prompt hid what the patch needed.** It only sent the file with the bug. Patch 4, the one-cent cart fix, had to look prices up in `catalog.js`, which it couldn't see, and it guessed that cart items have an `id`. They have a `sku`, so every checkout got a 400. Claude's own notes said it couldn't see that file.
2. **A failed patch stayed in the chain.** Patches 5 to 11 were built on top of the broken checkout, so they all failed too. Their "bug reproduced" lines meant nothing, because the checkout failed for a different reason.
3. **The list of other issues was stale.** It included findings already fixed, with old line numbers. Claude noticed and said so in its notes.

## What changed

- The prompt now includes the file's imports and importers, the app's routes and a sample request, and only lists issues still open.
- Each patch is verified as soon as it's written. A failure goes back to Claude once with the failing checks, and if it still fails the patch is left out of the chain.

The same first-run patches, replayed through the new chain on the mock, gave 9 verified. The one-cent patch was left out, and the amount-formatting patch no longer applied, because it had been written on top of the one-cent patch. So the other patches had been fine, and the chain was what hid that.

## What the second run confirmed on the real sandbox

- Approving an order with a test card through `confirm-payment-source`, with no browser.
- A forged webhook: the sandbox's verify-webhook-signature answered `FAILURE`.
- The lost capture response: `ORDER_ALREADY_CAPTURED` (HTTP 422) before the patch. After it, the retry with the same `PayPal-Request-Id` got HTTP 200 and the original capture back.
- `"0.30000000000000004"` rejected with `DECIMAL_PRECISION`, and `"0.30"` accepted.
- `CCREJECT-REFUSED` producing a real `DECLINED` capture.
- A retried refund getting HTTP 422 with no request id, and HTTP 200 with one.
- Replaying a create order with the same id returning the same order.

Two things I hadn't planned on:

- Claude found a bug I didn't seed, in both runs. The refund call had no `PayPal-Request-Id`, and the static rule doesn't look at that call while it's still on the v1 path. It also found the one I did seed for it, a webhook handler treating `PAYMENT.CAPTURE.PENDING` as paid.
- The deprecated v1 refund still works on the sandbox (HTTP 201). So that patch is about getting off a deprecated API, not fixing something broken today.

## What these runs don't show

- **It's two runs on a shop I seeded myself,** and the prompt was fixed after looking at this shop's failure. 11 of 11 says the loop works here, not that Claude's patches will pass on your app. Model output also varies between runs.
- **The repair and left-out paths didn't run for real.** Nothing failed in the second run. They're tested with a fake model and by replaying the first run's patches on the mock.
- **Two proofs run only on the mock:** the `PENDING` webhook and the credentials probe. The "a correctly signed event is accepted" half of the forged webhook probe also uses the mock. Only PayPal can sign an event, and it only signs ones it delivers to a public URL. The dashboard says which proof used what.
- **The `PENDING` capture is injected.** The sandbox won't produce one on demand, so the probe rewrites a real capture response. `DECLINED` is real.
- **The patches need a person to read them.** For example, the capture patch adds a `pending` order status, and Claude's notes say to check the receipt page handles it. The demo's page just prints the status, but a real shop might not.
