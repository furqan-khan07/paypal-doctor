// Runs `--mode sandbox` with the mock standing in for api-m.sandbox.paypal.com,
// so the sandbox code path (credential check, webhook lookup, routing, mixed
// sandbox/mock probes) is covered without real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createMockPayPal } = await import('../src/mock-paypal/server.js');
const fakeSandbox = createMockPayPal();
const base = await fakeSandbox.start();
process.env.PAYPAL_DOCTOR_SANDBOX_BASE = base;
process.env.PAYPAL_CLIENT_ID = 'sim-client';
process.env.PAYPAL_CLIENT_SECRET = 'sim-secret-value';
process.env.PAYPAL_DOCTOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'paypal-doctor-sbx-'));
process.env.NO_COLOR = '1';
const { runScan, runFix, runVerify } = await import('../src/pipeline.js');

test('sandbox mode code path (mock as the sandbox)', { timeout: 120_000 }, async () => {
  try {
    let report = await runScan({ root: 'demo-store', llmMode: 'replay' });
    report = await runFix({ root: 'demo-store', report, llmMode: 'replay' });
    report = await runVerify({ root: 'demo-store', report, mode: 'sandbox' });
    assert.equal(report.verify.upstream, 'sandbox');
    assert.ok(report.findings.every((f) => f.verification.status === 'verified'));
    const byRule = Object.fromEntries(report.findings.map((f) => [f.ruleId, f.verification.after.upstream]));
    assert.deepEqual(byRule['hardcoded-credentials'], ['mock'], 'credential probe never sends fake creds to the sandbox');
    assert.deepEqual(byRule['client-supplied-amount'], ['sandbox']);
    assert.ok(fakeSandbox.state.calls.length > 50, 'the stand-in sandbox saw the probe traffic');
    const secret = report.traffic.map((t) => JSON.stringify(t)).join('\n');
    assert.doesNotMatch(secret, /sim-secret-value/);
  } finally {
    await fakeSandbox.stop();
  }
});
