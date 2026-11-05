#!/usr/bin/env node
// Checks every byte of a build of the hosted demo before it's published, or after,
// on a copy downloaded from the live site. Prints file names, rule names and counts.
// It never prints a value it finds.
//
//   npm run demo:audit
//   node scripts/audit-demo.mjs path/to/downloaded/copy
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d > 4 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

// Applied to everything we wrote, including the dashboard's own code.
const EVERYWHERE = [
  ['home directory', /\/(?:Users|home)\/[A-Za-z0-9._-]+/g],
  ['temp path', /\/(?:private\/var|var\/folders|tmp)\/[A-Za-z0-9._-]+/g],
  ['local username', /furqan(?!-khan07)/gi],
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{6,}/g],
  ['PayPal access token', /A21AA[A-Za-z0-9_-]{10,}/g],
  ['credential fingerprint', /(?:credentials |token )?fp:[0-9a-f]{4,}/g],
  ['authorization value', /\b(?:Basic|Bearer) +[<A-Za-z0-9+/=_-]{6,}/g],
];
// Only for the recorded data. The fields are matched as JSON keys, because the demo
// shop's source code in the diffs is allowed to say `Authorization` or `webhook_id`.
const DATA_ONLY = [
  ['raw PayPal field', /\\?"(?:access_token|app_id|nonce|client_id|client_secret|webhook_id|merchant_id|payer_id|email_address|authorization|last_digits|responseBody|requestBody|originalUrl)\\?"\s*:/gi],
  ['local address', /\b(?:localhost|127\.0\.0\.1)\b/g],
  ['card number', /(?<![\d.])[3-6]\d{12,18}(?!\d)/g, luhn],
  ['webhook id', /\bWH-[A-Z0-9-]{10,}/g],
];
const SEEDED_FAKES = ['kiln-sandbox-secret-2024', 'kiln-sandbox-client'];
const THIRD_PARTY = /^vendor\//;
const DATA_FILES = new Set(['report.json', 'log.json']);

function envValues() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return [];
  const values = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (value.length >= 8) values.push([m[1], value]);
  }
  // The Basic auth form of the PayPal credentials too.
  const id = values.find(([k]) => k === 'PAYPAL_CLIENT_ID')?.[1];
  const secret = values.find(([k]) => k === 'PAYPAL_CLIENT_SECRET')?.[1];
  if (id && secret) values.push(['PayPal credentials, base64', Buffer.from(`${id}:${secret}`).toString('base64')]);
  return values;
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.vercel') continue; // Never uploaded: Vercel's local link file.
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

export function auditDir(dir, { secrets = envValues() } = {}) {
  const hits = [];
  const files = [];
  const fakes = {};
  for (const rel of walk(dir)) {
    const buf = fs.readFileSync(path.join(dir, rel));
    const text = buf.toString('utf8');
    files.push({ rel, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) });
    for (const [name, value] of secrets) if (text.includes(value)) hits.push({ rel, rule: `value of ${name}`, count: text.split(value).length - 1 });
    if (THIRD_PARTY.test(rel)) continue;
    const rules = DATA_FILES.has(rel) ? [...EVERYWHERE, ...DATA_ONLY] : EVERYWHERE;
    for (const [rule, re, keep] of rules) {
      const count = (text.match(re) || []).filter((m) => !keep || keep(m)).length;
      if (count) hits.push({ rel, rule, count });
    }
    for (const fake of SEEDED_FAKES) {
      const count = text.split(fake).length - 1;
      if (count) fakes[fake] = (fakes[fake] || 0) + count;
    }
  }
  return { files, hits, fakes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] || path.join(ROOT, 'demo-site'));
  const { files, hits, fakes } = auditDir(dir);
  console.log(`${files.length} files, ${files.reduce((n, f) => n + f.bytes, 0)} bytes in ${path.basename(dir)}/`);
  for (const f of files) console.log(`  ${f.sha256}  ${String(f.bytes).padStart(8)}  ${f.rel}`);
  const fakeLine = Object.entries(fakes).map(([k, v]) => `${k} x${v}`).join(', ');
  if (fakeLine) console.log(`Seeded fakes from the demo store, expected in its diffs: ${fakeLine}`);
  if (hits.length) {
    console.error(`\nAUDIT FAILED, ${hits.length} problem(s):`);
    for (const h of hits) console.error(`  ${h.rel}: ${h.rule} x${h.count}`);
    process.exit(1);
  }
  console.log('Audit clean.');
}
