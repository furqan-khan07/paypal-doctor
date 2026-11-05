// Verification: for each patch in the chain, run its probe on the code
// before the patch (should fail - bug reproduced) and after it (should pass),
// re-run the static scan on the patched code, then run every probe once more
// on the fully patched app as a regression pass.
import path from 'node:path';
import { createMockPayPal, MOCK_WEBHOOK_ID } from '../mock-paypal/server.js';
import { PayPalClient, SANDBOX_BASE, REAL_SANDBOX_BASE } from './paypal-client.js';
import { ProbeRun, AppStartError } from './probe-run.js';
import { startApp } from './app-runner.js';
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
    routes: { [REAL_SANDBOX_BASE]: base, 'https://api.sandbox.paypal.com': base, [CANARY_BASE]: base, [base]: base },
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
  let webhookId = s.paypalWebhookId;
  if (!webhookId) {
    try {
      webhookId = await client.ensureProbeWebhook();
    } catch (err) {
      // Not fatal: only the webhook probes need it, and they'll say why they can't verify.
      log.warn(`  ${err.message}`);
      webhookId = null;
    }
  }
  return {
    kind: 'sandbox',
    base: SANDBOX_BASE,
    creds,
    webhookId,
    client,
    routes: SANDBOX_BASE === REAL_SANDBOX_BASE
      ? { [CANARY_BASE]: SANDBOX_BASE }
      : { [CANARY_BASE]: SANDBOX_BASE, [SANDBOX_BASE]: SANDBOX_BASE, [REAL_SANDBOX_BASE]: SANDBOX_BASE },
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
      if (err instanceof AppStartError) run.error = err.message;
      else run.check('probe ran to completion', false, err.message);
    }
  }
  const result = await run.finish();
  return { ...result, probe: probe.id, title: probe.title, ms: Date.now() - started };
}

function firstError(lines) {
  const hit = lines.find((l) => /\b(Error|ERR_[A-Z_]+)\b/.test(l));
  return hit ? hit.trim() : lines.slice(-3).join(' | ') || '(none)';
}

function classify(before, after, staticCleared) {
  if (!after) return staticCleared ? 'static-only' : 'failed';
  if (after.error) return 'error';
  if (after.skipped) return 'skipped';
  if (!after.passed) return 'failed';
  if (before && !before.skipped && !before.error && !before.passed) return 'verified';
  return 'fixed';
}

// Everything verification needs for one run: the upstreams, a place to materialise
// copies of the app, and the traffic log. Used while the chain is being built, and to
// re-verify a stored chain.
export async function createVerifier({ root, config, mode = 'mock', keep = false }) {
  const mock = await mockUpstream();
  let upstream = mock;
  const workRoot = makeWorkRoot(config.name || 'target');
  const traffic = [];
  const dirs = new Map();
  let dirCount = 0;
  const dirFor = (tree) => {
    if (!dirs.has(tree)) dirs.set(tree, materialize(root, tree, path.join(workRoot, `state-${dirCount++}`)));
    return dirs.get(tree);
  };
  const pushTraffic = (entries, tags) => {
    for (const e of entries) if (traffic.length < MAX_TRAFFIC) traffic.push({ ...e, ...tags });
  };
  const close = async () => {
    await mock.stop();
    if (upstream !== mock) await upstream.stop();
    if (!keep) removeDir(workRoot);
  };

  try {
    if (mode === 'sandbox') {
      log.step('Connecting to the PayPal sandbox…');
      upstream = await sandboxUpstream();
      log.ok('  sandbox credentials accepted');
    }
    // Make sure the unpatched app starts at all; otherwise every probe would
    // "fail" for reasons that have nothing to do with the patches.
    const smoke = await startApp({ dir: dirFor(treeAfter(root, [])), config, env: { [config.env?.apiBase || 'PAYPAL_API_BASE']: mock.base, [config.env?.clientId || 'PAYPAL_CLIENT_ID']: mock.creds.clientId, [config.env?.clientSecret || 'PAYPAL_CLIENT_SECRET']: mock.creds.clientSecret }, routes: mock.routes, traceFile: path.join(workRoot, 'smoke.jsonl') });
    await smoke.stop();
    if (!smoke.ready) {
      throw new Error(`Could not start the app with "${config.start || 'node server.js'}" in a copy of ${root} (waited for ${config.readyPath || '/'}). Has \`npm install\` been run there? Output: ${firstError(smoke.output())}`);
    }
  } catch (err) {
    await close();
    throw err;
  }

  return {
    get upstream() {
      return upstream.kind;
    },
    traffic,
    workRoot: keep ? workRoot : null,
    close,

    // Run one patch's probe on the code before and after it. Traffic is only kept if
    // the caller keeps this attempt.
    async verifyPatch(f, beforeTree, afterTree, number) {
      const probe = selectProbe(f, config);
      const ctx = { config, upstream, mock, workDir: workRoot };
      const tag = `${number}-${Date.now()}`;
      log.step(`[${number}] ${f.ruleId} @ ${f.file}:${f.line}${probe ? ` - probe "${probe.title}"` : ' - static check only'}`);
      const before = probe ? await runProbe(probe, { ...ctx, dir: dirFor(beforeTree), label: `${tag}-before` }) : null;
      if (before) log.dim(`    before: ${before.error ? `error (${before.error})` : before.skipped ? `skipped (${before.skipped})` : before.passed ? 'passed (bug not reproduced)' : 'failed - bug reproduced'}`);
      const afterDir = dirFor(afterTree);
      const after = probe ? await runProbe(probe, { ...ctx, dir: afterDir, label: `${tag}-after` }) : null;
      if (after) log.dim(`    after:  ${after.error ? `error (${after.error})` : after.skipped ? `skipped (${after.skipped})` : after.passed ? 'passed' : 'FAILED'}`);
      const staticCleared = !scanStatic(afterDir).findings.some((x) => x.key === f.key);
      const status = classify(before, after, staticCleared);
      const strip = (r) => (r ? { ...r, traffic: undefined, requests: r.traffic.length } : null);
      const line = { verified: log.ok, fixed: log.ok, 'static-only': log.ok, skipped: log.warn, error: log.warn, failed: log.error }[status] || log.info;
      line(`    → ${status}${staticCleared ? '' : ' (static detector still reports it)'}`);
      return {
        verification: { status, mode, probe: probe?.id || null, probeTitle: probe?.title || null, before: strip(before), after: strip(after), staticCleared, at: new Date().toISOString() },
        traffic: {
          before: before ? before.traffic.map((e) => ({ ...e, phase: 'before', probe: probe.id })) : [],
          after: after ? after.traffic.map((e) => ({ ...e, phase: 'after', probe: probe.id })) : [],
        },
      };
    },

    keepTraffic(f, t) {
      pushTraffic(t.before, { findingId: f.id });
      pushTraffic(t.after, { findingId: f.id });
    },

    // Every probe once more on the fully patched app.
    async regression(findings) {
      const finalTree = treeAfter(root, findings);
      const finalDir = dirFor(finalTree);
      const probeIds = [...new Set(findings.map((f) => selectProbe(f, config)?.id).filter(Boolean))];
      log.step(`Regression pass: ${probeIds.length} probe(s) on the fully patched app`);
      const results = [];
      for (const id of probeIds) {
        const probe = { id, ...PROBES[id], missing: PROBES[id].routes.filter((r) => !config.routes?.[r]) };
        const res = await runProbe(probe, { config, upstream, mock, workDir: workRoot, dir: finalDir, label: `final-${id}` });
        pushTraffic(res.traffic, { findingId: null, phase: 'final', probe: id });
        results.push({ ...res, traffic: undefined, requests: res.traffic.length });
        (res.passed ? log.ok : res.skipped ? log.warn : log.error)(`  ${res.passed ? '✓' : res.skipped ? '–' : '✗'} ${probe.title}${res.skipped ? ` (skipped: ${res.skipped})` : ''}`);
      }
      const remaining = scanStatic(finalDir).findings;
      return {
        probes: results,
        allPassed: results.every((r) => r.passed || r.skipped) && results.some((r) => r.passed),
        remainingFindings: remaining.map((f) => ({ ruleId: f.ruleId, file: f.file, line: f.line, message: f.message })),
        patchedFiles: [...finalTree.overrides.keys()],
      };
    },
  };
}

// Re-verify a chain that's already been written (paypal-doctor verify).
export async function verifyFindings({ root, report, mode = 'mock', keep = false, onFinding }) {
  const verifier = await createVerifier({ root, config: report.target.config, mode, keep });
  try {
    const patched = report.findings.filter((f) => f.fix?.status === 'ready').sort((a, b) => a.fix.chainIndex - b.fix.chainIndex);
    for (const f of patched) {
      const i = f.fix.chainIndex;
      const { verification, traffic } = await verifier.verifyPatch(f, treeAfter(root, report.findings, i - 1), treeAfter(root, report.findings, i), i);
      f.verification = verification;
      verifier.keepTraffic(f, traffic);
      onFinding?.(f);
    }
    const final = await verifier.regression(report.findings);
    return { traffic: verifier.traffic, final, upstream: verifier.upstream, workRoot: verifier.workRoot };
  } finally {
    await verifier.close();
  }
}
