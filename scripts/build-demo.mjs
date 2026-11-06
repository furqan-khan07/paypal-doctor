#!/usr/bin/env node
// Builds the read-only hosted demo into demo-site/: the dashboard, plus one recorded
// run. There is no backend, so nothing on that page can run anything.
//
// The report is copied field by field from a list of what the dashboard shows. Raw
// PayPal requests and responses, credential fingerprints and local paths are never
// copied, so a new field can't leak by accident. scripts/audit-demo.mjs checks the result.
//
//   npm run demo:build -- --report .doctor/runs/second-real-run/report.json --log .doctor/runs/second-real-run/last-run.log
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saidOf } from '../dashboard/public/said.js';
import { landingData, landingHtml } from '../dashboard/demo/landing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/furqan-khan07/paypal-doctor';

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

const checksOf = (r) => (r.checks || []).map((c) => pick(c, ['name', 'passed', 'detail', 'level']));
const proofOf = (r) => (r ? { ...pick(r, ['passed', 'skipped', 'error', 'notes', 'upstream', 'requests', 'title', 'probe']), checks: checksOf(r) } : null);

function findingOf(f) {
  const v = f.verification;
  const fix = f.fix;
  return {
    ...pick(f, ['id', 'ruleId', 'title', 'severity', 'file', 'line', 'symbol', 'message', 'source']),
    related: (f.related || []).map((r) => pick(r, ['file', 'line'])),
    snippet: (f.snippet || []).map((l) => pick(l, ['line', 'text'])),
    docs: (f.docs || []).map((d) => pick(d, ['label', 'url'])),
    llm: f.llm ? pick(f.llm, ['from', 'handWritten']) : undefined,
    fix: fix && {
      ...pick(fix, ['status', 'chainIndex', 'explanation', 'notes', 'source', 'handWritten', 'model', 'reason']),
      files: (fix.files || []).map((x) => pick(x, ['file', 'diff'])),
      failedAttempts: (fix.failedAttempts || []).map((a) => ({ ...pick(a, ['status', 'evidence']), files: (a.files || []).map((x) => pick(x, ['file', 'diff'])) })),
    },
    verification: v && { ...pick(v, ['status', 'mode', 'probe', 'probeTitle', 'staticCleared', 'at']), before: proofOf(v.before), after: proofOf(v.after) },
  };
}

function trafficOf(t) {
  const rid = t.requestHeaders?.['paypal-request-id'];
  return {
    ...pick(t, ['findingId', 'phase', 'upstream', 'actor', 'method', 'path', 'status', 'ms', 'debugId', 'faults']),
    said: saidOf(t),
    requestHeaders: rid ? { 'paypal-request-id': rid } : {},
  };
}

export function publicReport(report) {
  const { scan, fix, verify } = report;
  return {
    target: { name: report.target.name, root: 'demo-store' },
    updatedAt: report.updatedAt,
    scan: scan && { ...pick(scan, ['at', 'files', 'static']), llm: pick(scan.llm, ['mode', 'model', 'count']) },
    fix: fix && pick(fix, ['at', 'llmMode', 'model', 'ready', 'rejected', 'unavailable']),
    verify: verify && {
      ...pick(verify, ['at', 'mode', 'upstream', 'ms', 'counts']),
      final: {
        allPassed: verify.final.allPassed,
        probes: verify.final.probes.map(proofOf),
        remainingFindings: verify.final.remainingFindings.map((r) => pick(r, ['ruleId', 'file', 'line'])),
      },
    },
    findings: report.findings.map(findingOf),
    traffic: report.traffic.map(trafficOf),
  };
}

export function publicLog(raw, projectRoot = ROOT) {
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((l) => ({
    level: l.level,
    text: String(l.text).split(`${projectRoot}/`).join(''),
  }));
}

export function staticIndex(html, landing) {
  const swap = (from, to) => {
    if (!html.includes(from)) throw new Error(`index.html changed, can't find: ${from}`);
    html = html.replace(from, to);
  };
  swap('<html lang="en">', '<html lang="en" data-static="recording">');
  swap('<title>paypal-doctor</title>', `<title>paypal-doctor: finds PayPal bugs, writes the fix, proves it</title>
  <meta name="description" content="A read-only recording of paypal-doctor finding PayPal integration bugs in a demo shop, patching them with Claude, and proving each patch against the PayPal sandbox." />`);
  swap('<link rel="stylesheet" href="style.css" />', `<link rel="preload" href="vendor/fonts/besley-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin />
  <script src="theme-init.js"></script>
  <link rel="stylesheet" href="style.css" />
  <link rel="stylesheet" href="demo.css" />`);
  swap('src="/vendor/ag-grid-community.min.js"', 'src="vendor/ag-grid-community.min.js"');
  const start = html.indexOf('<header class="top">');
  const dashboard = html.indexOf('<section class="vitals"');
  const scripts = html.indexOf('<script src="app.js"');
  if (start < 0 || dashboard < 0 || scripts < 0) throw new Error("index.html changed, can't find the page's sections");
  // The dashboard's markup is reused as it is, under the story. The header and its run controls aren't.
  const grids = html.slice(dashboard, scripts).trimEnd().replace('<main class="split">', '<div class="split">').replace('</main>', '</div>');
  return `${html.slice(0, start)}${landing.top}

    <section class="evidence" id="evidence">
    ${landing.evidenceHead}
    ${grids}
    </section>
  ${landing.bottom}

  <script src="app.js" type="module"></script>
  <script src="demo.js" type="module"></script>
</body>
</html>
`;
}

const VERCEL_JSON = {
  framework: null,
  headers: [{
    source: '/(.*)',
    headers: [
      { key: 'Content-Security-Policy', value: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
    ],
  }],
};

function build({ reportPath, logPath, out }) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  // Only a real run gets published: this page says it's a recording of one.
  if (report.verify?.upstream !== 'sandbox') throw new Error('That report did not run against the sandbox.');
  if (report.findings.some((f) => f.llm?.handWritten || f.fix?.handWritten)) throw new Error('That report has hand-written Claude answers.');
  if (report.findings.some((f) => f.source === 'llm' && f.llm?.from === 'fixture') || report.findings.some((f) => f.fix?.source === 'fixture')) throw new Error('That report replayed Claude instead of calling it.');

  // Read before anything is written: if a number can't be backed up, there's no build.
  const docs = {
    realRuns: fs.readFileSync(path.join(ROOT, 'docs', 'real-runs.md'), 'utf8'),
    validation: fs.readFileSync(path.join(ROOT, 'docs', 'validation.md'), 'utf8'),
  };
  const landing = landingHtml(landingData(report, docs));

  const publicDir = path.join(ROOT, 'dashboard', 'public');
  const demoDir = path.join(ROOT, 'dashboard', 'demo');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'vendor', 'fonts'), { recursive: true });
  for (const f of ['app.js', 'said.js', 'style.css', 'favicon.svg']) fs.copyFileSync(path.join(publicDir, f), path.join(out, f));
  for (const f of ['demo.css', 'demo.js', 'theme-init.js']) fs.copyFileSync(path.join(demoDir, f), path.join(out, f));
  for (const f of fs.readdirSync(path.join(demoDir, 'fonts'))) fs.copyFileSync(path.join(demoDir, 'fonts', f), path.join(out, 'vendor', 'fonts', f));
  const grid = path.join(ROOT, 'node_modules', 'ag-grid-community');
  fs.copyFileSync(path.join(grid, 'dist', 'ag-grid-community.min.js'), path.join(out, 'vendor', 'ag-grid-community.min.js'));
  fs.copyFileSync(path.join(grid, 'LICENSE.txt'), path.join(out, 'vendor', 'AG-GRID-LICENSE.txt'));

  fs.writeFileSync(path.join(out, 'index.html'), staticIndex(fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'), landing));
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(publicReport(report)));
  fs.writeFileSync(path.join(out, 'log.json'), JSON.stringify(publicLog(fs.readFileSync(logPath, 'utf8'))));
  fs.writeFileSync(path.join(out, 'vercel.json'), `${JSON.stringify(VERCEL_JSON, null, 2)}\n`);
  // Vercel's own ignore list doesn't cover every .env file, so don't rely on it.
  fs.writeFileSync(path.join(out, '.vercelignore'), '.env*\n.vercel\n');
  console.log(`Wrote ${path.relative(ROOT, out)}/ from ${path.relative(ROOT, reportPath)}. Check it with: npm run demo:audit`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? path.resolve(process.argv[i + 1]) : fallback;
  };
  const run = path.join(ROOT, '.doctor', 'runs', 'second-real-run');
  build({ reportPath: arg('report', path.join(run, 'report.json')), logPath: arg('log', path.join(run, 'last-run.log')), out: arg('out', path.join(ROOT, 'demo-site')) });
}
