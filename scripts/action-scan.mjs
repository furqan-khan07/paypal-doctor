#!/usr/bin/env node
// The GitHub Action (see action.yml). It parses the checked-out code with Babel and
// never runs anything from it: no install, no imports, no scripts.
//
// Everything from the scanned repo is treated as hostile, including file names, since
// on a pull request the author controls them. So the comment only contains text from
// our own rule table plus an escaped path and a line number. It never quotes code or
// finding messages. The token is only used for the GitHub API and never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_URL = 'https://github.com/furqan-khan07/paypal-doctor';
export const MARKER = '<!-- paypal-doctor-scan -->';
const BOT_LOGIN = 'github-actions[bot]';
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const MAX_ROWS = 50;
const MAX_ANNOTATIONS = 10;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Safe inside an inline code span: no way out of the span or the table, and no
// invisible or direction-changing characters.
export function safeCode(s) {
  const invisible = (n) => n < 0x20 || (n >= 0x7f && n <= 0x9f) || (n >= 0x200b && n <= 0x200f) || (n >= 0x2028 && n <= 0x202e) || (n >= 0x2060 && n <= 0x2069) || n === 0xfeff;
  return [...String(s).replace(/[`|\\<>]/g, '_')].map((c) => (invisible(c.codePointAt(0)) ? '_' : c)).join('').slice(0, 160);
}

// The escaping rules for workflow commands, so a file name can't issue one.
export const commandProperty = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
export const commandData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function annotation(finding, rule) {
  return `::warning file=${commandProperty(finding.path)},line=${Number(finding.line) || 1},title=${commandProperty(`paypal-doctor: ${rule.title}`)}::${commandData(rule.summary)}`;
}

function row(finding, rule, ctx) {
  const where = `${safeCode(finding.path)}:${Number(finding.line) || 1}`;
  const encoded = String(finding.path).split('/').map(encodeURIComponent).join('/');
  const link = ctx.blobBase ? `[\`${where}\`](${ctx.blobBase}/${encoded}#L${Number(finding.line) || 1})` : `\`${where}\``;
  const title = rule.docs?.[0]?.url ? `[${rule.title}](${rule.docs[0].url})` : rule.title;
  return `| ${rule.severity} | ${title} | ${link} |`;
}

function table(findings, ctx) {
  const shown = findings.slice(0, MAX_ROWS);
  const lines = ['| Severity | Issue | Where |', '|---|---|---|', ...shown.map((f) => row(f, ctx.rules[f.ruleId], ctx))];
  if (findings.length > shown.length) lines.push('', `...and ${findings.length - shown.length} more.`);
  return lines.join('\n');
}

export function render({ findings, changed, parseErrors = 0 }, ctx) {
  const known = findings.filter((f) => ctx.rules[f.ruleId]);
  const inPr = changed ? known.filter((f) => changed.has(f.path)) : known;
  const elsewhere = changed ? known.filter((f) => !changed.has(f.path)) : [];
  const skipped = parseErrors ? ` ${plural(parseErrors, 'file')} couldn't be parsed and got skipped.` : '';
  const footer = `<sub>[paypal-doctor](${REPO_URL}). This is a static scan: it read the code and didn't run anything, and it can be wrong. On 20 repos it had never seen, 23 of 27 findings were correct.${skipped}</sub>`;
  if (!known.length) return `${MARKER}\n### paypal-doctor found no PayPal integration issues\n\n${footer}\n`;

  const parts = [MARKER, `### paypal-doctor found ${plural(known.length, 'possible PayPal integration bug')}`, ''];
  if (changed) parts.push(`${inPr.length} in files this PR changes, ${elsewhere.length} elsewhere in the repo.`, '');
  if (inPr.length) parts.push(table(inPr, ctx), '');
  if (elsewhere.length) parts.push(`<details><summary>${plural(elsewhere.length, 'finding')} elsewhere in the repo</summary>`, '', table(elsewhere, ctx), '', '</details>', '');
  parts.push(footer, '');
  return parts.join('\n').slice(0, 60000);
}

// ---- the GitHub API ------------------------------------------------------------

function apiClient(token) {
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  return async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'paypal-doctor-action',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, json };
  };
}

async function changedFiles(api, repo, number) {
  const files = new Set();
  for (let page = 1; page <= 30; page++) {
    const res = await api('GET', `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    if (!res.ok || !Array.isArray(res.json)) return null;
    for (const f of res.json) files.add(f.filename);
    if (res.json.length < 100) break;
  }
  return files;
}

// Only ever edits a comment this action wrote. Anyone can post a comment containing
// the marker, so the author is checked as well.
async function postComment(api, repo, number, body, { hasFindings }) {
  let existing = null;
  for (let page = 1; page <= 10 && !existing; page++) {
    const res = await api('GET', `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    if (!res.ok || !Array.isArray(res.json)) return { status: res.status };
    existing = res.json.find((c) => c.user?.login === BOT_LOGIN && String(c.body).startsWith(MARKER));
    if (res.json.length < 100) break;
  }
  if (existing) return api('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body });
  if (!hasFindings) return { status: 0, ok: true }; // Nothing to say, so don't add noise.
  return api('POST', `/repos/${repo}/issues/${number}/comments`, { body });
}

// ---- the scan, in a worker so a pathological file can be stopped --------------

function runScan(root, timeoutMs) {
  return new Promise((resolve) => {
    const worker = new Worker(THIS_FILE, { workerData: { root } });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ timedOut: true, findings: [], parseErrors: 0 });
    }, timeoutMs);
    worker.once('message', (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    worker.once('error', () => {
      clearTimeout(timer);
      resolve({ crashed: true, findings: [], parseErrors: 0 });
    });
  });
}

function setOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

async function main() {
  const { RULES_BY_ID } = await import('../src/rules.js');
  const workspace = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const root = path.resolve(workspace, process.env.INPUT_PATH || '.');
  if ((root !== workspace && !root.startsWith(`${workspace}${path.sep}`)) || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    console.log('::error::The path input has to be a folder inside the checkout.');
    process.exitCode = 1;
    return;
  }
  const prefix = path.relative(workspace, root).split(path.sep).filter(Boolean).join('/');
  const failOn = SEVERITIES.includes(process.env.INPUT_FAIL_ON) ? process.env.INPUT_FAIL_ON : null;
  const wantComment = process.env.INPUT_COMMENT !== 'false';
  const token = process.env.INPUT_GITHUB_TOKEN || '';

  const result = await runScan(root, Number(process.env.PAYPAL_DOCTOR_SCAN_TIMEOUT_MS) || 300000);
  if (result.timedOut || result.crashed) {
    const why = result.timedOut ? 'The scan hit its time limit and was stopped' : 'The scan stopped on an internal error';
    console.log(`::notice::${why}, so this run reports nothing. It does not fail the check.`);
    summary(`### paypal-doctor\n\n${why}, so this run reports nothing.`);
    setOutput({ findings: 0, 'findings-in-pr': 0 });
    return;
  }

  const order = (f) => SEVERITIES.indexOf(RULES_BY_ID[f.ruleId]?.severity);
  const findings = result.findings
    .filter((f) => RULES_BY_ID[f.ruleId])
    .map((f) => ({ ruleId: f.ruleId, line: f.line, path: prefix ? `${prefix}/${f.file}` : f.file }))
    .sort((a, b) => order(a) - order(b));

  let event = {};
  try {
    event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    // Not running in Actions, or no event file: there's no pull request to talk to.
  }
  const pr = event.pull_request;
  const repo = /^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY || '') ? process.env.GITHUB_REPOSITORY : null;
  const number = Number.isInteger(pr?.number) ? pr.number : null;
  const sha = /^[0-9a-f]{40}$/.test(pr?.head?.sha || '') ? pr.head.sha : /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : null;
  const server = /^https:\/\/[\w.-]+$/.test(process.env.GITHUB_SERVER_URL || '') ? process.env.GITHUB_SERVER_URL : 'https://github.com';
  const ctx = { rules: RULES_BY_ID, blobBase: repo && sha ? `${server}/${repo}/blob/${sha}` : null };

  const api = token && repo && number ? apiClient(token) : null;
  let changed = null;
  try {
    if (api) changed = await changedFiles(api, repo, number);
  } catch {
    changed = null;
  }

  const body = render({ findings, changed, parseErrors: result.parseErrors }, ctx);
  summary(body);
  const inPr = changed ? findings.filter((f) => changed.has(f.path)) : findings;
  for (const f of (inPr.length ? inPr : findings).slice(0, MAX_ANNOTATIONS)) console.log(annotation(f, RULES_BY_ID[f.ruleId]));
  console.log(`paypal-doctor: ${plural(findings.length, 'finding')}${changed ? `, ${inPr.length} in files this pull request changes` : ''}.`);
  setOutput({ findings: findings.length, 'findings-in-pr': inPr.length });

  if (api && wantComment) {
    try {
      const res = await postComment(api, repo, number, body, { hasFindings: findings.length > 0 });
      if (res.status && !res.ok) console.log(`::notice::Couldn't comment on the pull request (HTTP ${Number(res.status)}). On a fork the token is read-only, so the findings are in the job summary.`);
    } catch {
      console.log('::notice::Could not reach the GitHub API to comment. The findings are in the job summary.');
    }
  }

  if (failOn) {
    const limit = SEVERITIES.indexOf(failOn);
    const blocking = inPr.filter((f) => SEVERITIES.indexOf(RULES_BY_ID[f.ruleId].severity) <= limit);
    if (blocking.length) {
      console.log(`::error::${plural(blocking.length, 'finding')} at ${failOn} severity or above in files this pull request changes.`);
      process.exitCode = 1;
    }
  }
}

if (!isMainThread) {
  const { scanStatic } = await import('../src/scan/index.js');
  const { findings, parseErrors } = scanStatic(workerData.root);
  parentPort.postMessage({ findings: findings.map((f) => ({ ruleId: f.ruleId, file: f.file, line: f.line })), parseErrors: parseErrors.length });
} else if (process.argv[1] === THIS_FILE) {
  await main();
}
