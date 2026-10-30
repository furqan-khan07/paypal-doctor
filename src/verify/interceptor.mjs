// Loaded into the app under test with `node --import`. Wraps globalThis.fetch
// so every request to PayPal is (1) recorded to DOCTOR_TRACE as JSON lines,
// (2) optionally rerouted (sandbox host -> local mock, canary host -> real
// upstream), (3) optionally hit with a fault, and (4) never allowed to reach
// the live API. Secrets are never written: Authorization headers become a
// short fingerprint, card numbers keep their last four digits.
//
// Self-contained on purpose: no imports beyond node built-ins, so it can't
// pull the doctor's own dependencies into the app.
//
// node:http / node:https (axios, got, @paypal/paypal-server-sdk) are covered
// too: requests to PayPal are sent to a small server inside this process,
// on a unix socket, which replays them through the same fetch wrapper.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

const TRACE = process.env.DOCTOR_TRACE;
const ROUTES = JSON.parse(process.env.DOCTOR_ROUTES || '{}');
const FAULTS = JSON.parse(process.env.DOCTOR_FAULTS || '[]').map((f) => ({ ...f, used: 0 }));
const LIVE_HOSTS = new Set(['api-m.paypal.com', 'api.paypal.com', 'ipnpb.paypal.com']);
const PAYPAL_HOST = /(^|\.)paypal\.com$/;

const realFetch = globalThis.fetch;
let seq = 0;

const fingerprint = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    if (k === 'authorization') {
      if (v.startsWith('Basic ')) {
        const decoded = Buffer.from(v.slice(6), 'base64').toString('utf8');
        const [id = '', secret = ''] = decoded.split(':');
        const empty = !id || !secret || /^(undefined|null)$/.test(id) || /^(undefined|null)$/.test(secret);
        out[k] = `Basic <${empty ? 'empty credentials' : `credentials fp:${fingerprint(decoded)}`}>`;
      } else if (v.startsWith('Bearer ')) out[k] = 'Bearer <token>';
      else out[k] = '<redacted>';
    } else out[k] = v;
  }
  return out;
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'access_token' || k === 'refresh_token' || k === 'id_token') out[k] = '<token>';
      else if (k === 'number' && typeof v === 'string' && /^\d{12,19}$/.test(v)) out[k] = `****${v.slice(-4)}`;
      else if (k === 'security_code') out[k] = '***';
      else out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

function parseBody(text) {
  if (text == null || text === '') return null;
  try {
    return scrub(JSON.parse(text));
  } catch {
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  }
}

function record(entry) {
  if (!TRACE) return;
  try {
    fs.appendFileSync(TRACE, `${JSON.stringify(entry)}\n`);
  } catch {
    // tracing must never break the app
  }
}

function matches(fault, method, path) {
  if (fault.times != null && fault.used >= fault.times) return false;
  if (fault.method && fault.method !== method) return false;
  if (fault.path && !new RegExp(fault.path).test(path)) return false;
  return true;
}

function reroute(url) {
  const origin = url.origin;
  if (ROUTES[origin]) return new URL(url.pathname + url.search, ROUTES[origin]);
  return url;
}

async function doctorFetch(input, init) {
  const req = new Request(input, init);
  const original = new URL(req.url);
  const isPayPal = PAYPAL_HOST.test(original.hostname) || ROUTES[original.origin] !== undefined;
  if (!isPayPal) return realFetch(input, init);

  const method = req.method.toUpperCase();
  const bodyText = method === 'GET' || method === 'HEAD' ? undefined : await req.clone().text();
  const target = reroute(original);
  const headers = new Headers(req.headers);
  const entry = {
    seq: ++seq,
    t: Date.now(),
    method,
    originalUrl: original.href,
    url: target.href,
    path: original.pathname,
    requestHeaders: redactHeaders(headers),
    requestBody: parseBody(bodyText),
    faults: [],
  };

  if (LIVE_HOSTS.has(target.hostname)) {
    entry.status = 0;
    entry.error = 'blocked: paypal-doctor never lets a probe reach the live PayPal API';
    record(entry);
    throw new TypeError('fetch failed', { cause: new Error(entry.error) });
  }

  const active = FAULTS.filter((f) => matches(f, method, original.pathname));
  for (const f of active) {
    if (f.action === 'mock-response') {
      headers.set('PayPal-Mock-Response', JSON.stringify({ mock_application_codes: f.code }));
      entry.requestHeaders['paypal-mock-response'] = headers.get('PayPal-Mock-Response');
      entry.faults.push(`negative test ${f.code}`);
      f.used += 1;
    }
  }

  const started = Date.now();
  let res;
  try {
    res = await realFetch(target, { method, headers, body: bodyText, redirect: req.redirect, signal: req.signal });
  } catch (err) {
    entry.status = 0;
    entry.error = String(err?.cause?.message || err?.message || err);
    entry.ms = Date.now() - started;
    record(entry);
    throw err;
  }
  let text = await res.text();
  let status = res.status;
  const outHeaders = new Headers(res.headers);
  for (const h of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']) outHeaders.delete(h);

  for (const f of active) {
    if (f.action === 'set-capture-status') {
      try {
        const json = JSON.parse(text);
        for (const pu of json.purchase_units || []) {
          for (const c of pu.payments?.captures || []) {
            c.status = f.status;
            c.status_details = { reason: f.reason || 'PENDING_REVIEW' };
          }
        }
        if (json.status && /\/captures\/|\/authorizations\/.*\/capture$/.test(original.pathname)) {
          json.status = f.status;
          json.status_details = { reason: f.reason || 'PENDING_REVIEW' };
        }
        text = JSON.stringify(json);
        entry.faults.push(`capture status rewritten to ${f.status} (${f.reason || 'PENDING_REVIEW'})`);
        f.used += 1;
      } catch {
        // not JSON - leave it alone
      }
    }
  }

  entry.status = status;
  entry.ms = Date.now() - started;
  entry.debugId = res.headers.get('paypal-debug-id') || undefined;
  entry.responseBody = parseBody(text.length > 40000 ? text.slice(0, 40000) : text);

  const drop = active.find((f) => f.action === 'drop-response');
  if (drop) {
    drop.used += 1;
    entry.faults.push('response dropped after PayPal processed the request (simulated timeout)');
    record(entry);
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  }

  record(entry);
  return new Response(text, { status, statusText: res.statusText, headers: outHeaders });
}

globalThis.fetch = doctorFetch;

// ---- node:http / node:https -------------------------------------------------

const SOCKET = path.join(os.tmpdir(), `paypal-doctor-${process.pid}-${crypto.randomBytes(3).toString('hex')}.sock`);
const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'x-doctor-origin']);

const bridge = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  try {
    const out = await doctorFetch(`${req.headers['x-doctor-origin']}${req.url}`, { method: req.method, headers, body });
    const buf = Buffer.from(await out.arrayBuffer());
    const h = {};
    out.headers.forEach((v, k) => {
      if (!HOP.has(k)) h[k] = v;
    });
    h['content-length'] = String(buf.length);
    res.writeHead(out.status, h);
    res.end(buf);
  } catch {
    // dropped response / blocked host: look like a dead connection
    res.destroy();
  }
});
bridge.unref();
try {
  fs.rmSync(SOCKET, { force: true });
} catch {
  // nothing to clean
}
bridge.listen(SOCKET);
process.on('exit', () => {
  try {
    fs.rmSync(SOCKET, { force: true });
  } catch {
    // best effort
  }
});

const realHttpRequest = http.request;

function targetOf(scheme, args) {
  let url = null;
  let options = {};
  let cb;
  for (const a of args) {
    if (typeof a === 'string') url = new URL(a);
    else if (a instanceof URL) url = a;
    else if (typeof a === 'function') cb = a;
    else if (a && typeof a === 'object') options = a;
  }
  if (!url) {
    const proto = options.protocol || scheme;
    const host = options.hostname || (options.host || 'localhost').replace(/:\d+$/, '');
    const port = options.port ? `:${options.port}` : '';
    url = new URL(`${proto}//${host}${port}${options.path || '/'}`);
  } else if (options.path) {
    url = new URL(options.path, url);
  }
  return { url, options, cb };
}

function patch(mod, scheme) {
  const original = mod.request;
  mod.request = function patchedRequest(...args) {
    const { url, options, cb } = targetOf(scheme, args);
    const isPayPal = PAYPAL_HOST.test(url.hostname) || ROUTES[url.origin] !== undefined;
    if (!isPayPal) return original.apply(this, args);
    const headers = { ...(options.headers || {}), 'x-doctor-origin': url.origin };
    return realHttpRequest({ method: options.method || 'GET', socketPath: SOCKET, path: url.pathname + url.search, headers, timeout: options.timeout }, cb);
  };
  mod.get = function patchedGet(...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}
patch(https, 'https:');
patch(http, 'http:');
// make `import { request } from 'node:https'` see the patched functions too
syncBuiltinESMExports();
