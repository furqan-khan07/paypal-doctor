// Starts the app under test with the interceptor preloaded and gives probes
// a small HTTP client for its routes.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redact } from '../env.js';

const INTERCEPTOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'interceptor.mjs');

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function splitCommand(cmd) {
  return (cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map((p) => p.replace(/^["']|["']$/g, ''));
}

export async function startApp({ dir, config, env = {}, routes = {}, faults = [], traceFile, readyTimeoutMs = 15000 }) {
  const port = await freePort();
  const [cmd, ...args] = splitCommand(config.start || 'node server.js');
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG || 'en_US.UTF-8',
    NODE_ENV: 'test',
    [config.env?.port || 'PORT']: String(port),
    ...Object.fromEntries(Object.entries(env).filter(([, v]) => v != null)),
    NODE_OPTIONS: `--import "${pathToFileURL(INTERCEPTOR).href}"`,
    DOCTOR_TRACE: traceFile,
    DOCTOR_ROUTES: JSON.stringify(routes),
    DOCTOR_FAULTS: JSON.stringify(faults),
  };
  fs.writeFileSync(traceFile, '');
  const child = spawn(cmd, args, { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  const onData = (d) => {
    for (const line of d.toString().split('\n')) if (line.trim()) output.push(redact(line).slice(0, 400));
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const url = `http://127.0.0.1:${port}`;
  const readyPath = config.readyPath || '/';
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetch(url + readyPath);
      if (res.status < 500) {
        ready = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await sleep(100);
  }

  const app = {
    url,
    ready,
    exited: () => exited,
    output: () => output.slice(),
    trace() {
      if (!fs.existsSync(traceFile)) return [];
      return fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    async call(routeName, { params = {}, body, headers = {} } = {}) {
      const spec = config.routes?.[routeName];
      if (!spec) throw new Error(`paypal-doctor.json has no route "${routeName}"`);
      const [method, pattern] = spec.split(/\s+/);
      const p = pattern.replace(/:([A-Za-z_]+)/g, (_, k) => encodeURIComponent(params[k] ?? ''));
      return this.raw(method, p, { body, headers });
    },
    async raw(method, p, { body, headers = {}, rawBody } = {}) {
      const h = { ...headers };
      let payload;
      if (rawBody != null) payload = rawBody;
      else if (body !== undefined) {
        payload = JSON.stringify(body);
        h['content-type'] ??= 'application/json';
      }
      try {
        const res = await fetch(url + p, { method, headers: h, body: payload, signal: AbortSignal.timeout(30000) });
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = { text: text.slice(0, 300) };
        }
        return { status: res.status, json };
      } catch (err) {
        return { status: 0, json: null, error: err.message };
      }
    },
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      for (let i = 0; i < 30 && !exited; i++) await sleep(50);
      if (!exited) child.kill('SIGKILL');
    },
  };
  return app;
}
