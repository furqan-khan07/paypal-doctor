// The patch chain with verification turned on. Uses a fake model, because what's
// being tested is what the doctor does with good and bad answers, not the answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PAYPAL_DOCTOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'paypal-doctor-chain-'));
process.env.NO_COLOR = '1';
const { generateFixes, treeAfter } = await import('../src/fix/index.js');
const { createVerifier } = await import('../src/verify/index.js');
const { scanStatic } = await import('../src/scan/index.js');
const { loadTargetConfig } = await import('../src/report.js');

const root = 'demo-store';
const config = loadTargetConfig(root);
const findings = (ruleIds) => scanStatic(root).findings.filter((f) => ruleIds.includes(f.ruleId));

const HARDCODED_BASE = 'const base = "https://api-m.sandbox.paypal.com";';
const noOp = { explanation: 'does nothing', notes: '', edits: [{ file: 'paypal.js', find: HARDCODED_BASE, replace: `// looks fixed\n${HARDCODED_BASE}` }] };
const realFix = { explanation: 'reads the base url from the environment', notes: '', edits: [{ file: 'paypal.js', find: HARDCODED_BASE, replace: 'const base = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";' }] };

function fakeLLM(answers) {
  const calls = [];
  return {
    calls,
    mode: 'live',
    model: 'fake',
    async json({ key, prompt }) {
      calls.push({ key, prompt });
      const kind = key.split('|').at(-1);
      const output = answers[kind] ?? answers.first;
      return output ? { output, from: 'live', handWritten: false, model: 'fake' } : null;
    },
  };
}

async function withVerifier(fn) {
  const verifier = await createVerifier({ root, config, mode: 'mock' });
  try {
    await fn(verifier);
  } finally {
    await verifier.close();
  }
}

test('a patch that fails its probe goes back to the model with the evidence, and the fix is kept', { timeout: 120_000 }, async () => {
  await withVerifier(async (verifier) => {
    const list = findings(['hardcoded-environment']);
    const llm = fakeLLM({ first: noOp, repair: realFix });
    await generateFixes({ root, findings: list, llm, config, verifier });
    const [f] = list;
    assert.equal(f.fix.status, 'ready');
    assert.equal(f.fix.chainIndex, 1);
    assert.equal(f.verification.status, 'verified');
    assert.equal(f.fix.failedAttempts.length, 1);
    assert.equal(llm.calls.length, 2);
    assert.match(llm.calls[1].key, /\|repair$/);
    assert.match(llm.calls[1].prompt, /failed verification when the app was run/);
    assert.match(llm.calls[1].prompt, /FAILED:/);
  });
});

test('a patch that still fails is left out, and the next patch is not built on it', { timeout: 120_000 }, async () => {
  await withVerifier(async (verifier) => {
    const list = findings(['hardcoded-environment', 'hardcoded-credentials']);
    const bad = fakeLLM({ first: noOp });
    await generateFixes({ root, findings: list, llm: bad, config, verifier });
    for (const f of list) {
      assert.equal(f.fix.status, 'rejected', `${f.ruleId} should have been left out`);
      assert.equal(f.fix.chainIndex, undefined);
      assert.equal(f.verification.status, 'failed');
      assert.ok(f.fix.files.length, 'the failed diff is kept so you can read it');
    }
    assert.equal(treeAfter(root, list).get('paypal.js'), fs.readFileSync(path.join(root, 'paypal.js'), 'utf8'), 'nothing rejected reaches the final code');
  });
});

test('the prompt shows imports and the request shape, and only lists issues still open', async () => {
  const list = findings(['hardcoded-environment', 'client-supplied-amount', 'webhook-unverified']);
  const llm = fakeLLM({});
  await generateFixes({ root, findings: list, llm, config });
  const amount = llm.calls.find((c) => c.key.includes('client-supplied-amount')).prompt;
  assert.match(amount, /Current contents of catalog\.js/, 'the file the patch needs to import from');
  assert.match(amount, /"sku":"mug"/, 'the shape of a real request');
  assert.match(amount, /POST \/api\/orders/);
  const open = amount.slice(amount.indexOf('Other known issues'), amount.indexOf('Current contents'));
  assert.match(open, /webhook-unverified/);
  assert.doesNotMatch(open, /hardcoded-environment/, 'already handled, so not listed');
});
