// Builds the hosted demo's story section from a real report and the two docs that back
// its numbers. Every number and before/after value is read from them. If one can't be
// read, or the report and the docs disagree, the build stops rather than publish a guess.
import { RULES } from '../../src/rules.js';

const REPO_URL = 'https://github.com/furqan-khan07/paypal-doctor';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function must(ok, what) {
  if (!ok) throw new Error(`Demo landing page: ${what}`);
  return ok;
}

function detail(result, nameHas) {
  const check = (result?.checks || []).find((c) => c.name.includes(nameHas));
  must(check, `no check containing "${nameHas}"`);
  return check.detail || '';
}

function read(text, re, what) {
  const m = re.exec(text);
  must(m, `can't read ${what} from "${text}"`);
  return m;
}

const money = (v) => `$${Number(v).toFixed(2)}`;

export function landingData(report, { realRuns, validation }) {
  const findings = [...report.findings].sort((a, b) => a.fix.chainIndex - b.fix.chainIndex);
  const total = findings.length;
  const by = (test, what) => must(findings.find(test), `no ${what} finding`);

  const reproduced = findings.filter((f) => f.verification.before && !f.verification.before.passed).length;
  const gone = findings.filter((f) => f.verification.after?.passed).length;

  // What each pad on the strip says when you point at it.
  const pads = findings.map((f) => {
    const v = f.verification;
    const failed = (v.before.checks || []).find((c) => !c.passed && c.level === 'must');
    must(failed, `${f.id} has no failing check before its patch`);
    const after = (v.after.checks || []).find((c) => c.name === failed.name);
    must(after, `${f.id} has no matching check after its patch`);
    return {
      id: f.id,
      patch: f.fix.chainIndex,
      title: f.title,
      check: failed.name,
      before: failed.detail || 'failed',
      after: after.detail || 'passed',
      bugBefore: !v.before.passed,
      clearAfter: !!v.after.passed,
    };
  });

  const cart = by((f) => f.ruleId === 'client-supplied-amount', 'one-cent cart');
  const cartRe = /store sent ([\d.]+) USD for a cart the browser priced at ([\d.]+)/;
  const cartBefore = read(detail(cart.verification.before, 'PayPal is asked for'), cartRe, 'the amount before the patch');
  const cartAfter = read(detail(cart.verification.after, 'PayPal is asked for'), cartRe, 'the amount after the patch');

  const hook = by((f) => f.ruleId === 'webhook-unverified', 'forged webhook');
  const statusRe = /order status after the forged event: (\w+)/;
  const answerRe = /webhook answered HTTP (\d+)/;
  const hookBefore = {
    status: read(detail(hook.verification.before, 'forged PAYMENT.CAPTURE.COMPLETED'), statusRe, 'the order status before the patch')[1],
    http: read(detail(hook.verification.before, 'answered with a 4xx'), answerRe, 'the webhook answer before the patch')[1],
  };
  const hookAfter = {
    status: read(detail(hook.verification.after, 'forged PAYMENT.CAPTURE.COMPLETED'), statusRe, 'the order status after the patch')[1],
    http: read(detail(hook.verification.after, 'answered with a 4xx'), answerRe, 'the webhook answer after the patch')[1],
    paypal: read(detail(hook.verification.after, 'verify the signature'), /(\w+) answered (\w+)/, "PayPal's answer after the patch"),
  };

  must(hookAfter.paypal[1] === 'sandbox', 'the page says the sandbox answered the signature check, and the report says otherwise');

  const capture = by((f) => f.ruleId === 'missing-request-id' && f.symbol === 'captureOrder', 'lost capture');
  const retryRe = /PayPal answered HTTP (\d+)\s*(\w*)/;
  const storeRe = /store status (\w+)/;
  const retryBefore = read(detail(capture.verification.before, 'the retry gets the original capture'), retryRe, 'the retry answer before the patch');
  const retryAfter = read(detail(capture.verification.after, 'the retry gets the original capture'), retryRe, 'the retry answer after the patch');
  const storeBefore = read(detail(capture.verification.before, 'the order ends up paid'), storeRe, 'the store status before the patch')[1];
  const storeAfter = read(detail(capture.verification.after, 'the order ends up paid'), storeRe, 'the store status after the patch')[1];

  const llmUsage = report.scan.llm.usage;
  const claudeCalls = llmUsage.calls + report.fix.usage.calls;
  const cost = llmUsage.costUsd + report.fix.usage.costUsd;
  const sandboxCalls = report.traffic.filter((t) => t.upstream === 'sandbox').length;
  const mockOnly = findings.filter((f) => !f.verification.after?.upstream?.includes('sandbox'));
  const probes = report.verify.final.probes;

  const verifiedRow = read(realRuns, /\*\*Verified: bug shown before, gone after\*\* \| \*\*(\d+) of (\d+)\*\* \| \*\*(\d+) of (\d+)\*\*/, 'the verified counts in docs/real-runs.md');
  const costRow = read(realRuns, /\| Cost \| \$([\d.]+) \| \$([\d.]+) \|/, 'the cost in docs/real-runs.md');
  const firstVerified = Number(verifiedRow[1]);
  must(Number(verifiedRow[3]) === gone && Number(verifiedRow[4]) === total, `docs/real-runs.md says ${verifiedRow[3]} of ${verifiedRow[4]}, the report says ${gone} of ${total}`);
  must(Number(verifiedRow[2]) === total, 'the first and second runs had different numbers of findings');
  must(money(costRow[2]) === money(cost), `docs/real-runs.md says $${costRow[2]}, the report says ${money(cost)}`);
  must(total - firstVerified - 1 === 7, 'the first-run story says one patch failed and the next seven failed on top of it');
  must(
    mockOnly.length === 2 && mockOnly.some((f) => f.ruleId === 'hardcoded-credentials') && mockOnly.some((f) => f.ruleId === 'capture-status-unchecked'),
    'the page explains why the credentials and pending webhook proofs ran on a mock, and that no longer matches the report',
  );

  const held = read(validation, /\*\*(\d+) of (\d+) correct, on (\d+) repos the detectors had never seen/, 'the precision number in docs/validation.md');

  return {
    runDate: new Date(report.verify.at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
    total, reproduced, gone, pads,
    cart: { id: cart.id, browserPrice: money(cartBefore[2]), before: money(cartBefore[1]), after: money(cartAfter[1]) },
    hook: { id: hook.id, before: hookBefore, after: { status: hookAfter.status, http: hookAfter.http, verdict: hookAfter.paypal[2] } },
    capture: { id: capture.id, before: { http: retryBefore[1], issue: retryBefore[2], store: storeBefore }, after: { http: retryAfter[1], store: storeAfter } },
    rules: RULES.length,
    staticFindings: report.scan.static,
    claudeFindings: findings.filter((f) => f.source === 'llm').length,
    claudeCalls,
    cost: money(cost),
    sandboxCalls,
    sandboxProofs: total - mockOnly.length,
    mockProofs: mockOnly.length,
    regression: { passed: probes.filter((p) => p.passed).length, total: probes.length },
    firstVerified,
    validation: { correct: Number(held[1]), total: Number(held[2]), repos: Number(held[3]) },
  };
}

const PULSE = '<svg class="pulse" viewBox="0 0 120 28" aria-hidden="true"><path d="M0 14 H38 L44 4 L52 24 L58 10 L62 14 H120" /></svg>';

function padButton(p, state, { interactive }) {
  const when = state === 'bug' ? 'the bug showed up before its patch' : 'the bug was gone after its patch';
  const label = `Patch ${p.patch}: ${p.title}. In this check, ${when}.`;
  const data = `data-finding="${esc(p.id)}" data-title="${esc(`Patch ${p.patch}: ${p.title}`)}" data-check="${esc(p.check)}" data-before="${esc(p.before)}" data-after="${esc(p.after)}"`;
  return `<li><button type="button" class="pad ${state}" style="--i:${p.patch - 1}" ${data} aria-label="${esc(label)}"${interactive ? '' : ' tabindex="-1"'}></button></li>`;
}

function reading(side, when, value, note) {
  const swatch = side === 'before' ? 'bug' : 'clear';
  return `<div class="reading ${side}"><span class="swatch ${swatch}"></span><span class="reading-when">${esc(when)}</span><span class="reading-value">${esc(value)}</span><span class="reading-note">${note}</span></div>`;
}

function proof({ title, why, measure, before, after, aside, id }) {
  return `<article class="proof-row">
        <div>
          <h3 class="d-h3">${esc(title)}</h3>
          <p class="proof-why">${esc(why)}</p>
          <a class="proof-open" href="#evidence" data-open-finding data-finding="${esc(id)}">See this proof in the results</a>
        </div>
        <div>
          <p class="proof-measure">${esc(measure)}</p>
          <div class="readings">${before}${after}</div>
          ${aside ? `<p class="proof-aside">${esc(aside)}</p>` : ''}
        </div>
      </article>`;
}

function miniStrip(name, result, states, label) {
  const pads = states.map((s) => `<li><span class="pad ${s}"></span></li>`).join('');
  return `<div class="strip">
          <p class="strip-label"><span class="strip-name">${esc(name)}</span> <span class="strip-result">${esc(result)}</span></p>
          <ol class="pads" role="img" aria-label="${esc(label)}">${pads}</ol>
        </div>`;
}

export function landingHtml(d) {
  const beforePads = d.pads.map((p) => padButton(p, p.bugBefore ? 'bug' : 'clear', { interactive: true })).join('');
  const afterPads = d.pads.map((p) => padButton(p, p.clearAfter ? 'clear' : 'bug', { interactive: false })).join('');
  const firstStates = d.pads.map((_, i) => (i < d.firstVerified ? 'clear' : 'bug'));

  const top = `<header class="d-wrap d-nav">
    <div class="d-brand">${PULSE}<span>paypal-doctor</span></div>
    <div class="d-nav-tools">
      <a href="${REPO_URL}" rel="noopener">Source</a>
      <button class="icon" id="theme-btn" title="Switch between light and dark" aria-label="Switch between light and dark">◐</button>
    </div>
  </header>

  <main>
    <section class="d-hero">
      <div class="d-wrap">
        <h1 class="d-display"><span>Finds PayPal integration bugs,</span> <span>writes the fix, and proves it</span> <span>against the sandbox.</span></h1>
        <p class="d-lede">A patch only counts if the bug shows up in a scripted checkout before it, and is gone after it. Here are all ${d.total} bugs from one run.</p>
        <div class="strips">
          <div class="strip strip-before">
            <p class="strip-label"><span class="strip-name">Before the patch</span> <span class="strip-result">${d.reproduced} of ${d.total} bugs showed up</span></p>
            <ol class="pads">${beforePads}</ol>
          </div>
          <div class="strip strip-after">
            <p class="strip-label"><span class="strip-name">After the patch</span> <span class="strip-result">${d.gone} of ${d.total} gone</span></p>
            <ol class="pads">${afterPads}</ol>
          </div>
        </div>
        <div class="strip-caption" id="strip-caption" aria-live="polite">
          <p class="caption-hint">This page is a read-only recording of one real run, from ${esc(d.runDate)}, on a demo shop with bugs seeded on purpose. Nothing runs here. Each square is one bug: point at one, or tap it, to see what was measured.</p>
          <div class="caption-detail">
            <div>
              <span class="caption-line caption-title"></span>
              <span class="caption-line">Checked: <span class="caption-check"></span></span>
            </div>
            <div>
              <span class="caption-line"><span class="caption-word b">Before:</span> <span class="caption-before"></span></span>
              <span class="caption-line"><span class="caption-word a">After:</span> <span class="caption-after"></span></span>
              <button class="linklike" id="caption-open" type="button">Show this one in the results</button>
            </div>
          </div>
        </div>
        <div class="d-cta">
          <a class="btn" href="#proofs">See three of the proofs</a>
          <a class="btn quiet" href="#evidence">Open the full results</a>
        </div>
      </div>
    </section>

    <section class="d-wrap d-section" id="proofs">
      <h2 class="d-h2">Three of the ${d.total}, up close</h2>
      <p class="d-intro">These are the recorded values from this run: the same scripted checkout, before the patch and after it.</p>
      <div class="proofs">
      ${proof({
    id: d.cart.id,
    title: 'The one-cent cart',
    why: 'The shop added up its total from the prices the browser sent, so anyone could edit a price and pay a cent.',
    measure: `What the shop asked PayPal to charge, when the browser priced a ${d.cart.after} mug at ${d.cart.browserPrice}`,
    before: reading('before', 'Before the patch', d.cart.before, 'The price the browser sent'),
    after: reading('after', 'After the patch', d.cart.after, "The price in the shop's own catalog"),
  })}
      ${proof({
    id: d.hook.id,
    title: 'The forged webhook',
    why: "The shop believed any JSON posted to its webhook URL. A fake payment event was enough to mark an order paid.",
    measure: 'The order status after a forged payment event',
    before: reading('before', 'Before the patch', d.hook.before.status, `The webhook answered HTTP ${esc(d.hook.before.http)}`),
    after: reading('after', 'After the patch', d.hook.after.status, `The webhook answered HTTP ${esc(d.hook.after.http)}, after PayPal's sandbox answered <code>${esc(d.hook.after.verdict)}</code>`),
    aside: 'A correctly signed event is still accepted. Only PayPal can sign one, so that part of the check runs on a local mock.',
  })}
      ${proof({
    id: d.capture.id,
    title: 'The lost capture response',
    why: 'PayPal takes the money, the response gets lost on the way back, and the buyer retries. The tool drops that response on purpose to test this.',
    measure: 'The HTTP status PayPal answered the retry with',
    before: reading('before', 'Before the patch', d.capture.before.http, `<code>${esc(d.capture.before.issue)}</code>, and the shop's order stays ${esc(d.capture.before.store)}, unpaid`),
    after: reading('after', 'After the patch', d.capture.after.http, `The retry gets the original capture back, and the shop's order says ${esc(d.capture.after.store)}`),
  })}
      </div>
    </section>

    <section class="d-band">
      <div class="d-wrap d-section">
        <h2 class="d-h2">How it gets there</h2>
        <ol class="steps">
          <li>
            <span class="step-num" aria-hidden="true">1</span>
            <h3 class="step-name">Find</h3>
            <p class="step-text">Detectors read the structure of the code for ${d.rules} rules, each tied to a PayPal doc, and Claude reviews what they missed. On this shop: ${d.staticFindings} findings from the detectors and ${d.claudeFindings} from Claude.</p>
          </li>
          <li>
            <span class="step-num" aria-hidden="true">2</span>
            <h3 class="step-name">Fix</h3>
            <p class="step-text">Claude writes a small patch for each finding, on top of the ones before it, so each can be tested on its own. With the review, that took ${d.claudeCalls} Claude calls and cost ${esc(d.cost)}.</p>
          </li>
          <li>
            <span class="step-num" aria-hidden="true">3</span>
            <h3 class="step-name">Prove</h3>
            <p class="step-text">The app runs a scripted checkout before and after each patch, with no browser. ${d.sandboxCalls} calls went to PayPal's sandbox. Then every check ran again with all the patches in, and ${d.regression.passed} of ${d.regression.total} passed.</p>
          </li>
        </ol>
      </div>
    </section>

    <section class="d-wrap d-section history">
      <div>
        <h2 class="d-h2">It didn't work the first time</h2>
        <p class="history-text">The first real run verified ${d.firstVerified} of ${d.total} patches, because of a fault in the tool. It only showed Claude the file with the bug, so one patch guessed at a field it couldn't see and broke checkout, and the next seven failed on top of it. After that was fixed, each patch had to pass before the next was written.</p>
        <div class="strips">
        ${miniStrip('First real run', `${d.firstVerified} of ${d.total} verified`, firstStates, `${d.firstVerified} of ${d.total} patches verified`)}
        ${miniStrip('Second real run', `${d.gone} of ${d.total} verified`, d.pads.map((p) => (p.clearAfter ? 'clear' : 'bug')), `${d.gone} of ${d.total} patches verified`)}
        </div>
      </div>
      <div>
        <h3 class="limits-title">What this doesn't show</h3>
        <ul class="limits">
          <li>This is one shop with bugs seeded on purpose, and the tool was fixed after seeing it fail here. ${d.gone} of ${d.total} says the loop works on this shop, not that patches will pass on your app.</li>
          <li>${d.sandboxProofs} of the ${d.total} proofs used PayPal's sandbox. The other ${d.mockProofs} ran on a local mock, because only PayPal can sign a webhook event, and fake credentials shouldn't be sent to it.</li>
          <li>The pending capture is injected. The sandbox won't produce one on demand, so the check rewrites a real response, and the results label it.</li>
          <li>On ${d.validation.repos} public repos it had never seen, ${d.validation.correct} of ${d.validation.total} of the static scan's findings were correct. Claude's patches and the sandbox checks haven't been run on those.</li>
        </ul>
      </div>
    </section>`;

  const evidenceHead = `<div class="evidence-head">
      <div>
        <h2 class="d-h2">Every check and every PayPal call from this run</h2>
        <p class="d-intro">Recorded on ${esc(d.runDate)}. Pick a finding to see its code, its patch and its checks before and after. Both grids are AG Grid Community, so you can sort, filter and export them.</p>
      </div>
      <p id="target-line">no report yet</p>
    </div>`;

  const bottom = `</main>

  <footer class="d-wrap d-foot">
    <div>
      <h2 class="d-h2">Run it yourself</h2>
      <p class="d-intro">You need Node 20.10 or newer, and no keys. It replays what Claude answered in this run, against a local PayPal mock.</p>
      <p class="d-legal">An independent project, MIT licensed. Not affiliated with or endorsed by PayPal.</p>
    </div>
    <pre class="d-run"><code>git clone ${REPO_URL}.git
cd paypal-doctor
npm install
npm run demo</code></pre>
  </footer>`;

  return { top, evidenceHead, bottom };
}
