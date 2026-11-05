#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runScan, runFix, runVerify, loadOrScan } from '../src/pipeline.js';
import { loadSecrets, hasPayPalKeys, hasAnthropicKey } from '../src/env.js';
import { log, color, onLog } from '../src/log.js';
import { DOCTOR_DIR } from '../src/report.js';

const HELP = `paypal-doctor - find PayPal integration bugs, patch them, prove the patch in the sandbox

Usage
  paypal-doctor run <dir> [--mode mock|sandbox] [--llm auto|live|replay|record|off] [--dashboard]
  paypal-doctor scan <dir> [--llm ...]       find issues (static detectors + LLM review)
  paypal-doctor fix <dir> [--llm ...]        write a patch per finding (needs a scan)
  paypal-doctor verify <dir> [--mode ...]    run each patch's probe before/after (needs fixes)
  paypal-doctor apply <dir> --yes [--commits] write the patches into <dir> (or one git commit per verified patch)
  paypal-doctor dashboard [--port 4417]      findings dashboard (AG Grid)
  paypal-doctor mock [--port 4455]           run the local PayPal mock on its own
  paypal-doctor status                       which keys are configured (never prints them)
  paypal-doctor preflight                    check the sandbox app can do what the probes need

Modes
  --mode mock      (default) probes talk to a local PayPal mock; no keys needed
  --mode sandbox   probes talk to api-m.sandbox.paypal.com with PAYPAL_CLIENT_ID/SECRET from .env
  --llm auto       (default) live Claude calls if ANTHROPIC_API_KEY is set, else recorded fixtures
  --llm record     live calls, and save the responses as fixtures for replay
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function needDir(args) {
  const dir = args._[1];
  if (!dir) {
    log.error('Which directory? e.g. paypal-doctor run demo-store');
    process.exit(2);
  }
  if (!fs.existsSync(dir)) {
    log.error(`No such directory: ${dir}`);
    process.exit(2);
  }
  return dir;
}

function needReport(dir, stage) {
  const report = loadOrScan(dir);
  if (!report) {
    log.error(`No report for ${dir} yet - run \`paypal-doctor scan ${dir}\` first.`);
    process.exit(2);
  }
  if (stage === 'verify' && !report.fix) {
    log.error(`No patches yet - run \`paypal-doctor fix ${dir}\` first.`);
    process.exit(2);
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const mode = args.mode || 'mock';
  if (!['mock', 'sandbox'].includes(mode)) throw new Error(`--mode must be mock or sandbox, got ${mode}`);
  const llmMode = args.llm || 'auto';

  // The log of the last full run, already redacted. The video kit replays it.
  if (cmd === 'run') {
    const logFile = path.join(DOCTOR_DIR, 'last-run.log');
    fs.mkdirSync(DOCTOR_DIR, { recursive: true });
    fs.writeFileSync(logFile, '');
    onLog((line) => fs.appendFileSync(logFile, `${JSON.stringify({ level: line.level, text: line.text })}\n`));
  }

  switch (cmd) {
    case 'scan': {
      await runScan({ root: needDir(args), llmMode });
      break;
    }
    case 'fix': {
      const dir = needDir(args);
      await runFix({ root: dir, report: needReport(dir, 'fix'), llmMode });
      break;
    }
    case 'verify': {
      const dir = needDir(args);
      await runVerify({ root: dir, report: needReport(dir, 'verify'), mode, keep: !!args.keep });
      break;
    }
    case 'run': {
      const dir = needDir(args);
      let report = await runScan({ root: dir, llmMode });
      report = await runFix({ root: dir, report, llmMode });
      report = await runVerify({ root: dir, report, mode, keep: !!args.keep });
      if (args.dashboard) {
        const { startDashboard } = await import('../dashboard/server.js');
        await startDashboard({ port: Number(args.port) || 4417 });
      }
      break;
    }
    case 'apply': {
      const dir = needDir(args);
      const report = needReport(dir, 'verify');
      const { applyFiles, applyAsCommits } = await import('../src/apply.js');
      const n = report.findings.filter((f) => f.fix?.status === 'ready').length;
      if (!args.yes) {
        log.info(`This writes ${n} patch(es) into ${path.resolve(dir)}${args.commits ? ', one git commit per verified patch' : ''}. Re-run with --yes to do it.`);
        break;
      }
      if (args.commits) {
        const { commits, pr } = applyAsCommits(dir, report, { includeUnverified: !!args['include-unverified'] });
        for (const c of commits) {
          const where = `${c.finding.ruleId} @ ${c.finding.file}:${c.finding.line}`;
          if (c.sha) log.ok(`  ${c.sha} ${where}`);
          else log.warn(`  skipped ${where} (${c.skipped})`);
        }
        log.info(`Pull request description: ${pr}`);
      } else {
        const { files, pr } = applyFiles(dir, report);
        log.ok(`Patched ${files.length} file(s): ${files.join(', ')}`);
        log.info(`Pull request description: ${pr}`);
      }
      break;
    }
    case 'dashboard': {
      const { startDashboard } = await import('../dashboard/server.js');
      await startDashboard({ port: Number(args.port) || 4417 });
      break;
    }
    case 'mock': {
      const { createMockPayPal } = await import('../src/mock-paypal/server.js');
      const mock = createMockPayPal({ quiet: false });
      const url = await mock.start(Number(args.port) || 4455);
      log.ok(`Mock PayPal API at ${url} (point PAYPAL_API_BASE at it). Ctrl+C to stop.`);
      break;
    }
    case 'preflight': {
      const { preflight } = await import('../src/preflight.js');
      if (!(await preflight())) process.exitCode = 1;
      break;
    }
    case 'status': {
      const s = loadSecrets();
      const row = (k, v) => log.info(`  ${k.padEnd(22)} ${v ? color.green('set') : color.yellow('empty')}`);
      log.step('Keys (.env or environment)');
      row('PAYPAL_CLIENT_ID', s.paypalClientId);
      row('PAYPAL_CLIENT_SECRET', s.paypalClientSecret);
      row('PAYPAL_WEBHOOK_ID', s.paypalWebhookId);
      row('ANTHROPIC_API_KEY', s.anthropicApiKey);
      log.info(`\n  sandbox verification: ${hasPayPalKeys(s) ? 'ready' : 'needs PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET'}`);
      log.info(`  live LLM:             ${hasAnthropicKey(s) ? 'ready' : 'needs ANTHROPIC_API_KEY (recorded fixtures are used meanwhile)'}`);
      break;
    }
    default:
      process.stdout.write(HELP);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 2;
  }
}

main().catch((err) => {
  log.error(`paypal-doctor: ${err.message}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
