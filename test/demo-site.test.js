// The hosted demo publishes a recorded run. These check that only the fields the
// dashboard shows get copied, and that the audit catches what must never be published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { publicReport, publicLog, staticIndex } from '../scripts/build-demo.mjs';
import { auditDir } from '../scripts/audit-demo.mjs';
import { landingData, landingHtml } from '../dashboard/demo/landing.mjs';

const check = { name: 'store created a PayPal order', passed: true, detail: 'HTTP 201', level: 'must' };
const proof = { passed: true, skipped: null, error: null, checks: [check], notes: [], upstream: ['sandbox'], requests: 2, ms: 10, title: 'A probe', probe: 'a-probe' };
const raw = {
  target: { name: 'shop', root: '/Users/someone/shop', config: { env: { clientSecret: 'PAYPAL_CLIENT_SECRET' } } },
  updatedAt: '2026-11-05T00:00:00.000Z',
  scan: { at: 'x', files: 1, static: 1, parseErrors: [{ file: '/Users/someone/shop/a.js' }], llm: { mode: 'record', model: 'm', count: 0, usage: { calls: 1 } } },
  fix: { at: 'x', llmMode: 'record', model: 'm', ready: 1, rejected: 0, unavailable: 0, usage: { calls: 1 } },
  verify: { at: 'x', mode: 'sandbox', upstream: 'sandbox', ms: 1, counts: { verified: 1 }, workRoot: '/private/var/folders/abc', final: { allPassed: true, patchedFiles: ['/Users/someone/shop/a.js'], remainingFindings: [], probes: [proof] } },
  findings: [{
    id: 'f1', key: 'k', ruleId: 'r', title: 't', severity: 'high', file: 'a.js', line: 1, symbol: 's', message: 'm', related: [], snippet: [{ line: 1, text: 'code' }], source: 'static', docs: [],
    fix: { status: 'ready', chainIndex: 1, explanation: 'e', notes: '', edits: [{ file: 'a.js', find: 'x', replace: 'y' }], files: [{ file: 'a.js', diff: '+y' }], source: 'live', handWritten: false, model: 'm', failedAttempts: [] },
    verification: { status: 'verified', mode: 'sandbox', probe: 'p', probeTitle: 'P', before: proof, after: proof, staticCleared: true, at: 'x' },
  }],
  traffic: [{
    seq: 1, t: 2, method: 'POST', originalUrl: 'http://127.0.0.1:9/v1/oauth2/token', url: 'https://api-m.sandbox.paypal.com/v1/oauth2/token', path: '/v1/oauth2/token',
    requestHeaders: { authorization: 'Basic <credentials fp:abcd1234>', 'content-type': 'x', 'paypal-request-id': 'req-1' },
    requestBody: 'grant_type=client_credentials', faults: [], status: 200, ms: 5, debugId: 'dbg1',
    responseBody: { scope: 's', access_token: 'A21AAtotallyfaketokenvalue', app_id: 'APP-FAKE', nonce: 'n1' },
    actor: 'app', app: 0, upstream: 'sandbox', phase: 'before', probe: 'p', findingId: 'f1',
  }],
};

// Shaped like a real run, so the story section has everything it reads.
function realLikeReport() {
  const passed = (name, detail) => ({ name, passed: true, detail, level: 'must' });
  const failed = (name, detail) => ({ name, passed: false, detail, level: 'must' });
  const result = (ok, checks, upstream = ['sandbox']) => ({ passed: ok, skipped: null, error: null, checks, notes: [], upstream, requests: 2, title: 'p', probe: 'p' });
  const finding = (n, ruleId, symbol, before, after, { upstream, source = 'static' } = {}) => ({
    id: `F-${n}`, ruleId, title: `Title ${n}`, severity: 'high', file: 'a.js', line: n, symbol, message: 'm', related: [], snippet: [], source, docs: [],
    fix: { status: 'ready', chainIndex: n, explanation: 'e', notes: '', files: [], source: 'live', handWritten: false, model: 'm', failedAttempts: [] },
    verification: { status: 'verified', mode: 'sandbox', probe: 'p', probeTitle: 'P', before: result(false, before), after: result(true, after, upstream), staticCleared: true, at: 'x' },
  });
  const generic = (n, ruleId, opts) => finding(n, ruleId, 's', [failed(`check ${n}`, `before ${n}`)], [passed(`check ${n}`, `after ${n}`)], opts);
  const cartName = 'PayPal is asked for 18.00 USD';
  const findings = [
    generic(1, 'deprecated-v1-payments'),
    generic(2, 'hardcoded-environment'),
    generic(3, 'hardcoded-credentials', { upstream: ['mock'] }),
    finding(4, 'client-supplied-amount', 's', [failed(cartName, 'store sent 0.01 USD for a cart the browser priced at 0.01')], [passed(cartName, 'store sent 18 USD for a cart the browser priced at 0.01')]),
    generic(5, 'amount-formatting'),
    generic(6, 'missing-request-id'),
    finding(7, 'missing-request-id', 'captureOrder',
      [failed('the retry gets the original capture back', 'PayPal answered HTTP 422 ORDER_ALREADY_CAPTURED'), failed('the order ends up paid', 'store status created, retry HTTP 422')],
      [passed('the retry gets the original capture back', 'PayPal answered HTTP 200 '), passed('the order ends up paid', 'store status paid, retry HTTP 200')]),
    generic(8, 'missing-request-id', { source: 'llm' }),
    generic(9, 'capture-status-unchecked'),
    generic(10, 'capture-status-unchecked', { upstream: ['mock'], source: 'llm' }),
    finding(11, 'webhook-unverified', 's',
      [failed('a forged PAYMENT.CAPTURE.COMPLETED does not mark the order paid', 'order status after the forged event: paid'), failed('the forged event is answered with a 4xx', 'webhook answered HTTP 200')],
      [passed('a forged PAYMENT.CAPTURE.COMPLETED does not mark the order paid', 'order status after the forged event: created'), passed('the forged event is answered with a 4xx', 'webhook answered HTTP 400'), passed('store asked PayPal to verify the signature', 'sandbox answered FAILURE')],
      { upstream: ['sandbox', 'mock'] }),
  ];
  return {
    target: { name: 'shop', root: '/Users/someone/shop', config: {} },
    updatedAt: '2026-11-05T00:00:00.000Z',
    scan: { at: 'x', files: 6, static: 9, parseErrors: [], llm: { mode: 'record', model: 'm', count: 2, usage: { calls: 1, costUsd: 0.043 } } },
    fix: { at: 'x', llmMode: 'record', model: 'm', ready: 11, rejected: 0, unavailable: 0, usage: { calls: 11, costUsd: 0.4704 } },
    verify: { at: '2026-11-05T08:19:35.536Z', mode: 'sandbox', upstream: 'sandbox', ms: 1, counts: { verified: 11 }, final: { allPassed: true, remainingFindings: [], probes: Array.from({ length: 11 }, () => proof) } },
    findings,
    traffic: [{ method: 'POST', path: '/v2/checkout/orders', status: 201, ms: 5, debugId: 'dbg', faults: [], actor: 'app', upstream: 'sandbox', phase: 'before', findingId: 'F-1', requestHeaders: {}, responseBody: {} }, { method: 'POST', path: '/x', status: 200, ms: 5, debugId: 'd2', faults: [], actor: 'app', upstream: 'mock', phase: 'before', findingId: 'F-3', requestHeaders: {}, responseBody: {} }],
  };
}
const docs = { realRuns: fs.readFileSync('docs/real-runs.md', 'utf8'), validation: fs.readFileSync('docs/validation.md', 'utf8') };

const inTempDir = (files, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paypal-doctor-audit-'));
  try {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('publicReport copies what the dashboard shows and nothing else', () => {
  const out = publicReport(raw);
  const text = JSON.stringify(out);
  for (const bad of ['/Users/someone', '/private/var', 'fp:abcd1234', 'A21AA', 'APP-FAKE', 'nonce', 'edits', 'originalUrl', '127.0.0.1', 'grant_type', 'PAYPAL_CLIENT_SECRET', 'usage']) {
    assert.ok(!text.includes(bad), `${bad} should not be published`);
  }
  assert.equal(out.target.root, 'demo-store');
  assert.equal(out.traffic[0].said, 'access token', 'worked out before the raw response is dropped');
  assert.deepEqual(out.traffic[0].requestHeaders, { 'paypal-request-id': 'req-1' });
  assert.equal(out.findings[0].fix.files[0].diff, '+y');
  assert.equal(out.verify.final.probes[0].checks[0].detail, 'HTTP 201');
});

test('publicLog removes the local project path', () => {
  const log = publicLog('{"level":"step","text":"Scanning /Users/someone/project/demo-store","extra":"x"}\n', '/Users/someone/project');
  assert.deepEqual(log, [{ level: 'step', text: 'Scanning demo-store' }]);
});

test('the static page has no way to start a run, and keeps what the dashboard needs', () => {
  const html = staticIndex(fs.readFileSync('dashboard/public/index.html', 'utf8'), landingHtml(landingData(realLikeReport(), docs)));
  for (const gone of ['data-stage', 'data-mode', 'data-llm', '/vendor/']) assert.ok(!html.includes(gone), `${gone} should be gone`);
  assert.match(html, /data-static="recording"/);
  assert.match(html, /read-only recording/);
  assert.match(html, /first real run verified 3 of 11/);
  for (const id of ['findings-grid', 'traffic-grid', 'detail', 'target-line', 'theme-btn', 'vitals', 'log', 'final-list', 'strip-caption', 'evidence']) {
    assert.equal(html.split(`id="${id}"`).length, 2, `exactly one #${id}`);
  }
  assert.equal(html.split('<main').length, 2, 'one main element');
  // Everything it loads is its own file. The only outside links are for people to click.
  const loaded = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(loaded.length >= 6);
  for (const url of loaded) assert.ok(!/^(https?:)?\/\//.test(url), `loads from elsewhere: ${url}`);
});

test('the story section reads its numbers from the run and the docs', () => {
  const d = landingData(realLikeReport(), docs);
  assert.deepEqual([d.cart.before, d.cart.after], ['$0.01', '$18.00']);
  assert.deepEqual([d.hook.before.status, d.hook.after.status, d.hook.after.http, d.hook.after.verdict], ['paid', 'created', '400', 'FAILURE']);
  assert.deepEqual([d.capture.before.http, d.capture.before.issue, d.capture.before.store, d.capture.after.http, d.capture.after.store], ['422', 'ORDER_ALREADY_CAPTURED', 'created', '200', 'paid']);
  assert.deepEqual([d.total, d.reproduced, d.gone, d.firstVerified, d.sandboxProofs, d.mockProofs], [11, 11, 11, 3, 9, 2]);
  assert.deepEqual(d.validation, { correct: 23, total: 27, repos: 20 });
  assert.equal(d.cost, '$0.51');
  const html = landingHtml(d).top;
  assert.equal(html.split('class="pad bug"').length - 1, 11 + 8, '11 before, plus 8 in the first-run strip');
  assert.equal(html.split('tabindex="-1"').length - 1, 11, 'one keyboard stop per bug');
});

test('the story section refuses to publish what it cannot back up', () => {
  const missing = realLikeReport();
  missing.findings[3].verification.before.checks = [];
  assert.throws(() => landingData(missing, docs), /F-4 has no failing check/);

  const renamed = realLikeReport();
  renamed.findings[3].verification.before.checks[0].name = 'something else';
  renamed.findings[3].verification.after.checks[0].name = 'something else';
  assert.throws(() => landingData(renamed, docs), /no check containing/);

  const notProven = realLikeReport();
  notProven.findings[0].verification.after.passed = false;
  assert.throws(() => landingData(notProven, docs), /docs\/real-runs\.md says 11 of 11/);

  const pricey = realLikeReport();
  pricey.fix.usage.costUsd = 2;
  assert.throws(() => landingData(pricey, docs), /says \$0\.5134/);

  const movedToSandbox = realLikeReport();
  movedToSandbox.findings[2].verification.after.upstream = ['sandbox'];
  assert.throws(() => landingData(movedToSandbox, docs), /ran on a mock/);

  const reworded = { ...docs, validation: 'nothing useful' };
  assert.throws(() => landingData(realLikeReport(), reworded), /docs\/validation\.md/);
});

test('text from a report is escaped in the story section', () => {
  const report = realLikeReport();
  report.findings[0].title = '<img src=x onerror=alert(1)>';
  const html = landingHtml(landingData(report, docs)).top;
  assert.ok(!html.includes('<img'), 'no raw HTML from the report');
});

test('the audit flags the raw report and passes the public one', () => {
  const secrets = [['PAYPAL_CLIENT_ID', 'a-real-looking-client-id']];
  const dirty = inTempDir({ 'report.json': JSON.stringify(raw), 'log.json': '"Scanning /Users/someone/x"', 'app.js': 'const id = "a-real-looking-client-id";' }, (d) => auditDir(d, { secrets }).hits);
  const rules = dirty.map((h) => h.rule);
  for (const rule of ['home directory', 'credential fingerprint', 'authorization value', 'raw PayPal field', 'local address', 'PayPal access token', 'value of PAYPAL_CLIENT_ID']) {
    assert.ok(rules.includes(rule), `should flag: ${rule}`);
  }
  assert.ok(!JSON.stringify(dirty).includes('a-real-looking-client-id'), 'never repeats a value it found');

  const clean = inTempDir({ 'report.json': JSON.stringify(publicReport(raw)), 'log.json': JSON.stringify(publicLog('{"level":"info","text":"ok"}\n')) }, (d) => auditDir(d, { secrets }).hits);
  assert.deepEqual(clean, []);
});

test('the audit tells a card number from a float or an order id, and code from data', () => {
  const data = JSON.stringify({ a: 'store sent "0.30000000000000004"', b: '01304821640838158 CREATED', c: 'Authorization: `Bearer ${accessToken}`, webhook_id: webhookId' });
  assert.deepEqual(inTempDir({ 'report.json': data }, (d) => auditDir(d, { secrets: [] }).hits), []);
  const card = inTempDir({ 'report.json': JSON.stringify({ a: 'card 4012888888881881' }) }, (d) => auditDir(d, { secrets: [] }).hits);
  assert.deepEqual(card.map((h) => h.rule), ['card number']);
});

test('the audit refuses any .env file by name, without reading it, and catches tokens', () => {
  const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
  const hits = inTempDir({ '.env.local': `VERCEL_OIDC_TOKEN="${token}"\n`, '.env': 'A=1\n', 'app.js': `const t = "${token}";` }, (d) => auditDir(d, { secrets: [] }).hits);
  assert.deepEqual(hits.filter((h) => /env file/.test(h.rule)).map((h) => h.rel).sort(), ['.env', '.env.local']);
  assert.ok(hits.some((h) => h.rel === 'app.js' && h.rule === 'token (JWT)'));
  assert.ok(!JSON.stringify(hits).includes(token), 'never repeats the token');
  assert.deepEqual(inTempDir({ '.environment.md': 'fine', 'envelope.js': 'fine' }, (d) => auditDir(d, { secrets: [] }).hits), [], 'only real env files count');
});

// Runs the real deploy script with a stand-in for npx, so nothing reaches Vercel. The
// stand-in does what the real link step does: it drops a token in .env.local.
test('the deploy script never uploads the token, including on a re-run', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paypal-doctor-deploy-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(dir, 'calls.log');
    fs.writeFileSync(path.join(bin, 'npx'), `#!/usr/bin/env bash
case "$*" in
  *" link "*) printf 'VERCEL_OIDC_TOKEN="eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2ln"\\n' > .env.local; printf '.vercel\\n.env*\\n' > .gitignore; mkdir -p .vercel; echo '{}' > .vercel/project.json; echo link >> "${calls}" ;;
  *" deploy "*) echo "deploy sees: $(ls -A | tr '\\n' ' ')" >> "${calls}"; printf 'x' > .env.local ;;
esac
`, { mode: 0o755 });
    const report = path.join(dir, 'report.json');
    const log = path.join(dir, 'log');
    fs.writeFileSync(report, JSON.stringify(realLikeReport()));
    fs.writeFileSync(log, '{"level":"info","text":"ok"}\n');
    const site = path.join(dir, 'site');
    const run = () => execFileSync('bash', ['scripts/deploy-demo.sh', '--report', report, '--log', log], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PAYPAL_DOCTOR_DEMO_DIR: site },
      stdio: 'pipe',
    });
    run();
    assert.equal(fs.existsSync(path.join(site, '.env.local')), false, 'gone after the first run');
    fs.writeFileSync(path.join(site, '.env.local'), 'left over from an earlier link\n');
    run();
    const seen = fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.startsWith('deploy sees'));
    assert.equal(seen.length, 2);
    for (const line of seen) {
      assert.ok(!/\.env/.test(line.replace('.vercelignore', '')), `no env file at upload: ${line}`);
      assert.match(line, /\.vercelignore/);
      assert.match(line, /report\.json/);
    }
    assert.equal(fs.existsSync(path.join(site, '.env.local')), false, 'cleaned up after deploying too');
    assert.equal(fs.readFileSync(path.join(site, '.vercelignore'), 'utf8'), '.env*\n.vercel\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
