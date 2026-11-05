// Turns findings into a chain of patches. Patch N is written against the code
// with patches 1..N-1 already applied, so each one can be verified on its own
// (before = chain so far, after = chain so far + this patch).
import fs from 'node:fs';
import path from 'node:path';
import { FIX_SYSTEM, FIX_SCHEMA, numbered } from '../prompts.js';
import { RULES_BY_ID } from '../rules.js';
import { VirtualTree, applyEdits, PatchError } from './patch.js';
import { log } from '../log.js';

// Fix order: environment/config first, then money math, then the payment
// calls, then the webhook. Keeps each later patch's context stable.
export const FIX_ORDER = [
  'deprecated-sdk', 'deprecated-v1-payments', 'hardcoded-environment', 'hardcoded-credentials',
  'client-supplied-amount', 'amount-formatting', 'missing-request-id', 'capture-status-unchecked', 'webhook-unverified',
];

export function chainOrder(findings) {
  return [...findings].sort((a, b) =>
    (FIX_ORDER.indexOf(a.ruleId) - FIX_ORDER.indexOf(b.ruleId)) || a.file.localeCompare(b.file) || a.line - b.line);
}

function buildPrompt(finding, others, tree, config) {
  const rule = RULES_BY_ID[finding.ruleId];
  const files = [...new Set([finding.file, ...finding.related.map((r) => r.file)])];
  const env = config?.env || {};
  const parts = [
    `Fix this finding.`,
    ``,
    `Rule: ${rule.id} - ${rule.title}`,
    `Location: ${finding.file}:${finding.line} (in ${finding.symbol})`,
    `What is wrong: ${finding.message}`,
    finding.related.length ? `Related locations: ${finding.related.map((r) => `${r.file}:${r.line}`).join(', ')}` : null,
    ``,
    `Configuration (env var names this app uses):`,
    `- PayPal API base URL: ${env.apiBase || 'PAYPAL_API_BASE'}`,
    `- client id: ${env.clientId || 'PAYPAL_CLIENT_ID'}, client secret: ${env.clientSecret || 'PAYPAL_CLIENT_SECRET'}`,
    `- webhook id: ${env.webhookId || 'PAYPAL_WEBHOOK_ID'}`,
    ``,
    `Other known issues (NOT this patch - leave them as they are):`,
    ...others.map((o) => `- ${o.ruleId} at ${o.file}:${o.line}`),
    ``,
  ];
  for (const f of files) {
    const content = tree.get(f);
    if (content == null) continue;
    parts.push(`Current contents of ${f} (line numbers are for reference only, do not include them in find/replace):`, '```', numbered(content), '```', '');
  }
  return parts.filter((p) => p !== null).join('\n');
}

export async function generateFixes({ root, findings, llm, config, onFinding }) {
  const tree = new VirtualTree((file) => {
    const abs = path.join(root, file);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  });
  let current = tree;
  const ordered = chainOrder(findings);
  let chainIndex = 0;

  for (const finding of ordered) {
    const others = ordered.filter((o) => o !== finding);
    const key = `fix|${finding.key}`;
    let prompt = buildPrompt(finding, others, current, config);
    let result = null;
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      let answer;
      try {
        answer = await llm.json({ key: attempt === 1 ? key : `${key}|retry`, system: FIX_SYSTEM, prompt, schema: FIX_SCHEMA });
      } catch (err) {
        lastError = err.message;
        break;
      }
      if (!answer) {
        // In replay, a missing retry fixture means the first recorded patch's error stands.
        if (attempt === 1) lastError = llm.mode === 'replay' ? 'No recorded fix for this finding (replay mode, no ANTHROPIC_API_KEY).' : 'LLM is off.';
        break;
      }
      try {
        const applied = applyEdits(current, answer.output.edits);
        result = { answer, applied };
        break;
      } catch (err) {
        if (!(err instanceof PatchError)) throw err;
        lastError = err.message;
        prompt += `\n\nYour previous patch could not be applied: ${err.message}\nReturn a corrected patch against the same current file contents.`;
      }
    }

    if (!result) {
      finding.fix = { status: 'unavailable', reason: lastError };
      log.warn(`  ✗ ${finding.ruleId} @ ${finding.file}:${finding.line} - ${lastError}`);
      onFinding?.(finding);
      continue;
    }

    current = result.applied.tree;
    chainIndex += 1;
    finding.fix = {
      status: 'ready',
      chainIndex,
      explanation: result.answer.output.explanation,
      notes: result.answer.output.notes,
      edits: result.answer.output.edits,
      files: result.applied.files.map((f) => ({ file: f.file, diff: f.diff })),
      source: result.answer.from,
      handWritten: result.answer.handWritten,
      model: result.answer.model || llm.model,
    };
    log.ok(`  ✓ patch ${chainIndex}: ${finding.ruleId} @ ${finding.file}:${finding.line}${result.answer.handWritten ? ' (hand-written fixture)' : ''}`);
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
