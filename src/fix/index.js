// Turns findings into a chain of patches. Patch N is written against the code
// with patches 1..N-1 already applied, so each one can be verified on its own
// (before = chain so far, after = chain so far + this patch).
//
// With a verifier, each patch is proven as the chain is built. A patch that fails
// goes back to the model once with the probe's evidence. If it still fails it's left
// out, so it can't take every later patch down with it.
import fs from 'node:fs';
import path from 'node:path';
import { FIX_SYSTEM, FIX_SCHEMA, numbered } from '../prompts.js';
import { RULES_BY_ID } from '../rules.js';
import { VirtualTree, applyEdits, PatchError } from './patch.js';
import { listFiles, isTestFile } from '../scan/files.js';
import { log } from '../log.js';

// Fix order: environment/config first, then money math, then the payment
// calls, then the webhook. Keeps each later patch's context stable.
export const FIX_ORDER = [
  'deprecated-sdk', 'deprecated-v1-payments', 'hardcoded-environment', 'hardcoded-credentials',
  'client-supplied-amount', 'amount-formatting', 'missing-request-id', 'capture-status-unchecked', 'webhook-unverified',
];

const MAX_CONTEXT_FILES = 6;
const MAX_CONTEXT_BYTES = 60_000;
const KEPT = new Set(['verified', 'fixed', 'static-only', 'skipped']);

export function chainOrder(findings) {
  return [...findings].sort((a, b) =>
    (FIX_ORDER.indexOf(a.ruleId) - FIX_ORDER.indexOf(b.ruleId)) || a.file.localeCompare(b.file) || a.line - b.line);
}

function localImports(file, code, tree) {
  const out = [];
  for (const m of code.matchAll(/(?:from\s+|require\(\s*|import\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    const hit = [base, `${base}.js`, `${base}.ts`, `${base}.mjs`, `${base}.tsx`, `${base}/index.js`, `${base}/index.ts`].find((c) => tree.get(c) != null);
    if (hit) out.push(hit);
  }
  return out;
}

// The file with the bug, what it imports and what imports it. Without these the
// model has to guess at field names and helpers it can't see.
function contextFiles(finding, tree, repoFiles) {
  const primary = [...new Set([finding.file, ...finding.related.map((r) => r.file)])];
  const neighbours = new Set();
  for (const f of primary) {
    const code = tree.get(f);
    if (code != null) localImports(f, code, tree).forEach((x) => neighbours.add(x));
  }
  for (const f of repoFiles) {
    const code = tree.get(f);
    if (code != null && localImports(f, code, tree).some((x) => primary.includes(x))) neighbours.add(f);
  }
  const chosen = [...primary];
  let bytes = 0;
  for (const f of chosen) bytes += (tree.get(f) || '').length;
  for (const f of neighbours) {
    if (chosen.includes(f) || chosen.length >= MAX_CONTEXT_FILES) continue;
    const size = (tree.get(f) || '').length;
    if (bytes + size > MAX_CONTEXT_BYTES) continue;
    bytes += size;
    chosen.push(f);
  }
  return chosen;
}

function buildPrompt(finding, remaining, tree, config, repoFiles) {
  const rule = RULES_BY_ID[finding.ruleId];
  const env = config?.env || {};
  const routes = Object.entries(config?.routes || {}).map(([name, spec]) => `- ${name}: ${spec}`);
  const sampleCart = config?.carts?.standard?.body;
  const parts = [
    `Fix this finding.`,
    ``,
    `Rule: ${rule.id} - ${rule.title}`,
    `Location: ${finding.file}, in ${finding.symbol} (line ${finding.line} in the original file; earlier patches may have moved it)`,
    `What is wrong: ${finding.message}`,
    ``,
    `Configuration (env var names this app uses):`,
    `- PayPal API base URL: ${env.apiBase || 'PAYPAL_API_BASE'}`,
    `- client id: ${env.clientId || 'PAYPAL_CLIENT_ID'}, client secret: ${env.clientSecret || 'PAYPAL_CLIENT_SECRET'}`,
    `- webhook id: ${env.webhookId || 'PAYPAL_WEBHOOK_ID'}`,
    ``,
  ];
  if (routes.length) {
    parts.push(`How this app is called (these routes and request shapes must keep working):`, ...routes);
    if (sampleCart) parts.push(`- example createOrder request body: ${JSON.stringify(sampleCart)}`);
    parts.push(``);
  }
  if (remaining.length) {
    parts.push(`Other known issues, not fixed yet (NOT this patch - leave them as they are):`, ...remaining.map((o) => `- ${o.ruleId} in ${o.file} (${o.symbol})`), ``);
  }
  for (const f of contextFiles(finding, tree, repoFiles)) {
    parts.push(`Current contents of ${f} (line numbers are for reference only, do not include them in find/replace):`, '```', numbered(tree.get(f)), '```', '');
  }
  return parts.join('\n');
}

function failureEvidence(v) {
  const r = v.after;
  if (!r) return v.staticCleared ? 'The static check failed.' : 'After the patch, the static detector still reports this finding.';
  if (r.error) return `The app did not start: ${r.error}`;
  const failed = (r.checks || []).filter((c) => !c.passed && c.level === 'must');
  const lines = failed.map((c) => `- FAILED: ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  return lines.join('\n') || 'The probe did not pass.';
}

export async function generateFixes({ root, findings, llm, config, verifier, onFinding }) {
  let current = new VirtualTree((file) => {
    const abs = path.join(root, file);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  });
  const repoFiles = listFiles(root).filter((f) => !f.endsWith('package.json') && !isTestFile(f));
  const ordered = chainOrder(findings);
  let chainIndex = 0;

  for (const [position, finding] of ordered.entries()) {
    // Only what's still broken: naming what's already fixed just confuses the model.
    const remaining = ordered.slice(position + 1);
    const key = `fix|${finding.key}`;
    let prompt = buildPrompt(finding, remaining, current, config, repoFiles);
    const failedAttempts = [];
    let kept = null;
    let lastError = null;
    let lastTry = null;
    let kind = 'first';
    let retried = false;
    let repaired = false;

    for (let call = 1; call <= 4; call++) {
      const callKey = kind === 'first' ? key : `${key}|${kind}${retried && repaired && kind === 'retry' ? '2' : ''}`;
      let answer;
      try {
        answer = await llm.json({ key: callKey, system: FIX_SYSTEM, prompt, schema: FIX_SCHEMA });
      } catch (err) {
        lastError = err.message;
        break;
      }
      if (!answer) {
        // In replay, a missing retry or repair fixture means the last result stands.
        if (call === 1) lastError = llm.mode === 'replay' ? 'No recorded fix for this finding (replay mode, no ANTHROPIC_API_KEY).' : 'LLM is off.';
        break;
      }
      let applied;
      try {
        applied = applyEdits(current, answer.output.edits);
      } catch (err) {
        if (!(err instanceof PatchError)) throw err;
        lastError = err.message;
        if (retried && kind !== 'repair') break;
        retried = true;
        kind = 'retry';
        prompt += `\n\nYour previous patch could not be applied: ${err.message}\nReturn a corrected patch against the same current file contents.`;
        continue;
      }
      const candidate = { answer, applied };
      if (!verifier) {
        kept = candidate;
        break;
      }
      const { verification, traffic } = await verifier.verifyPatch(finding, current, applied.tree, chainIndex + 1);
      candidate.verification = verification;
      candidate.traffic = traffic;
      lastTry = candidate;
      if (KEPT.has(verification.status)) {
        kept = candidate;
        break;
      }
      failedAttempts.push({
        explanation: answer.output.explanation,
        files: applied.files.map((f) => ({ file: f.file, diff: f.diff })),
        status: verification.status,
        evidence: failureEvidence(verification),
      });
      if (repaired) break;
      repaired = true;
      kind = 'repair';
      log.warn(`    sending the probe's evidence back to the model`);
      prompt += `\n\nYour previous patch applied, but it failed verification when the app was run (it has NOT been kept):\n${failureEvidence(verification)}\n\nThe patch was:\n${JSON.stringify(answer.output.edits, null, 1)}\n\nReturn a corrected patch against the same current file contents.`;
    }

    const describe = (c) => ({
      explanation: c.answer.output.explanation,
      notes: c.answer.output.notes,
      edits: c.answer.output.edits,
      files: c.applied.files.map((f) => ({ file: f.file, diff: f.diff })),
      source: c.answer.from,
      handWritten: c.answer.handWritten,
      model: c.answer.model || llm.model,
      failedAttempts,
    });

    if (kept) {
      current = kept.applied.tree;
      chainIndex += 1;
      finding.fix = { status: 'ready', chainIndex, ...describe(kept) };
      if (kept.verification) {
        finding.verification = kept.verification;
        verifier.keepTraffic(finding, kept.traffic);
      }
      log.ok(`  ✓ patch ${chainIndex}: ${finding.ruleId} @ ${finding.file}:${finding.line}${kept.answer.handWritten ? ' (hand-written fixture)' : ''}${failedAttempts.length ? ` (repaired after ${failedAttempts.length} failed attempt)` : ''}`);
    } else if (lastTry) {
      finding.fix = { status: 'rejected', reason: `Failed verification, so it was left out of the chain. ${failureEvidence(lastTry.verification)}`, ...describe(lastTry) };
      finding.verification = lastTry.verification;
      verifier.keepTraffic(finding, lastTry.traffic);
      log.error(`  ✗ ${finding.ruleId} @ ${finding.file}:${finding.line} - failed verification, left out of the chain`);
    } else {
      finding.fix = { status: 'unavailable', reason: lastError, failedAttempts };
      log.warn(`  ✗ ${finding.ruleId} @ ${finding.file}:${finding.line} - ${lastError}`);
    }
    onFinding?.(finding);
  }
  return { findings, tree: current };
}

// Rebuild the patched tree for the first `upTo` patches in chain order.
export function treeAfter(root, findings, upTo = Infinity) {
  let tree = new VirtualTree((file) => {
    const abs = path.join(root, file);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  });
  const patched = findings.filter((f) => f.fix?.status === 'ready').sort((a, b) => a.fix.chainIndex - b.fix.chainIndex);
  for (const f of patched) {
    if (f.fix.chainIndex > upTo) break;
    tree = applyEdits(tree, f.fix.edits).tree;
  }
  return tree;
}
