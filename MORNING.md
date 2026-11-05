# Where this stands

Repo: https://github.com/furqan-khan07/paypal-doctor. It's **private**, and GitHub detects the MIT license. Deadline: **Thu Nov 12, 12:00pm PT**.

**The short version**
- The real run is done, with real Claude and the real PayPal sandbox. The first run verified **3 of 11** patches, and that was the doctor's fault. After I fixed the doctor, the second verified **11 of 11**.
- Real cost: **$0.5069** and **$0.5134**, so **$1.02** of your $25 so far.
- The recorded fixtures have replaced my hand-written ones, the footage and `docs/dashboard.png` are retaken, and the Devpost story has the real numbers.
- What's left is yours: the voiceover, YouTube, the Devpost answers, going public and Submit.

---

## What's left for you, in order

**1. Read `docs/real-runs.md` (2 minutes).** It's the honest record of both runs. Every number in the submission comes from there.

**2. Decide on shot 7 of the video.** I added a card saying the first run got 3 of 11, so 11 of 11 doesn't look like a first try. I think it makes the video stronger, but it's your video. `VIDEO_SCRIPT.md` says how to drop it.

**3. Voiceover.** Watch `video/footage.mp4`, then record `voiceover.m4a` in QuickTime from the lines in `VIDEO_SCRIPT.md`. macOS will ask for microphone access once, for QuickTime. The lines run about 2:32 in a 2:55 video.

```bash
npm run video:merge -- voiceover.m4a
```

Watch the result, then upload it to YouTube. The form accepts public or unlisted.

**4. Finish the Devpost draft:** https://devpost.com/submit-to/31302-paypal-ai-hackathon/manage/submissions/1282940-paypal-doctor/project-overview. The story is done, and it has no `[CONFIRM]` markers left. `SUBMISSION.md` lists the fields I left for you. The one that needs some thought: **"Which AI tools have you leveraged while working on this project?"** It asks about your whole process, so the product's Claude API line isn't a full answer. I left it blank because it's your statement to make.

**5. Decide what stays in the public repo.** `MORNING.md`, `SUBMISSION.md` and `VIDEO_SCRIPT.md` are working notes. I'd `git rm` them before going public. They'd still be in the history, which is your call. Nothing sensitive is in them.

**6. Go public and submit.**

```bash
gh repo edit furqan-khan07/paypal-doctor --visibility public --accept-visibility-change-consequences
```

Then tick the rules box and press Submit on Devpost yourself.

---

## The two real runs

| | First run | Second run |
|---|---|---|
| Findings | 11 (9 static, 2 from Claude) | 11 (9 static, 2 from Claude) |
| Patches that applied first time | 11 of 11 | 11 of 11 |
| **Verified** | **3 of 11** | **11 of 11** |
| Patches needing a repair | not possible yet | 0 |
| Regression pass | 0 of 11 | 11 of 11 |
| Static re-scan | clean | clean |
| Claude calls | 12 | 12 |
| **Real cost** | **$0.5069** | **$0.5134** |
| Sandbox calls | 22, plus 6 on the local mock | 162, plus 28 on the local mock |
| Time | about 3m15s | about 4m30s |

Cost is each `response.usage` multiplied by the published prices, and I checked the price table against Anthropic's. `.doctor/llm-usage.jsonl` has every call. A run now stops itself at $6 (`PAYPAL_DOCTOR_MAX_USD`). You asked me to stay under about $10, and the total is $1.02.

**Why the first run failed.** Preflight was green first try, and Claude's patches were mostly fine. The doctor hid things from it. It only sent the file with the bug, so the one-cent cart patch couldn't see `catalog.js` and guessed cart items have an `id`, when they have a `sku`. Every checkout got a 400. That patch stayed in the chain, so the next seven failed too, and their "bug reproduced" lines meant nothing. Claude's own notes said it couldn't see the file.

**What I changed in the doctor.**
- The prompt now includes imports, importers, routes and a sample request.
- Each patch is verified before the next is written.
- A failure goes back to Claude once with the failing checks. If it still fails, the patch is left out.
- The dashboard shows left-out patches.

**I read every patch from the second run.** They're good and small, and Claude's notes are useful, like rotating the committed secret and subscribing to `PAYMENT.CAPTURE.DENIED`. One to know about: the capture patch adds a `pending` order status, and the demo's receipt page just prints it, but a real shop might not cope.

**The first run stays on record.** It's in `docs/real-runs.md`, `SUBMISSION.md` and the Devpost story. The raw reports, logs and both sets of fixtures are in `.doctor/runs/first-real-run/` and `.doctor/runs/second-real-run/`, which are gitignored.

**Confirmed on the real sandbox:**
- Approving an order with a test card, with no browser.
- A forged webhook answered `FAILURE`.
- `ORDER_ALREADY_CAPTURED` before the patch, and the original capture back after it.
- `DECIMAL_PRECISION` on `0.30000000000000004`.
- `CCREJECT-REFUSED` producing a real `DECLINED` capture.

**Two surprises:**
- Claude found a bug I didn't seed: the refund has no `PayPal-Request-Id`. It did in both runs. It also found the `PENDING` webhook bug I'd seeded for it, in both runs.
- The deprecated v1 refund still works on the sandbox, so that patch is about getting off a deprecated API, not fixing something broken today.

## Honest labels I added

- The dashboard says when Claude was replayed. A real run shows no banner, and `npm run demo` shows one.
- Each finding's provenance line now says which backend its proof really used. Before, the webhook `PENDING` and credentials proofs would have said "the PayPal sandbox" when they ran on the mock. Commit messages now say the same.
- The Mock/Sandbox control shows the mode of the report on screen. It was highlighting "Mock" over real sandbox data.
- The PayPal calls tile counts sandbox and mock separately.

## Still unverified

| Thing | State |
|---|---|
| Anything beyond my demo store | Two runs on a shop I seeded, and I fixed the prompt after seeing this shop fail. 11 of 11 says the loop works here, not that patches will pass on your app. |
| Repair and left-out paths | **Didn't run for real,** because nothing failed in the second run. Tested with a fake model and by replaying the first run's patches on the mock (9 verified, 1 left out, 1 no longer applied). |
| `PENDING` webhook and credentials proofs | **Mock only, by design.** So is "a correctly signed event is accepted". Only PayPal can sign an event. |
| `PENDING` capture | **Injected.** The probe rewrites a real sandbox response. The dashboard labels it. |
| `webhook-unverified` on real code | No real-world catch yet. The handlers I read in the 60 repos all verify. |
| Probes on an axios or SDK-based app | The `http` bridge has a test but has never run on a real app of that kind. |
| Claude pass on public repos | The 60-repo validation covers the static scan only. |
| My triage of those repos | One reader, going by the source. I didn't run any of those apps. |

## Decisions I made at roadblocks

1. **Fixed the doctor and ran once more,** since the failure was its fault. The second run is labelled as the second everywhere.
2. **Ran without `--dashboard`,** so the process would exit and I could read the results. I checked the dashboard afterwards on that same report.
3. **Deleted `scripts/demo-fixtures.mjs`,** because it would have overwritten the real fixtures.
4. **Added the first-run shot** and took the time from slots with spare room. Footage went from 2:48 to about 2:55.
5. **On Devpost I only saved the Project details step.** I read the other fields and they're still true. It's still marked DRAFT, with no boxes ticked.

## Left behind

- Your PayPal credentials tab is still open in Chrome, and you can close it.
- Preflight created a webhook on your sandbox app pointing at `https://example.com/paypal-doctor-probe`. The webhook probes need its id, and it's harmless.
- Both runs made real sandbox orders, captures and refunds. It's all test money.
- `npm run demo` overwrites the report on disk, and `npm run video:capture` uses whatever is there. If you re-capture, do a real run first, or you'll get mock footage with a banner on it.
- When I first opened the hackathon page, it offered "Edit project" for a submission #1282928. That link then said "not authorized". I didn't create it and don't know what it was, so check My projects shows only #1282940.

## If something breaks

- `Could not start the app …`: re-run `npm install` at the repo root.
- Probes **skipped** with "would not approve the order with a test card": card payments are off for the sandbox app.
- `PayPal rejected the client id / secret`: use sandbox keys, not live ones, and watch for whitespace in `.env`.
- `npm run video:capture` says "No verified report": run `npm run demo` or a real run first.
- `DEBUG=1 node bin/paypal-doctor.js …` prints stack traces. `--keep` keeps the temp app copies and raw traces.
