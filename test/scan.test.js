import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanStatic } from '../src/scan/index.js';

const summary = (findings) => findings.map((f) => `${f.ruleId}@${f.file}`).sort();

test('demo store: every seeded bug is found by the static pass', () => {
  const { findings, parseErrors } = scanStatic('demo-store');
  assert.deepEqual(parseErrors, []);
  assert.deepEqual(summary(findings), [
    'amount-formatting@paypal.js',
    'capture-status-unchecked@server.js',
    'client-supplied-amount@server.js',
    'deprecated-v1-payments@paypal.js',
    'hardcoded-credentials@paypal.js',
    'hardcoded-environment@paypal.js',
    'missing-request-id@paypal.js',
    'missing-request-id@paypal.js',
    'webhook-unverified@server.js',
  ]);
  const ids = new Set(findings.map((f) => f.id));
  assert.equal(ids.size, findings.length, 'finding ids are unique');
});

test('client-supplied-amount follows the price across files', () => {
  const { findings } = scanStatic('demo-store');
  const f = findings.find((x) => x.ruleId === 'client-supplied-amount');
  assert.match(f.message, /item\.price/);
  assert.match(f.message, /paypal\.js:\d+/);
});

test('edge cases: true positives', () => {
  const { findings } = scanStatic('test/fixtures/edge-cases');
  const got = summary(findings);
  for (const expected of [
    'deprecated-sdk@package.json',
    'deprecated-sdk@legacy.js',
    'hardcoded-credentials@legacy.js',
    'client-supplied-amount@legacy.js',
    'amount-formatting@jpy.js',
    'webhook-unverified@app/api/paypal/webhook/route.ts',
  ]) assert.ok(got.includes(expected), `missing ${expected}`);
  const rid = findings.filter((f) => f.ruleId === 'missing-request-id');
  assert.equal(rid.length, 2);
  assert.ok(rid.some((f) => /constant/.test(f.message)), 'constant request id is called out');
  assert.ok(rid.some((f) => /refund/.test(f.message)), 'refund without request id');
});

test('edge cases: env switches, env fallbacks and placeholders are not flagged', () => {
  const { findings } = scanStatic('test/fixtures/edge-cases');
  assert.equal(findings.filter((f) => f.file === 'env-switch.js').length, 0);
  assert.equal(findings.filter((f) => f.ruleId === 'hardcoded-environment').length, 0);
});

test('@paypal/paypal-server-sdk (TypeScript): the buggy file is flagged, the correct one is not', () => {
  const { findings, parseErrors } = scanStatic('test/fixtures/sdk-app');
  assert.deepEqual(parseErrors, []);
  assert.deepEqual(summary(findings), [
    'capture-status-unchecked@src/paypal.ts',
    'client-supplied-amount@src/paypal.ts',
    'hardcoded-environment@src/paypal.ts',
    'missing-request-id@src/paypal.ts',
    'missing-request-id@src/paypal.ts',
  ]);
  assert.equal(findings.filter((f) => f.file === 'src/paypal-ok.ts').length, 0);
});

test('patterns from real codebases: true positives', () => {
  const { findings, parseErrors } = scanStatic('test/fixtures/real-world');
  assert.deepEqual(parseErrors, [], 'decorators parse');
  const got = summary(findings);
  assert.deepEqual(got, [
    'amount-formatting@services/paypal-numbers.ts',
    'capture-status-unchecked@services/paypal-http-status.js',
    'deprecated-v1-payments@services/paypal-payouts.js',
    'hardcoded-credentials@config/secrets.js',
    'hardcoded-environment@config/secrets.js',
    'hardcoded-environment@services/paypal-numbers.ts',
    'missing-request-id@services/paypal-http-status.js',
    'missing-request-id@services/paypal-wrapper-calls.js',
    'missing-request-id@services/paypal-wrapper-calls.js',
    'webhook-unverified@routes/index.js',
    'webhook-unverified@services/nest-paypal.controller.ts',
  ]);
  const hook = findings.find((f) => f.file === 'routes/index.js' && f.ruleId === 'webhook-unverified');
  assert.match(hook.message, /POST \/paypal\/webhook acts on/, 'only the unverified PayPal route, via controller.method');
  assert.match(findings.find((f) => f.file === 'services/paypal-http-status.js' && f.ruleId === 'missing-request-id').message, /new PayPal-Request-Id every time/);
  assert.match(findings.find((f) => f.ruleId === 'deprecated-v1-payments').message, /\/v1\/payments\/sale/);
  assert.match(findings.find((f) => f.ruleId === 'hardcoded-credentials').message, /client_secret/);
});
