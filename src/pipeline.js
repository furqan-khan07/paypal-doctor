// scan -> fix -> verify, shared by the CLI and the dashboard.
import path from 'node:path';
import { scanStatic, sortFindings } from './scan/index.js';
import { scanWithLLM } from './scan/llm-scan.js';
import { generateFixes } from './fix/index.js';
import { verifyFindings } from './verify/index.js';
import { createLLM } from './llm/client.js';
import { loadTargetConfig, writeReport, readReport } from './report.js';
import { log } from './log.js';

export function newReport(root) {
  const config = loadTargetConfig(root);
  return {
    version: 1,
    target: { name: config.name, root: path.resolve(root), config },
    createdAt: new Date().toISOString(),
    findings: [],
    traffic: [],
  };
}

export async function runScan({ root, llmMode = 'auto', report = newReport(root) }) {
  log.step(`Scanning ${report.target.root}`);
  const { files, parseErrors, findings } = scanStatic(root);
  log.info(`  ${files.length} files, ${findings.length} static finding(s)${parseErrors.length ? `, ${parseErrors.length} file(s) failed to parse` : ''}`);
  const llm = createLLM({ mode: llmMode, target: report.target.name });
  let llmResult = { findings: [], rejected: [], skipped: true };
  if (llm.mode !== 'off') {
    log.step(`LLM review pass (${llm.mode === 'replay' ? 'replaying recorded output' : `${llm.model}, ${llm.mode}`})`);
    try {
      llmResult = await scanWithLLM({ root, files, staticFindings: findings, llm });
      if (llmResult.skipped) log.warn('  no recorded LLM review for this target - skipped (add ANTHROPIC_API_KEY to run it live)');
      else log.info(`  ${llmResult.findings.length} extra finding(s), ${llmResult.rejected.length} rejected by validation`);
    } catch (err) {
      log.warn(`  LLM pass failed: ${err.message}`);
      llmResult = { findings: [], rejected: [], error: err.message };
    }
  }
  report.findings = sortFindings([...findings, ...llmResult.findings]);
  report.traffic = [];
  report.scan = {
    at: new Date().toISOString(),
    files: files.length,
    parseErrors,
    static: findings.length,
    llm: { mode: llm.mode, model: llm.model, count: llmResult.findings.length, rejected: llmResult.rejected, skipped: !!llmResult.skipped, error: llmResult.error || null },
  };
  delete report.fix;
  delete report.verify;
  for (const f of report.findings) log.info(`  ${sevIcon(f.severity)} ${f.ruleId.padEnd(25)} ${`${f.file}:${f.line}`.padEnd(18)} ${f.source === 'llm' ? '(LLM)' : ''}`);
  writeReport(report);
  return report;
}

export async function runFix({ root, report, llmMode = 'auto' }) {
  const llm = createLLM({ mode: llmMode, target: report.target.name });
  log.step(`Writing patches (${llm.mode === 'replay' ? 'replaying recorded patches' : `${llm.model}, ${llm.mode}`})`);
  for (const f of report.findings) delete f.verification;
  await generateFixes({ root, findings: report.findings, llm, config: report.target.config });
  const ready = report.findings.filter((f) => f.fix?.status === 'ready').length;
  report.fix = { at: new Date().toISOString(), llmMode: llm.mode, model: llm.model, ready, unavailable: report.findings.length - ready, usage: llm.usage };
  delete report.verify;
  report.traffic = [];
  writeReport(report);
  return report;
}

export async function runVerify({ root, report, mode = 'mock', keep = false }) {
  log.step(`Verifying ${report.findings.filter((f) => f.fix?.status === 'ready').length} patch(es) against ${mode === 'sandbox' ? 'the PayPal sandbox' : 'the local PayPal mock'}`);
  const started = Date.now();
  const { traffic, final, upstream, workRoot } = await verifyFindings({ root, report, mode, keep });
  const counts = {};
  for (const f of report.findings) {
    const s = f.verification?.status || (f.fix?.status === 'ready' ? 'not-run' : 'no-patch');
    counts[s] = (counts[s] || 0) + 1;
  }
  report.traffic = traffic;
  report.verify = { at: new Date().toISOString(), mode, upstream, ms: Date.now() - started, counts, final, workRoot };
  if (workRoot) log.info(`Kept the app copies and raw traces in ${workRoot}`);
  writeReport(report);
  log.step(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  log[final.allPassed ? 'ok' : 'warn'](`Regression pass on the fully patched app: ${final.probes.filter((p) => p.passed).length}/${final.probes.length} probes green${final.remainingFindings.length ? `, ${final.remainingFindings.length} static finding(s) left` : ', static scan clean'}`);
  return report;
}

export function loadOrScan(root) {
  const config = loadTargetConfig(root);
  return readReport(config.name);
}

const sevIcon = (s) => ({ critical: '‼', high: '!', medium: '·', low: ' ' })[s] || ' ';
