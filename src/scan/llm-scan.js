// Second pass: hand the PayPal-relevant files to Claude along with what the
// static detectors already found, and keep only findings we can validate
// (known rule, real file, real line, evidence actually on that line).
import fs from 'node:fs';
import path from 'node:path';
import { SCAN_SYSTEM, SCAN_SCHEMA, numbered } from '../prompts.js';
import { RULES_BY_ID } from '../rules.js';
import { finalize } from './index.js';
import { parseSource } from './ast.js';
import { isClientFile } from './files.js';

const RELEVANT = /paypal|\/v[12]\/(checkout|payments|notifications)|purchase_units|webhook|PAYMENT\.CAPTURE/i;
const MAX_CHARS = 120_000;

export async function scanWithLLM({ root, files, staticFindings, llm }) {
  const picked = [];
  let budget = MAX_CHARS;
  for (const file of files) {
    if (file.endsWith('package.json')) continue;
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    if (!RELEVANT.test(code) || isClientFile(file, code)) continue;
    if (code.length > budget) continue;
    budget -= code.length;
    picked.push({ file, code });
  }
  if (picked.length === 0) return { findings: [], rejected: [], files: [] };

  const prompt = [
    'Static findings already reported (do not repeat):',
    ...staticFindings.map((f) => `- ${f.ruleId} at ${f.file}:${f.line} - ${f.message}`),
    '',
    ...picked.flatMap(({ file, code }) => [`File: ${file}`, '```', numbered(code), '```', '']),
  ].join('\n');

  const answer = await llm.json({ key: 'scan', system: SCAN_SYSTEM, prompt, schema: SCAN_SCHEMA, effort: 'high' });
  if (!answer) return { findings: [], rejected: [], files: picked.map((p) => p.file), skipped: true };

  const raw = [];
  const rejected = [];
  for (const f of answer.output.findings || []) {
    const src = picked.find((p) => p.file === f.file);
    const lines = src?.code.split('\n') || [];
    const lineText = lines[f.line - 1] || '';
    const near = lines.slice(Math.max(0, f.line - 3), f.line + 2).join('\n');
    if (!RULES_BY_ID[f.ruleId]) rejected.push({ ...f, why: 'unknown rule' });
    else if (!src) rejected.push({ ...f, why: 'file was not part of the review' });
    else if (!f.evidence || !near.includes(f.evidence.trim())) rejected.push({ ...f, why: 'evidence not found near that line' });
    else if (staticFindings.some((s) => s.ruleId === f.ruleId && s.file === f.file && Math.abs(s.line - f.line) <= 3)) rejected.push({ ...f, why: 'duplicate of a static finding' });
    else {
      const ev = f.evidence.trim();
      let line = f.line;
      if (!lineText.includes(ev)) line = [f.line - 1, f.line + 1, f.line - 2, f.line + 2].find((n) => (lines[n - 1] || '').includes(ev)) ?? f.line;
      raw.push({ ruleId: f.ruleId, file: f.file, line, message: f.message, code: src.code, ast: parseSource(src.code, f.file), source: 'llm', confidence: f.confidence, from: answer.from, handWritten: answer.handWritten });
    }
  }
  const findings = finalize(raw, 'llm');
  return { findings, rejected, files: picked.map((p) => p.file) };
}
