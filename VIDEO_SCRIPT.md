# Video script

About 2:55, under the 3:00 limit. It opens on the proof, not on setup. Nothing here needs a screen recording of your machine: `npm run video:capture` records the dashboard with headless Chrome.

`video/footage.mp4` and `docs/dashboard.png` were recorded from the second real run (2026-11-05): real Claude, real PayPal sandbox, 11 of 11 verified. The "Demo data" banner is gone. Only re-record if you run the tool again, because capture uses whatever report is on disk. `npm run demo` overwrites it with a mock run.

## What to do

1. Watch `video/footage.mp4` and check the lines below match what's on screen.
2. Record the voiceover. QuickTime Player → File → New Audio Recording, play `video/footage.mp4` muted beside it, and read the lines below at each timestamp. macOS will ask once for microphone access for QuickTime. Save it as `voiceover.m4a`.
3. Merge:

```bash
npm run video:merge -- voiceover.m4a
```

That writes `video/paypal-doctor.mp4`, normalizes the audio, holds the last frame if you run long, and refuses to go past 2:59.

4. Watch all of it. Then upload it to YouTube as public yourself.

To re-record the footage after another real run:

```bash
npm run video:capture
```

If a patch failed in that run, the capture prints a warning. Keep the true result and change the line.

## Voiceover

Say it your way, these are only the facts in the right order. The lines fit at a relaxed pace (see "Timing" below).

### 1. Forged webhook (0:00-0:26)

> This shop marks an order paid if anyone posts JSON to its webhook URL. Here's the proof. Before the patch, a forged capture event marks the order paid. After the patch, the shop asks PayPal to verify the signature, PayPal says failure, and the shop answers 400. A correctly signed event still goes through. That part runs on my mock, since only PayPal can sign one.

On screen: the webhook finding, then before ✗ / after ✓.

### 2. The one-cent cart (0:26-0:46)

> Same idea here. The total comes from prices the browser sent, so edit one and pay a cent. paypal-doctor followed that price across two files. Before the patch, the shop asked PayPal for one cent. After it, eighteen dollars, from the server's own catalog.

On screen: the data flow in the finding text, then the proof.

### 3. The lost response (0:46-1:16)

> This is the one I find scariest. PayPal takes the money, the response gets lost on the way back, and the buyer retries. With no idempotency key, the retry gets ORDER_ALREADY_CAPTURED, so the shop has the money and thinks the order's unpaid. You can see it in the traffic. In the before run, that's the 422. After the patch, the retry sends the same PayPal-Request-Id and gets the original capture back.

On screen: the proof, then the traffic grid filtered to this finding, with the injected fault visible.

### 4. Pending and declined (1:16-1:34)

> A capture can come back pending or declined while the order still says completed. The sandbox won't give you pending on demand, so the probe rewrites a real response. Declined uses PayPal's own card trigger. Now only a completed capture counts as paid.

On screen: the capture status finding.

### 5. The loop (1:34-1:50)

> So that's the loop. It scans with detectors for nine rules, each tied to a PayPal doc. Claude reviews what they missed and writes a patch per bug. Then each patch gets run: the bug has to show up before it, and be gone after it.

On screen: the log of the real run, sped up.

### 6. Regression pass (1:50-2:00)

> Then every probe runs again with all the patches in, and the scan runs again. All green, nothing left.

On screen: the regression tab, 11 of 11.

### 7. The first real run (2:00-2:18)

> My first real run only verified 3 of 11. Claude couldn't see enough of the code, and one bad patch broke the rest. That was my tool's fault. Now each patch has to pass before the next is written, and the second run got 11 of 11.

On screen: a card with both numbers and the cost. They come from `docs/real-runs.md` and are typed into `scripts/video/capture.mjs`. I added this shot so 11 of 11 doesn't look like a first try. It's your call: to drop it, delete `7-first-run` from `SHOTS`, re-record, and you get 18 seconds back.

### 8. On real code (2:18-2:37)

> I also ran it on sixty public PayPal repos and checked the findings by hand. The first run was bad: 189 of 237 were wrong. So I fixed the detectors and tried repos they'd never seen. 23 of 27 correct.

On screen: the numbers card. These come from `docs/validation.md`. Update both the card (in `scripts/video/capture.mjs`) and this line if you re-run the validation. They cover the static scan only, not Claude's patches.

### 9. Commits (2:37-2:47)

> When you're happy, it writes one git commit per verified patch, with the proof in the message, so a reviewer can see what each one fixes.

### 10. Close (2:47-2:55)

> It's open source, and it runs without keys against a local mock. That's paypal-doctor.

## Timing

I checked the script against macOS `say` at 150 words a minute, a relaxed reading pace:

| Shot | Slot | Spoken at 150 wpm |
|---|---|---|
| 1. Forged webhook | 26s | 26s |
| 2. The one-cent cart | 20s | 17s |
| 3. The lost response | 30s | 27s |
| 4. Pending and declined | 18s | 16s |
| 5. The loop | 16s | 14s |
| 6. Regression pass | 10s | 6s |
| 7. The first real run | 18s | 15s |
| 8. On real code | 19s | 16s |
| 9. Commits | 10s | 8s |
| 10. Close | 8s | 6s |
| Total | 175s | 152s |

## Optional extra shot

If you want a human moment, record the storefront yourself: `npm run store`, add a mug, set its price to 0.01 in devtools (`localStorage`), and check out with a sandbox buyer account, so PayPal shows $0.01. Then `npm run forge-webhook -- <order id>` shows the forged event flipping the order to paid. It needs your sandbox client id, your own sandbox login, and a screen recording, which macOS will ask permission for. The script works without it.
