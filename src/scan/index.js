import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listFiles, isTestFile, isClientFile } from './files.js';
import { parseSource, linesAround, enclosingFunction, functionName } from './ast.js';
import { RepoIndex, ancestorsOf } from './flow.js';
import { RULES_BY_ID, SEVERITY_ORDER } from '../rules.js';
import { detectDeprecated, detectDeprecatedPackageJson } from './detectors/deprecated.js';
import { detectWebhook } from './detectors/webhook.js';
import { detectPayments } from './detectors/payments.js';
import { detectHardcoded } from './detectors/hardcoded.js';

const DETECTORS = [detectDeprecated, detectWebhook, detectPayments, detectHardcoded];

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

export function scanStatic(root) {
  const files = listFiles(root);
  const index = new RepoIndex();
  const parsed = [];
  const parseErrors = [];

  for (const file of files) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.endsWith('package.json')) {
      parsed.push({ file, code, ast: null });
      continue;
    }
    if (isTestFile(file)) continue;
    try {
      const ast = parseSource(code, file);
      index.addFile(file, ast, code);
      parsed.push({ file, code, ast });
    } catch (err) {
      parseErrors.push({ file, error: err.message });
    }
  }

  const raw = [];
  for (const { file, code, ast } of parsed) {
    const reportAtLocation = (ruleId, f, line, extra = {}) => {
      const fcode = f === file ? code : index.files.get(f)?.code || '';
      const fast = f === file ? ast : index.files.get(f)?.ast;
      raw.push({ ruleId, file: f, line, code: fcode, ast: fast, ...extra });
    };
    const ctx = {
      file, code, ast, index,
      isClient: isClientFile(file, code),
      paypalFile: /paypal/i.test(file) || /paypal/i.test(code),
      report: (ruleId, node, extra = {}) => reportAtLocation(ruleId, file, node.loc.start.line, { node, ...extra }),
      reportAt: (ruleId, line, extra = {}) => reportAtLocation(ruleId, file, line, extra),
      reportAtLocation,
    };
    if (!ast) {
      detectDeprecatedPackageJson(ctx);
      continue;
    }
    for (const detect of DETECTORS) detect(ctx);
  }

  return { files, parseErrors, findings: finalize(raw, 'static') };
}

// Dedupe, attach rule metadata, a snippet, a symbol and a stable id/key.
export function finalize(raw, source) {
  const seen = new Set();
  const ordinals = new Map();
  const out = [];
  for (const r of raw) {
    const dedupeKey = `${r.ruleId}|${r.file}|${r.line}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const rule = RULES_BY_ID[r.ruleId];
    let symbol = r.symbol;
    if (!symbol && r.ast) {
      const target = r.node || nodeAtLine(r.ast, r.line);
      if (target) {
        const anc = ancestorsOf(r.ast, target);
        symbol = functionName(enclosingFunction(anc), anc);
      }
    }
    symbol = symbol || '(top level)';
    const base = `${r.ruleId}|${r.file}|${symbol}`;
    const n = (ordinals.get(base) || 0) + 1;
    ordinals.set(base, n);
    const key = `${base}|${n}`;
    out.push({
      id: `F-${hash(key)}`,
      key,
      ruleId: r.ruleId,
      title: rule.title,
      severity: rule.severity,
      file: r.file,
      line: r.line,
      symbol,
      message: r.message,
      related: r.related || [],
      snippet: linesAround(r.code, r.line),
      source: r.source || source,
      confidence: r.confidence || 'high',
      docs: rule.docs,
      probe: rule.probe,
      ...(r.from ? { llm: { from: r.from, handWritten: !!r.handWritten } } : {}),
    });
  }
  return sortFindings(out);
}

export function sortFindings(list) {
  return list.sort((a, b) =>
    (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line);
}

function nodeAtLine(ast, line) {
  let best = null;
  const visit = (node) => {
    if (!node || typeof node.type !== 'string' || !node.loc) return;
    if (node.loc.start.line === line && (!best || node.end - node.start > best.end - best.start) && node.type !== 'Program') {
      if (node.type.endsWith('Statement') || node.type.endsWith('Declaration') || node.type === 'ObjectProperty') best = node;
    }
    if (node.loc.start.line > line || node.loc.end.line < line) return;
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(ast.program || ast);
  return best;
}
