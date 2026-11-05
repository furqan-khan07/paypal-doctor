// The GitHub Action, run as a real process against a fake GitHub API. The repo being
// scanned is treated as hostile here on purpose.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MARKER, safeCode, commandProperty, annotation, render } from '../scripts/action-scan.mjs';
import { RULES_BY_ID } from '../src/rules.js';

const run = promisify(execFile);
const SCRIPT = path.resolve('scripts/action-scan.mjs');
const TOKEN = 'not-a-real-token-value';
const SHA = 'a'.repeat(40);
const BUGGY = 'export const refund = () => fetch("https://api-m.paypal.com/v1/payments/capture/abc/refund", { method: "POST" });\n';

let server;
let apiUrl;
let state;

before(async () => {
  server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    state.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    const send = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.method === 'GET' && /\/pulls\/7\/files/.test(req.url)) return send(200, state.changed.map((filename) => ({ filename })));
    if (req.method === 'GET' && /\/issues\/7\/comments/.test(req.url)) return send(200, state.comments);
    return send(state.writeStatus, { id: 1 });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function action({ files, input = {}, changed = [], comments = [], writeStatus = 201, event }) {
  state = { calls: [], changed, comments, writeStatus };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paypal-doctor-action-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
    fs.writeFileSync(path.join(workspace, name), text);
  }
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(event ?? { pull_request: { number: 7, head: { sha: SHA } } }));
  const out = path.join(dir, 'output');
  const summary = path.join(dir, 'summary');
  const env = {
    PATH: process.env.PATH, GITHUB_WORKSPACE: workspace, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'owner/shop', GITHUB_API_URL: apiUrl, GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, INPUT_GITHUB_TOKEN: TOKEN, INPUT_COMMENT: 'true', INPUT_PATH: '.', INPUT_FAIL_ON: 'none',
    ...input,
  };
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const finish = (r) => ({ ...r, summary: read(summary), output: read(out), calls: state.calls, dir, workspace });
  try {
    const { stdout } = await run(process.execPath, [SCRIPT], { env, cwd: workspace });
    return finish({ code: 0, stdout });
  } catch (err) {
    return finish({ code: err.code, stdout: err.stdout || '' });
  }
}

const writes = (calls) => calls.filter((c) => c.method !== 'GET');

test('comments the findings, split by whether the PR touched the file', async () => {
  const r = await action({ files: { 'src/paypal.js': BUGGY, 'other/old.js': BUGGY }, changed: ['src/paypal.js'] });
  assert.equal(r.code, 0);
  const [post] = writes(r.calls);
  assert.equal(post.method, 'POST');
  assert.match(post.url, /\/repos\/owner\/shop\/issues\/7\/comments$/);
  assert.equal(post.auth, `Bearer ${TOKEN}`);
  const { body } = post.body;
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /2 in files this PR changes, 2 elsewhere/, 'the line has two bugs: a v1 call and a hardcoded host');
  assert.match(body, /\[`src\/paypal\.js:1`\]\(https:\/\/github\.com\/owner\/shop\/blob\/a{40}\/src\/paypal\.js#L1\)/);
  assert.match(body, /Deprecated v1 Payments API/);
  assert.match(r.summary, /Deprecated v1 Payments API/);
  assert.match(r.output, /findings=4/);
  assert.match(r.output, /findings-in-pr=2/);
  assert.match(r.stdout, /::warning file=src\/paypal\.js,line=1,/);
  assert.ok(!r.stdout.includes(TOKEN), 'the token never gets printed');
  assert.ok(!r.summary.includes(TOKEN));
});

test('updates its own comment, and ignores someone else using the marker', async () => {
  const comments = [
    { id: 11, user: { login: 'attacker' }, body: `${MARKER}\nfake` },
    { id: 22, user: { login: 'github-actions[bot]' }, body: `${MARKER}\nold` },
  ];
  const r = await action({ files: { 'paypal.js': BUGGY }, changed: ['paypal.js'], comments, writeStatus: 200 });
  const [write] = writes(r.calls);
  assert.equal(write.method, 'PATCH');
  assert.match(write.url, /\/issues\/comments\/22$/);
});

test('a fork, where the token is read-only: no failure, findings in the summary', async () => {
  const r = await action({ files: { 'paypal.js': BUGGY }, changed: ['paypal.js'], writeStatus: 403 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /::notice::Couldn't comment on the pull request \(HTTP 403\)/);
  assert.match(r.summary, /Deprecated v1 Payments API/);
});

test('hostile file names cannot break out of the comment or issue a workflow command', async () => {
  const evil = 'a`b|c@maintainer<img src=x>,d:e%f::set-output.js';
  const r = await action({ files: { [evil]: BUGGY }, changed: [evil] });
  const { body } = writes(r.calls)[0].body;
  assert.ok(!body.includes('<img'), 'no raw HTML');
  const cell = /\[`([^`]*)`\]/.exec(body)[1];
  assert.ok(!/[`|<>]/.test(cell), 'stays inside the code span and the table');
  assert.ok(body.includes('@maintainer') ? body.indexOf('@maintainer') > body.indexOf('[`') : true);
  const line = r.stdout.split('\n').find((l) => l.startsWith('::warning'));
  assert.ok(line.includes('a`b|c@maintainer<img src=x>%2Cd%3Ae%25f%3A%3Aset-output.js'), 'comma, colon and percent are escaped');
  assert.equal(line.indexOf('::', 2), line.lastIndexOf('::'), 'only one command in the line');
});

test('nothing from the repo runs, and symlinks are not followed', async () => {
  const marker = path.join(os.tmpdir(), `paypal-doctor-ran-${process.pid}`);
  const code = `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n${BUGGY}`;
  const secret = path.join(os.tmpdir(), `paypal-doctor-outside-${process.pid}.js`);
  fs.writeFileSync(secret, BUGGY);
  const dirA = await action({
    files: { 'paypal.js': code, 'package.json': JSON.stringify({ name: 'x', scripts: { preinstall: `touch ${marker}`, test: `touch ${marker}` } }) },
    changed: ['paypal.js'],
  });
  assert.equal(fs.existsSync(marker), false, 'the code in the repo did not run');
  assert.match(dirA.output, /findings=2/, 'it was still read');

  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paypal-doctor-link-'));
  fs.symlinkSync(secret, path.join(linkDir, 'leak.js'));
  const { scanStatic } = await import('../src/scan/index.js');
  assert.equal(scanStatic(linkDir).findings.length, 0, 'a symlink out of the repo is not read');
  fs.rmSync(secret);
});

test('stays quiet when clean, comment off means no writes, and bad paths are refused', async () => {
  const clean = await action({ files: { 'index.js': 'export const a = 1;\n' }, changed: ['index.js'] });
  assert.deepEqual(writes(clean.calls), [], 'no comment when there is nothing to say');
  assert.match(clean.output, /findings=0/);

  const off = await action({ files: { 'paypal.js': BUGGY }, changed: ['paypal.js'], input: { INPUT_COMMENT: 'false' } });
  assert.deepEqual(writes(off.calls), []);

  const outside = await action({ files: { 'paypal.js': BUGGY }, input: { INPUT_PATH: '../..' } });
  assert.equal(outside.code, 1);
  assert.match(outside.stdout, /has to be a folder inside the checkout/);
});

test('fail-on looks at files the PR changed, not the whole repo', async () => {
  const touched = await action({ files: { 'paypal.js': BUGGY }, changed: ['paypal.js'], input: { INPUT_FAIL_ON: 'high' } });
  assert.equal(touched.code, 1);
  const untouched = await action({ files: { 'paypal.js': BUGGY, 'ok.js': 'export const a = 1;\n' }, changed: ['ok.js'], input: { INPUT_FAIL_ON: 'high' } });
  assert.equal(untouched.code, 0);
});

test('outside a pull request it scans and summarises, and writes nothing to GitHub', async () => {
  const r = await action({ files: { 'paypal.js': BUGGY }, event: {} });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, []);
  assert.match(r.summary, /Deprecated v1 Payments API/);
});

test('the helpers on their own', () => {
  assert.equal(safeCode(`a\`|<>\\\nb${String.fromCodePoint(0x202e)}`), 'a______b_');
  assert.equal(commandProperty('a,b:c%d\ne'), 'a%2Cb%3Ac%25d%0Ae');
  const rule = RULES_BY_ID['deprecated-v1-payments'];
  assert.match(annotation({ path: 'x.js', line: '3; rm -rf' }, rule), /line=1,/, 'a line that is not a number becomes 1');
  const body = render({ findings: [{ ruleId: 'made-up', path: 'x.js', line: 1 }], changed: null }, { rules: RULES_BY_ID, blobBase: null });
  assert.match(body, /found no PayPal integration issues/, 'unknown rules are dropped');
  const many = Array.from({ length: 80 }, (_, i) => ({ ruleId: 'deprecated-v1-payments', path: `f${i}.js`, line: 1 }));
  assert.match(render({ findings: many, changed: null }, { rules: RULES_BY_ID, blobBase: null }), /and 30 more/);
});
