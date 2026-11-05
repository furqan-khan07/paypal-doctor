// Turning a verified report into something a team can merge: either write
// the patched files, or one git commit per verified patch (proof in the
// message), plus a pull-request description.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { treeAfter } from './fix/index.js';
import { RULES_BY_ID } from './rules.js';
import { DOCTOR_DIR } from './report.js';

const OK = new Set(['verified', 'fixed', 'static-only']);

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const upstreamLabel = (v) => (v?.mode === 'sandbox' ? 'the PayPal sandbox' : 'a local PayPal mock');

function proofLines(f) {
  const v = f.verification;
  if (!v?.probe) return ['Proof: static re-scan no longer reports it.'];
  const failedBefore = (v.before?.checks || []).filter((c) => !c.passed && c.level === 'must');
  const after = v.after?.checks || [];
  return [
    `Proof: "${v.probeTitle}", run against ${upstreamLabel(v)}.`,
    `  Before this patch (bug reproduced):`,
    ...failedBefore.map((c) => `    x ${c.name}${c.detail ? ` (${c.detail})` : ''}`),
    `  After this patch:`,
    ...after.filter((c) => c.level === 'must').map((c) => `    ok ${c.name}`),
  ];
}

export function commitMessage(f) {
  const rule = RULES_BY_ID[f.ruleId];
  return [
    `fix(paypal): ${rule.title} (${f.file})`,
    '',
    f.fix.explanation,
    '',
    ...proofLines(f),
    '',
    ...(f.fix.notes ? [`Note: ${f.fix.notes}`, ''] : []),
    `Rule: ${f.ruleId} - ${rule.docs[0].url}`,
  ].join('\n');
}

export function pullRequestMarkdown(report) {
  const patched = report.findings.filter((f) => f.fix?.status === 'ready').sort((a, b) => a.fix.chainIndex - b.fix.chainIndex);
  const final = report.verify?.final;
  const lines = [
    `## PayPal integration fixes`,
    '',
    `paypal-doctor found ${report.findings.length} issue(s) in this codebase and wrote ${patched.length} patch(es). Each patch was checked with a scripted checkout against ${report.verify?.upstream === 'sandbox' ? 'the PayPal sandbox' : 'a local PayPal mock'}, before and after the change.`,
    '',
    '| # | Issue | Where | Before | After | Verdict |',
    '|---|---|---|---|---|---|',
    ...patched.map((f) => {
      const v = f.verification;
      const b = !v?.before ? '-' : v.before.passed ? 'not reproduced' : 'bug reproduced';
      const a = !v?.after ? (v?.status === 'static-only' ? 're-scan clean' : '-') : v.after.passed ? 'passes' : v.after.skipped ? 'skipped' : 'fails';
      return `| ${f.fix.chainIndex} | ${RULES_BY_ID[f.ruleId].title} | \`${f.file}:${f.line}\` | ${b} | ${a} | **${v?.status || 'not verified'}** |`;
    }),
    '',
  ];
  if (final) {
    lines.push(`With every patch applied, ${final.probes.filter((p) => p.passed).length}/${final.probes.length} probes pass and ${final.remainingFindings.length ? `${final.remainingFindings.length} finding(s) remain` : 'a re-scan finds nothing'}.`, '');
  }
  const leftOut = report.findings.filter((f) => f.fix?.status === 'rejected');
  if (leftOut.length) {
    lines.push('### Left out', '', 'These patches failed verification, so they are not in this change:', '', ...leftOut.map((f) => `- ${RULES_BY_ID[f.ruleId].title} (\`${f.file}:${f.line}\`)`), '');
  }
  const notes = patched.filter((f) => f.fix.notes);
  if (notes.length) {
    lines.push('### Before merging', '', ...notes.map((f) => `- ${f.fix.notes}`), '');
  }
  lines.push('### Details', '');
  for (const f of patched) {
    lines.push(`<details><summary>${f.fix.chainIndex}. ${RULES_BY_ID[f.ruleId].title} - ${f.file}:${f.line}</summary>`, '', f.fix.explanation, '', '```', ...proofLines(f), '```', '', `Docs: ${f.docs.map((d) => `[${d.label}](${d.url})`).join(', ')}`, '', '</details>', '');
  }
  return lines.join('\n');
}

export function writePullRequest(report) {
  const file = path.join(DOCTOR_DIR, report.target.name, 'PULL_REQUEST.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pullRequestMarkdown(report));
  return file;
}

// One commit per patch that passed verification, in chain order. Patches
// that failed or were skipped are left out (and so is anything after a
// left-out patch in the same file, because later patches were written on top
// of it).
export function applyAsCommits(root, report, { includeUnverified = false } = {}) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  const patched = report.findings.filter((f) => f.fix?.status === 'ready').sort((a, b) => a.fix.chainIndex - b.fix.chainIndex);
  const touched = [...new Set(patched.flatMap((f) => f.fix.files.map((x) => x.file)))];
  const dirty = git(root, ['status', '--porcelain', '--', ...touched]);
  if (dirty) throw new Error(`These files have uncommitted changes; commit or stash them first:\n${dirty}`);

  // Build every intermediate tree from the untouched files first; once the
  // first commit lands, the files on disk are no longer the chain's base.
  const trees = new Map(patched.map((f) => [f.fix.chainIndex, treeAfter(root, report.findings, f.fix.chainIndex)]));
  const commits = [];
  const blockedFiles = new Set();
  for (const f of patched) {
    const files = f.fix.files.map((x) => x.file);
    const ok = includeUnverified || OK.has(f.verification?.status);
    if (!ok || files.some((x) => blockedFiles.has(x))) {
      files.forEach((x) => blockedFiles.add(x));
      commits.push({ finding: f, skipped: ok ? 'an earlier patch to the same file was skipped' : `verification: ${f.verification?.status || 'not run'}` });
      continue;
    }
    const tree = trees.get(f.fix.chainIndex);
    for (const file of files) fs.writeFileSync(path.join(root, file), tree.get(file));
    git(root, ['add', '--', ...files]);
    const msgFile = path.join(DOCTOR_DIR, report.target.name, 'commit-msg.txt');
    fs.mkdirSync(path.dirname(msgFile), { recursive: true });
    fs.writeFileSync(msgFile, commitMessage(f));
    git(root, ['commit', '-q', '-F', msgFile, '--', ...files]);
    commits.push({ finding: f, sha: git(root, ['rev-parse', '--short', 'HEAD']) });
  }
  return { top, commits, pr: writePullRequest(report) };
}

export function applyFiles(root, report) {
  const tree = treeAfter(root, report.findings);
  for (const [file, content] of tree.overrides) {
    const abs = path.join(root, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { files: [...tree.overrides.keys()], pr: writePullRequest(report) };
}
