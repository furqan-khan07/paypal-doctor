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

test('the static page has no way to start a run', () => {
  const html = staticIndex(fs.readFileSync('dashboard/public/index.html', 'utf8'), 'November 5, 2026');
  for (const gone of ['data-stage', 'data-mode', 'data-llm', '/vendor/']) assert.ok(!html.includes(gone), `${gone} should be gone`);
  assert.match(html, /data-static="recording"/);
  assert.match(html, /read-only recording/);
  assert.match(html, /first verified 3 of 11/);
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
    fs.writeFileSync(report, JSON.stringify(raw));
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
