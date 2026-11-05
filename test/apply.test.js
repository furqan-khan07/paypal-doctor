import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paypal-doctor-apply-'));
process.env.PAYPAL_DOCTOR_HOME = path.join(tmp, 'home');
process.env.NO_COLOR = '1';
const { runScan, runFixAndVerify } = await import('../src/pipeline.js');
const { applyAsCommits } = await import('../src/apply.js');
const { scanStatic } = await import('../src/scan/index.js');

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' }).trim();

test('apply --commits: one commit per verified patch, with proof, and a clean re-scan', { timeout: 120_000 }, async () => {
  const repo = path.join(tmp, 'shop');
  fs.cpSync('demo-store', repo, { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  fs.symlinkSync(path.resolve('node_modules'), path.join(repo, 'node_modules'), 'dir');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'shop');

  let report = await runScan({ root: repo, llmMode: 'replay' });
  report = await runFixAndVerify({ root: repo, report, llmMode: 'replay', mode: 'mock' });

  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
  const { commits, pr } = applyAsCommits(repo, report);
  assert.equal(commits.filter((c) => c.sha).length, 11);
  const log = git(repo, 'log', '--format=%s');
  assert.equal(log.split('\n').length, 12);
  assert.match(git(repo, 'log', '-1', '--format=%B'), /Before this patch \(bug reproduced\)/);
  assert.equal(scanStatic(repo).findings.length, 0, 'patched repo scans clean');
  assert.match(fs.readFileSync(pr, 'utf8'), /\| 11 \| Webhook trusted without signature verification/);
});
