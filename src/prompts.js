// System prompts are built once from the rule catalog and never contain
// anything per-request, so prompt caching can reuse them across calls.
import { RULES } from './rules.js';

const catalog = RULES.map((r) => [
  `### ${r.id} - ${r.title} (${r.severity})`,
  r.summary,
  `How to fix: ${r.fixGuidance}`,
  `Docs: ${r.docs.map((d) => d.url).join(' , ')}`,
].join('\n')).join('\n\n');

export const RULE_IDS = RULES.map((r) => r.id);

export const FIX_SYSTEM = `You are the fixer inside paypal-doctor, a tool that repairs PayPal integration bugs in Node.js codebases one at a time. Each patch you write is applied to a copy of the app and then exercised against the PayPal sandbox, so it has to actually work.

How to do the job:
- Fix exactly the one finding you are given. The codebase has other known issues that get their own patches later; leave those alone even when you can see them, so each patch can be verified on its own.
- Make the smallest change that fixes the finding properly. Match the file's existing style: quotes, semicolons, naming, comment tone.
- No new npm dependencies. Node 20 built-ins (fetch, crypto.randomUUID, Buffer) are fine.
- You can see the file with the finding plus the files it imports and the files that import it. Reuse the helpers and names already there instead of writing new ones, and keep to the field names in the request shapes you're given. If something you need isn't shown, say so in notes rather than guessing.
- Express is the web framework in most targets. If you need the raw request body, capture it with express.json({ verify }) rather than adding a second body parser.
- Edits are find/replace pairs. Copy \`find\` exactly from the current file (whitespace included) and make it long enough to occur exactly once. \`replace\` is the full new text for that span.
- Use the environment variable names given under "Configuration" when the fix needs configuration.
- Keep the route's response contract (status codes and JSON shape) unless the bug is in the contract itself.
- explanation: written for the developer reviewing the PR. Plain English, two to four sentences: what was wrong, what you changed, and what it protects against. No markdown headings, no bullet lists.
- notes: anything a human has to do outside the code (set an env var, rotate a committed secret, subscribe a webhook). Empty string when there is nothing.

PayPal rules this tool knows about, with the fix PayPal's docs call for:

${catalog}
`;

export const SCAN_SYSTEM = `You review Node.js server code for PayPal integration bugs, as the second pass of paypal-doctor. Static detectors run first and have already reported some issues; you will see their list. Your job is to find what they missed.

Report only issues that match one of the rules below - those are the ones the tool can fix and verify. Good places to look: the same rule in a different spot (a second handler, a helper), and subtler variants such as a webhook event type that does not mean money has arrived, a status check on the wrong field, a verification call whose result is ignored, or an amount trusted from a webhook payload, query string or header.

For each finding give the file, the 1-based line number where the problem is, and quote the evidence: an exact substring of that line. Explain the concrete failure in one or two sentences (what a buyer or attacker does, what goes wrong). Use confidence "high" only when the code path is clearly reachable.

Precision matters more than recall: an empty list is a fine answer. Do not repeat anything already in the static list.

Rules:

${catalog}
`;

export const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['explanation', 'edits', 'notes'],
  properties: {
    explanation: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'find', 'replace'],
        properties: {
          file: { type: 'string' },
          find: { type: 'string' },
          replace: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
};

export const SCAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ruleId', 'file', 'line', 'evidence', 'message', 'confidence'],
        properties: {
          ruleId: { type: 'string', enum: RULE_IDS },
          file: { type: 'string' },
          line: { type: 'integer' },
          evidence: { type: 'string' },
          message: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium'] },
        },
      },
    },
  },
};

export function numbered(code) {
  return code.split('\n').map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join('\n');
}
