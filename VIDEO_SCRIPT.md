# Video script

About 2:48, under the 3:00 limit. It opens on the proof, not on setup. Nothing here needs a screen recording of your machine: `npm run video:capture` records the dashboard with headless Chrome.

## What to do

```bash
npm run video:setup      # once
```

1. Do the real run first (see `MORNING.md`). The current footage has a "Demo data" banner on it, on purpose.
2. Record the footage from the real report:

```bash
npm run video:capture
```

That writes `video/footage.mp4` and retakes `docs/dashboard.png`.

3. Watch the footage and check the lines below still match what's on screen. If a patch failed in the real run, the capture prints a warning. Keep the true result and change the line.
4. Record the voiceover. QuickTime Player → File → New Audio Recording, play `video/footage.mp4` muted beside it, and read the lines below at each timestamp. macOS will ask once for microphone access for QuickTime. Save it as `voiceover.m4a`.
5. Merge:

```bash
npm run video:merge -- voiceover.m4a
```

That writes `video/paypal-doctor.mp4`, normalizes the audio, holds the last frame if you run long, and refuses to go past 2:59.

6. Watch all of it. Then upload it to YouTube as public yourself.

## Voiceover

Say it your way, these are only the facts in the right order. The lines fit at a relaxed pace (see "Timing" below).

### 1. Forged webhook (0:00-0:26)

> This shop marks an order paid if anyone posts JSON to its webhook URL. Here's the proof. Before the patch, a forged capture event marks the order paid. After the patch, the shop asks PayPal to verify the signature, PayPal says failure, and the shop answers 400. A correctly signed event still goes through. That part runs on my mock, since only PayPal can sign one.

On screen: the webhook finding, then before ✗ / after ✓.

### 2. The one-cent cart (0:26-0:48)

> Same idea here. The total comes from prices the browser sent, so edit one and pay a cent. paypal-doctor followed that price across two files. Before the patch, the shop asked PayPal for one cent. After it, eighteen dollars, from the server's own catalog.

On screen: the data flow in the finding text, then the proof.

### 3. The lost response (0:48-1:20)

> This is the one I find scariest. PayPal takes the money, the response gets lost on the way back, and the buyer retries. With no idempotency key, the retry gets ORDER_ALREADY_CAPTURED, so the shop has the money and thinks the order's unpaid. You can see it in the traffic. In the before run, that's the 422. After the patch, the retry sends the same PayPal-Request-Id and gets the original capture back.

On screen: the proof, then the traffic grid filtered to this finding, with the injected fault visible.

### 4. Pending and declined (1:20-1:38)

> A capture can come back pending or declined while the order still says completed. The sandbox won't give you pending on demand, so the probe rewrites a real response. Declined uses PayPal's own card trigger. Now only a completed capture counts as paid.

On screen: the capture status finding.

### 5. The loop (1:38-1:58)

> So that's the loop. It scans with detectors for nine rules, each tied to a PayPal doc. Claude reviews what they missed and writes a patch per bug. Then each patch gets run: the bug has to show up before it, and be gone after it.

On screen: the log of the last run, sped up.

### 6. Regression pass (1:58-2:08)

> Then every probe runs again with all the patches in, and the scan runs again. All green, nothing left.

On screen: the regression tab. Only say "all green" if it is.

### 7. On real code (2:08-2:27)

> I also ran it on sixty public PayPal repos and checked the findings by hand. The first run was bad: 189 of 237 were wrong. So I fixed the detectors and tried repos they'd never seen. 23 of 27 correct.

On screen: the numbers card. These come from `docs/validation.md`. Update both the card (in `scripts/video/capture.mjs`) and this line if you re-run the validation.

### 8. Commits (2:27-2:40)

> When you're happy, it writes one git commit per verified patch, with the proof in the message, so a reviewer can see what each one fixes.

### 9. Close (2:40-2:48)

> It's open source, and it runs without keys against a local mock. That's paypal-doctor.

## What has to be redone after the real run

Everything comes from the report, so one `npm run video:capture` redoes all of it. Here's what changes on screen:

| Shot | Now (mock + hand-written fixtures) | After the real run |
|---|---|---|
| All dashboard shots (1-6) | "Demo data" banner on top, tiles say "hand-written fixtures" and "against the local mock" | Banner gone, real model and sandbox numbers |
| 1 | "mock answered FAILURE" | Should say "sandbox answered FAILURE". The signed-event check stays on the mock. |
| 3, 4 | Mock order ids, no real debug ids | Real sandbox ids and debug ids in the traffic grid |
| 5 | Log of a mock run | Log of the real run, sped up more because it takes minutes |
| 8 | Proof line says "a local PayPal mock" | Says "the PayPal sandbox" |
| 9 | "proves it" | "proves it in the sandbox" |

Don't upload the current footage. The voiceover says PayPal and Claude did things that, in this footage, the mock and my fixtures did.

## Timing

I checked the script against macOS `say` at 150 words a minute, a relaxed reading pace:

| Shot | Slot | Spoken at 150 wpm |
|---|---|---|
| 1. Forged webhook | 26s | 26s |
| 2. The one-cent cart | 22s | 17s |
| 3. The lost response | 32s | 27s |
| 4. Pending and declined | 18s | 16s |
| 5. The loop | 20s | 14s |
| 6. Regression pass | 10s | 6s |
| 7. On real code | 19s | 16s |
| 8. Commits | 13s | 8s |
| 9. Close | 8s | 6s |
| Total | 168s | 137s |

## Optional extra shot

If you want a human moment, record the storefront yourself: `npm run store`, add a mug, set its price to 0.01 in devtools (`localStorage`), and check out with a sandbox buyer account, so PayPal shows $0.01. Then `npm run forge-webhook -- <order id>` shows the forged event flipping the order to paid. It needs your sandbox client id, your own sandbox login, and a screen recording, which macOS will ask permission for. The script works without it.
