import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockPayPal } from '../src/mock-paypal/server.js';
import { startApp } from '../src/verify/app-runner.js';

const config = { start: 'node server.mjs', readyPath: '/healthz', env: { port: 'PORT' } };

test('node:https traffic to PayPal is rerouted, recorded and can be faulted', async () => {
  const mock = createMockPayPal();
  const base = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-icpt-'));
  const apps = [];
  try {
    const routes = { 'https://api-m.sandbox.paypal.com': base };
    const env = { PAYPAL_CLIENT_ID: 'id-123', PAYPAL_CLIENT_SECRET: 'secret-456' };
    const app = await startApp({ dir: 'test/fixtures/https-app', config, env, routes, traceFile: path.join(dir, 't1.jsonl') });
    apps.push(app);
    assert.ok(app.ready);
    const res = await app.raw('GET', '/order');
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const trace = app.trace();
    assert.deepEqual(trace.map((e) => e.path), ['/v1/oauth2/token', '/v2/checkout/orders']);
    assert.match(trace[0].requestHeaders.authorization, /^Basic <credentials fp:[0-9a-f]{12}>$/);
    assert.ok(!JSON.stringify(trace).includes('secret-456'));

    const faulty = await startApp({ dir: 'test/fixtures/https-app', config, env, routes, faults: [{ action: 'drop-response', path: '^/v2/checkout/orders$' }], traceFile: path.join(dir, 't2.jsonl') });
    apps.push(faulty);
    const dropped = await faulty.raw('GET', '/order');
    assert.equal(dropped.status, 502, 'the app sees a dead connection');
    assert.match(faulty.trace()[1].faults[0], /dropped/);
  } finally {
    for (const a of apps) await a.stop();
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
