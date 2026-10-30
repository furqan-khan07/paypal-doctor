// Verification: for each patch in the chain, run its probe on the code
// before the patch (should fail - bug reproduced) and after it (should pass),
// re-run the static scan on the patched code, then run every probe once more
// on the fully patched app as a regression pass.
import fs from 'node:fs';
import path from 'node:path';
import { createMockPayPal, MOCK_WEBHOOK_ID } from '../mock-paypal/server.js';
import { PayPalClient, SANDBOX_BASE } from './paypal-client.js';
import { ProbeRun } from './probe-run.js';
import { PROBES, selectProbe, CANARY_BASE } from './probes.js';
import { makeWorkRoot, materialize, removeDir } from './workspace.js';
import { treeAfter } from '../fix/index.js';
import { scanStatic } from '../scan/index.js';
import { loadSecrets, hasPayPalKeys } from '../env.js';
import { log } from '../log.js';

const MAX_TRAFFIC = 1500;

async function mockUpstream() {
  const mock = createMockPayPal();
  const base = await mock.start();
  const creds = { clientId: 'mock-client-id', clientSecret: 'mock-client-secret' };
  return {
    kind: 'mock',
    base,
    creds,
    webhookId: MOCK_WEBHOOK_ID,
    client: new PayPalClient({ base, ...creds }),
    routes: { [SANDBOX_BASE]: base, 'https://api.sandbox.paypal.com': base, [CANARY_BASE]: base, [base]: base },
    stop: () => mock.stop(),
  };
}

async function sandboxUpstream() {
  if (!hasPayPalKeys()) {
    throw new Error('--mode sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox app credentials) in .env.');
  }
  const s = loadSecrets();
  const creds = { clientId: s.paypalClientId, clientSecret: s.paypalClientSecret };
  const client = new PayPalClient({ base: SANDBOX_BASE, ...creds });
  await client.accessToken(); // fail fast on bad credentials
  const webhookId = s.paypalWebhookId || (await client.ensureProbeWebhook());
  return {
    kind: 'sandbox',
    base: SANDBOX_BASE,
    creds,
    webhookId,
    client,
    routes: { [CANARY_BASE]: SANDBOX_BASE },
    stop: async () => {},
  };
}

async function runProbe(probe, { dir, config, upstream, mock, workDir, label }) {
  const run = new ProbeRun({ dir, config, upstream, mockUpstream: mock, workDir, label });
  const started = Date.now();
  if (probe.missing?.length) {
    run.skip(`paypal-doctor.json is missing route(s): ${probe.missing.join(', ')}`);
  } else {
    try {
      await probe.run(run);
    } catch (err) {
      run.check('probe ran to completion', false, err.message);
    }
  }
  const result = await run.finish();
  return { ...result, probe: probe.id, title: probe.title, ms: Date.now() - started };
}

function classify(before, after, staticCleared) {
  if (!after) return staticCleared ? 'static-only' : 'failed';
  if (after.skipped) return 'skipped';
  if (!after.passed) return 'failed';
  if (before && !before.skipped && !before.passed) return 'verified';
  return 'fixed';
}

export async function verifyFindings({ root, report, mode = 'mock', keep = false, onFinding }) {
  const config = report.target.config;
  const mock = await mockUpstream();
  let upstream = mock;
  const workRoot = makeWorkRoot(config.name || 'target');
  const traffic = [];
  const pushTraffic = (entries, tags) => {
    for (const e of entries) if (traffic.length < MAX_TRAFFIC) traffic.push({ ...e, ...tags });
  };

  try {
    if (mode === 'sandbox') {
      log.step('Connecting to the PayPal sandbox…');
      upstream = await sandboxUpstream();
      log.ok('  sandbox credentials accepted');
    }

    const patched = report.findings.filter((f) => f.fix?.status === 'ready').sort((a, b) => a.fix.chainIndex - b.fix.chainIndex);
    const states = [];
    const stateDir = (i) => {
      if (!states[i]) states[i] = materialize(root, treeAfter(root, report.findings, i), path.join(workRoot, `state-${i}`));
      return states[i];
    };

    for (const f of patched) {
      const i = f.fix.chainIndex;
      const probe = selectProbe(f, config);
      const ctx = { config, upstream, mock, workDir: workRoot };
      log.step(`[${i}/${patched.length}] ${f.ruleId} @ ${f.file}:${f.line}${probe ? ` - probe "${probe.title}"` : ' - static check only'}`);
      const before = probe ? await runProbe(probe, { ...ctx, dir: stateDir(i - 1), label: `${i}-before` }) : null;
      if (before) log.dim(`    before: ${before.skipped ? `skipped (${before.skipped})` : before.passed ? 'passed (bug not reproduced)' : 'failed - bug reproduced'}`);
      const after = probe ? await runProbe(probe, { ...ctx, dir: stateDir(i), label: `${i}-after` }) : null;
      if (after) log.dim(`    after:  ${after.skipped ? `skipped (${after.skipped})` : after.passed ? 'passed' : 'FAILED'}`);
      const rescan = scanStatic(stateDir(i));
      const staticCleared = !rescan.findings.some((x) => x.key === f.key);
      const status = classify(before, after, staticCleared);
      if (before) pushTraffic(before.traffic, { findingId: f.id, phase: 'before', probe: probe.id });
      if (after) pushTraffic(after.traffic, { findingId: f.id, phase: 'after', probe: probe.id });
      const strip = (r) => (r ? { ...r, traffic: undefined, requests: r.traffic.length } : null);
      f.verification = { status, mode, probe: probe?.id || null, probeTitle: probe?.title || null, before: strip(before), after: strip(after), staticCleared, at: new Date().toISOString() };
      const line = { verified: log.ok, fixed: log.ok, 'static-only': log.ok, skipped: log.warn, failed: log.error }[status] || log.info;
      line(`    → ${status}${staticCleared ? '' : ' (static detector still reports it)'}`);
      onFinding?.(f);
    }

    // Regression pass on the fully patched app.
    const finalIndex = patched.length;
    const finalDir = stateDir(finalIndex);
    const probeIds = [...new Set(report.findings.map((f) => selectProbe(f, config)?.id).filter(Boolean))];
    log.step(`Regression pass: ${probeIds.length} probe(s) on the fully patched app`);
    const finalResults = [];
    for (const id of probeIds) {
      const probe = { id, ...PROBES[id], missing: PROBES[id].routes.filter((r) => !config.routes?.[r]) };
      const res = await runProbe(probe, { config, upstream, mock, workDir: workRoot, dir: finalDir, label: `final-${id}` });
      pushTraffic(res.traffic, { findingId: null, phase: 'final', probe: id });
      finalResults.push({ ...res, traffic: undefined, requests: res.traffic.length });
      (res.passed ? log.ok : res.skipped ? log.warn : log.error)(`  ${res.passed ? '✓' : res.skipped ? '–' : '✗'} ${probe.title}${res.skipped ? ` (skipped: ${res.skipped})` : ''}`);
    }
    const remaining = scanStatic(finalDir).findings;
    const final = {
      probes: finalResults,
      allPassed: finalResults.every((r) => r.passed || r.skipped) && finalResults.some((r) => r.passed),
      remainingFindings: remaining.map((f) => ({ ruleId: f.ruleId, file: f.file, line: f.line, message: f.message })),
      patchedFiles: [...treeAfter(root, report.findings).overrides.keys()],
    };
    return { traffic, final, upstream: upstream.kind, workRoot: keep ? workRoot : null };
  } finally {
    await mock.stop();
    if (upstream !== mock) await upstream.stop();
    if (!keep) removeDir(workRoot);
  }
}

export function writePatchedTree(root, report, dest) {
  const tree = treeAfter(root, report.findings);
  for (const [file, content] of tree.overrides) {
    const abs = path.join(dest, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return [...tree.overrides.keys()];
}
