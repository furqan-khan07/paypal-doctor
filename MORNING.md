# Where this stands

Repo: https://github.com/furqan-khan07/paypal-doctor. It's **private**, and GitHub detects the MIT license. Deadline: **Thu Nov 12, 12:00pm PT**.

**The short version**
- The tool works end to end on the mock with hand-written Claude answers.
- It has now been checked against 60 public repos, which made the static scan far better.
- The video kit and the Devpost draft are ready.
- **It has still never touched the real PayPal sandbox or the real Claude API**, because `.env` is empty. The sandbox app itself is ready. Most of what's left starts with you pasting the keys.

---

## What's left for you, in order

**1. PayPal keys (1 minute).** The sandbox app is ready: **Default Application** already has Expanded checkout and Advanced Credit and Debit Card Payments on, so there's nothing to change. Open https://developer.paypal.com/dashboard/applications/sandbox and click **Default Application** (I left that page open in Chrome). Copy **Client ID** and **Secret key 1** (the copy icon beside each) into `.env` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.

**2. Anthropic key.** https://console.anthropic.com → API keys → paste as `ANTHROPIC_API_KEY` in `.env`.

**3. Check, then do the real run (roughly $1-3 in Claude, an estimate).**

```bash
npm run preflight
```

```bash
node bin/paypal-doctor.js run demo-store --mode sandbox --llm record --dashboard
```

If a patch fails verification, keep the true result. It's better material than a clean sweep. Then commit what it recorded, which replaces my hand-written fixtures:

```bash
git add src/llm/fixtures && git commit -m "Record Claude fixtures from a live run" && git push
```

I was asked to do this step too, but it needs the keys. Once they're in `.env` I can run it and fix whatever breaks, if you'd rather hand it back.

**4. Update the claims.** In `SUBMISSION.md`, resolve each `[CONFIRM ...]` and fill in the real numbers. Do the same in the Devpost story, since it has the same markers.

**5. Video.** Follow `VIDEO_SCRIPT.md`:

```bash
npm run video:capture
```

Then record `voiceover.m4a` in QuickTime and merge it. macOS will ask for microphone access once, for QuickTime.

```bash
npm run video:merge -- voiceover.m4a
```

Watch it, then upload to YouTube. The form accepts public or unlisted.

**6. Finish the Devpost draft:** https://devpost.com/submit-to/31302-paypal-ai-hackathon/manage/submissions/1282940-paypal-doctor/project-overview. `SUBMISSION.md` lists exactly which fields I left for you, and why. The one that needs some thought: **"Which AI tools have you leveraged while working on this project?"** It asks about your whole process, so the product's Claude API line isn't a full answer. I left it blank because it's your statement to make.

**7. Decide what stays in the public repo.** `MORNING.md`, `SUBMISSION.md` and `VIDEO_SCRIPT.md` are working notes, and this file reads like what it is: a hand-over to you. I'd `git rm` them before going public. They'd still be in the history, which is your call. Nothing sensitive is in them.

**8. Go public and submit.**

```bash
gh repo edit furqan-khan07/paypal-doctor --visibility public --accept-visibility-change-consequences
```

Then tick the rules box and press Submit on Devpost yourself.

---

## What changed in this round

**Real-world validation** (`docs/validation.md`). This was the big one.

| Run | Repos | Findings | Correct | Low value | Wrong |
|---|---|---|---|---|---|
| First run, before any fixes | 22 | 237 | 48 | - | 189 (80%) |
| Held-out set 1, after tuning | 18 | 23 | 16 | 6 | 1 |
| Held-out set 2, after more fixes | 20 | 27 | 23 | 0 | 4 (3 are one file copied three times) |

Reading the PayPal code by hand in the held-out repos also found misses: 10 in set 1 (13 repos read), 3 in set 2 (6 repos read). Most are fixed now. That's a spot check, not a recall number.

What it exposed in my own work:
- Secrets and webhooks weren't scoped to PayPal.
- `/v1/payments/payouts` is PayPal's current API, so that rule was wrong.
- About 1,900 files silently failed to parse because of decorators, which took out whole NestJS apps.
- Arrow functions weren't being followed across files.
- The dashboard badged my hand-written fixture as "found by Claude". It now says "fixture", with a banner.

**Audit for going public**
- No secrets in git history: a regex scan for ten key shapes found nothing, and `detect-secrets` over all 174 unique blobs found only env var names and obvious fakes. `gitleaks` isn't on conda-forge, so I used that instead.
- `.env` was never tracked.
- All 11 fixtures are labelled `handWritten: true`.
- GitHub detects MIT.
- A fresh clone works from the README alone: `npm install`, `npm test`, `npm run demo`.
- All commits are under your identity.

**Video kit**
- ffmpeg 9.0.2 is in a new conda env, `paypal-doctor-video`.
- `npm run video:capture` records real 1080p footage with headless Chrome, with **no macOS permission needed**, and retakes `docs/dashboard.png` at 3200x2080.
- `npm run video:merge` was tested with a stand-in voice, including the over-2:59 refusal.
- `VIDEO_SCRIPT.md` is timed. I measured the lines with macOS `say`: 2:17 of speech in a 2:48 video.

**The current footage is a preview. Don't upload it.** It shows a "Demo data" banner, and the script says PayPal and Claude did things that, in this footage, the mock and my fixtures did. One `npm run video:capture` after the real run fixes all of it. `VIDEO_SCRIPT.md` has the shot-by-shot table.

**Devpost.** The draft is created under your account and saved. It's still marked DRAFT, I didn't submit it, and I didn't tick any eligibility or rules box.

---

## Still unverified

| Thing | State |
|---|---|
| Real PayPal sandbox | **Never run.** The code path is tested with the mock standing in. |
| Approving orders with a test card | Built from PayPal's docs, untested for real. Card payments are on for the app, but `npm run preflight` is what actually proves it. |
| The `CCREJECT-REFUSED` decline | Built from PayPal's card-testing page, untested. If it's refused at approval, the probe notes that and relies on its other scenarios. |
| Live Claude calls | **Never run.** Request shape tested against a fake API. Whether the model's patches pass the probes is the biggest open question. |
| "Claude finds the `PENDING` webhook bug" | So far that's my hand-written fixture. Claude may or may not find it. |
| `webhook-unverified` on real code | No real-world catch yet. The handlers I read in these 60 repos all verify, so it has only proved itself on my fixtures and the demo. |
| Probes on an axios or SDK-based app | The `http` bridge has a test but has never run on a real app of that kind. |
| Claude pass on public repos | The validation covers the static scan only. |
| My triage | One reader (me), going by the source. I didn't run any of those apps. |

Also: when I first opened the hackathon page, it offered "Edit project" for a submission #1282928. That link then said "not authorized" and the page went back to "Start project". I didn't create it and don't know what it was, so check My projects shows only #1282940.

## Decisions I made at roadblocks

Earlier ones are in the git history of this file. From this round:

1. **PayPal's developer site wasn't signed in at first, so I moved on until you signed in.** Then I used the existing Default Application rather than creating another, and changed nothing on it: card payments were already on. I never revealed or copied the secret. Devpost was signed in as `furqan-khan07` (I checked).
2. **Two held-out sets, not one.** Fixing what the first exposed meant it could no longer give an independent number.
4. **Selection was by stars from GitHub code search,** fixed before seeing results, so I couldn't pick repos that flattered the tool.
5. **`Individual` for submitter type** on the Devpost draft, since the brief describes you entering alone. Change it if that's wrong.
6. **Left blank on Devpost:** your country, ratings, opinions and the AI tools question. They're your answers, not facts I can look up.
7. **Saved the Devpost story with its `[CONFIRM ...]` markers in,** so an unverified claim can't pass as fact.
8. **Video kit kept out of the main dependencies** (`scripts/video/` has its own package), so the tool stays at four.

## If something breaks

- `Could not start the app …`: re-run `npm install` at the repo root.
- Probes **skipped** with "would not approve the order with a test card": card payments are off for the sandbox app (step 1).
- `PayPal rejected the client id / secret`: use sandbox keys, not live ones, and watch for whitespace in `.env`.
- `npm run video:capture` says "No verified report": run `npm run demo` or the real run first.
- `DEBUG=1 node bin/paypal-doctor.js …` prints stack traces. `--keep` keeps the temp app copies and raw traces.
