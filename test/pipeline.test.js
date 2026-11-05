import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep the test's report away from the one the dashboard shows.
process.env.PAYPAL_DOCTOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'paypal-doctor-test-'));
process.env.NO_COLOR = '1';
const { runScan, runFixAndVerify } = await import('../src/pipeline.js');

test('demo store: scan, then write and verify on the mock, every patch verified', { timeout: 120_000 }, async () => {
  const root = 'demo-store';
  let report = await runScan({ root, llmMode: 'replay' });
  assert.equal(report.findings.length, 11, '9 static + 2 from the recorded Claude review');
  assert.equal(report.findings.filter((f) => f.source === 'llm').length, 2);
  assert.ok(report.findings.filter((f) => f.source === 'llm').every((f) => f.llm.handWritten === false), 'the review is recorded model output');

  report = await runFixAndVerify({ root, report, llmMode: 'replay', mode: 'mock' });
  assert.equal(report.fix.ready, 11);
  assert.equal(report.fix.rejected, 0);
  assert.ok(report.findings.every((f) => f.fix.handWritten === false), 'the patches are recorded model output');
  for (const f of report.findings) {
    assert.equal(f.verification.status, 'verified', `${f.ruleId} @ ${f.file}:${f.line}: ${JSON.stringify(f.verification.after?.checks?.filter((c) => !c.passed))}`);
    assert.equal(f.verification.staticCleared, true, `${f.ruleId} still reported after its patch`);
  }
  assert.equal(report.verify.final.allPassed, true);
  assert.deepEqual(report.verify.final.remainingFindings, []);
  assert.ok(report.traffic.length > 50, 'traffic was recorded');
  const auth = report.traffic.flatMap((t) => Object.values(t.requestHeaders || {})).join(' ');
  assert.doesNotMatch(auth, /mock-client-secret/, 'credentials never land in the trace');
  assert.ok(!report.traffic.some((t) => /api-m\.paypal\.com/.test(t.url)), 'nothing went to the live host');
});
