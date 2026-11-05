// Reproduces the repo selection and static scan behind docs/validation.md.
//
//   node scripts/validate-public.mjs <scratch-folder> [--limit 60]
//
// Needs `gh` signed in. Clones are sparse (source files only), hooks are off and
// nothing in them is executed: the scan only parses them. Keep the scratch folder
// outside this repo. Writes one JSON report per repo, plus _summary.json.
// Triage is still by hand: this tells you what the scan says, not whether it's right.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanStatic } from '../src/scan/index.js';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--'));
const limitAt = args.indexOf('--limit');
const limit = limitAt === -1 ? 60 : Number(args[limitAt + 1]);
if (!out) {
  console.error('usage: node scripts/validate-public.mjs <scratch-folder> [--limit 60]');
  process.exit(2);
}

const QUERIES = [
  '"/v2/checkout/orders" language:TypeScript',
  '"/v2/checkout/orders" language:JavaScript',
  '"verify-webhook-signature" language:TypeScript',
  '"verify-webhook-signature" language:JavaScript',
  'purchase_units language:TypeScript',
  'purchase_units language:JavaScript',
  '"paypal-server-sdk" language:TypeScript',
  '"paypal-rest-sdk" language:JavaScript',
  '"checkout-server-sdk" language:JavaScript',
];

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, ...opts }).trim();
const git = (argv) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...argv], { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(out, { recursive: true });
const clones = path.join(out, 'clones');
const reports = path.join(out, 'reports');
fs.mkdirSync(clones, { recursive: true });
fs.mkdirSync(reports, { recursive: true });

console.log('Searching GitHub...');
const found = new Set();
for (const q of QUERIES) {
  const names = run('gh', ['search', 'code', q, '--limit', '100', '--json', 'repository', '--jq', '.[].repository.nameWithOwner']);
  names.split('\n').filter(Boolean).forEach((n) => found.add(n));
  await sleep(7000); // code search rate limit
}
console.log(`${found.size} repos found. Reading stars...`);

const meta = [];
for (const name of found) {
  try {
    const m = JSON.parse(run('gh', ['api', `repos/${name}`, '--jq', '{name: .full_name, stars: .stargazers_count, fork: .fork, archived: .archived}']));
    if (!m.fork && !m.archived) meta.push(m);
  } catch {
    // renamed or deleted since the search
  }
}
meta.sort((a, b) => b.stars - a.stars);
const selected = meta.slice(0, limit);

const summary = [];
for (const { name, stars } of selected) {
  const dir = path.join(clones, name.replace('/', '__'));
  try {
    if (!fs.existsSync(dir)) {
      git(['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', `https://github.com/${name}.git`, dir]);
      git(['-C', dir, 'sparse-checkout', 'set', '--no-cone', '*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.tsx', '*.mts', '*.cts', 'package.json']);
      git(['-C', dir, 'checkout', '-q']);
    }
    const sha = git(['-C', dir, 'rev-parse', 'HEAD']);
    const r = scanStatic(dir);
    const report = { repo: name, stars, sha, files: r.files.length, parseErrors: r.parseErrors.length, findings: r.findings };
    fs.writeFileSync(path.join(reports, `${name.replace('/', '__')}.json`), JSON.stringify(report, null, 1));
    summary.push({ repo: name, stars, sha, files: report.files, parseErrors: report.parseErrors, findings: report.findings.length });
    console.log(`${name.padEnd(50)} ${String(report.files).padStart(6)} files ${String(report.findings.length).padStart(4)} findings`);
  } catch (err) {
    summary.push({ repo: name, error: String(err.message).split('\n')[0] });
    console.log(`${name.padEnd(50)} failed: ${String(err.message).split('\n')[0].slice(0, 80)}`);
  }
}
fs.writeFileSync(path.join(reports, '_summary.json'), JSON.stringify(summary, null, 1));
console.log(`\nReports in ${reports}. Check the findings by hand before believing any of them.`);
