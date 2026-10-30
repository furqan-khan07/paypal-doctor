// Local dashboard: serves the AG Grid UI, the latest report, and can kick off
// scan / fix / verify runs, streaming the log over server-sent events.
// Binds to 127.0.0.1 only, and refuses cross-origin POSTs so a random web
// page can't make it run things.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestReport, readReport } from '../src/report.js';
import { runScan, runFix, runVerify } from '../src/pipeline.js';
import { onLog, log } from '../src/log.js';
import { hasPayPalKeys, hasAnthropicKey, PROJECT_ROOT } from '../src/env.js';
import { RULES } from '../src/rules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const AG_GRID = path.join(PROJECT_ROOT, 'node_modules', 'ag-grid-community', 'dist', 'ag-grid-community.min.js');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

export async function startDashboard({ port = 4417, target } = {}) {
  const clients = new Set();
  const history = [];
  let job = null;

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };
  onLog((line) => {
    history.push(line);
    if (history.length > 400) history.shift();
    broadcast('log', line);
  });

  const currentReport = () => (target ? readReport(target.name) : null) || latestReport();
  const targetRoot = () => target?.root || currentReport()?.target?.root || path.join(PROJECT_ROOT, 'demo-store');

  async function runJob({ stage, mode, llm }) {
    const root = targetRoot();
    job = { stage, mode, llm, startedAt: Date.now(), root };
    broadcast('job', job);
    try {
      let report = currentReport();
      if (stage === 'scan' || stage === 'all' || !report) report = await runScan({ root, llmMode: llm });
      broadcast('report', { updatedAt: Date.now() });
      if (stage === 'fix' || stage === 'all') report = await runFix({ root, report, llmMode: llm });
      broadcast('report', { updatedAt: Date.now() });
      if (stage === 'verify' || stage === 'all') {
        if (!report.fix) report = await runFix({ root, report, llmMode: llm });
        report = await runVerify({ root, report, mode });
      }
      broadcast('report', { updatedAt: Date.now() });
    } catch (err) {
      log.error(`Run failed: ${err.message}`);
    } finally {
      job = null;
      broadcast('job', null);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return json(403, { error: 'cross-origin request refused' });
    }

    if (url.pathname === '/api/report') {
      const report = currentReport();
      return report ? json(200, report) : json(404, { error: 'No report yet. Run a scan first.' });
    }
    if (url.pathname === '/api/meta') {
      return json(200, {
        keys: { paypal: hasPayPalKeys(), anthropic: hasAnthropicKey() },
        job,
        targetRoot: targetRoot(),
        rules: RULES.map(({ id, title, severity, summary, docs }) => ({ id, title, severity, summary, docs })),
        history,
      });
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ job })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      if (job) return json(409, { error: `A ${job.stage} run is already going.` });
      let body = '';
      for await (const chunk of req) body += chunk;
      let opts;
      try {
        opts = JSON.parse(body || '{}');
      } catch {
        return json(400, { error: 'bad JSON' });
      }
      const stage = ['scan', 'fix', 'verify', 'all'].includes(opts.stage) ? opts.stage : 'all';
      const mode = opts.mode === 'sandbox' ? 'sandbox' : 'mock';
      const llm = ['auto', 'live', 'replay', 'off'].includes(opts.llm) ? opts.llm : 'auto';
      if (mode === 'sandbox' && !hasPayPalKeys()) return json(400, { error: 'Sandbox mode needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.' });
      if (llm === 'live' && !hasAnthropicKey()) return json(400, { error: 'Live LLM mode needs ANTHROPIC_API_KEY in .env.' });
      runJob({ stage, mode, llm });
      return json(202, { started: stage, mode, llm });
    }

    // static files
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (file === '/vendor/ag-grid-community.min.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'max-age=3600' });
      return fs.createReadStream(AG_GRID).pipe(res);
    }
    const abs = path.normalize(path.join(PUBLIC, file));
    if (!abs.startsWith(PUBLIC + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(abs).pipe(res);
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  log.ok(`Dashboard: http://localhost:${port}/  (Ctrl+C to stop)`);
  return server;
}
