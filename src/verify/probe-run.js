// One probe execution against one materialised copy of the app.
import path from 'node:path';
import { startApp } from './app-runner.js';

export class AppStartError extends Error {}

export class ProbeRun {
  constructor({ dir, config, upstream, mockUpstream, workDir, label }) {
    Object.assign(this, { dir, config, upstream, mockUpstream, workDir, label });
    this.checks = [];
    this.notes = [];
    this.apps = [];
    this.skipped = null;
    this.upstreamsUsed = new Set();
    // The probe's own calls (playing the buyer, replays) go through the
    // doctor's PayPal clients, not the app; remember where their logs stand.
    this.clientMarks = new Map([upstream, mockUpstream].filter(Boolean).map((u) => [u.client, { kind: u.kind, from: u.client.calls.length }]));
  }

  async app({ env = {}, faults = [], useMock = false, apiBase, allowNotReady = false } = {}) {
    const up = useMock ? this.mockUpstream : this.upstream;
    const e = this.config.env || {};
    const fullEnv = {
      [e.clientId || 'PAYPAL_CLIENT_ID']: up.creds.clientId,
      [e.clientSecret || 'PAYPAL_CLIENT_SECRET']: up.creds.clientSecret,
      [e.webhookId || 'PAYPAL_WEBHOOK_ID']: up.webhookId,
      [e.apiBase || 'PAYPAL_API_BASE']: apiBase ?? up.base,
      ...env,
    };
    const traceFile = path.join(this.workDir, `trace-${this.label}-${this.apps.length + 1}.jsonl`);
    const app = await startApp({ dir: this.dir, config: this.config, env: fullEnv, routes: up.routes, faults, traceFile });
    app.upstream = up;
    app.index = this.apps.length + 1;
    this.upstreamsUsed.add(up.kind);
    this.apps.push(app);
    if (!app.ready) {
      const out = app.output();
      const err = out.find((l) => /\b(Error|ERR_[A-Z_]+)\b/.test(l));
      const why = `App did not start${app.exited() ? ` (exited with code ${app.exited().code})` : ''}: ${err ? err.trim() : out.slice(-3).join(' | ') || '(no output)'}`;
      if (!allowNotReady) throw new AppStartError(why);
      this.notes.push(why);
    }
    return app;
  }

  check(name, passed, detail = '', { level = 'must' } = {}) {
    this.checks.push({ name, passed: !!passed, detail, level });
    return !!passed;
  }

  note(text) {
    this.notes.push(text);
  }

  skip(reason) {
    this.skipped = reason;
  }

  async finish() {
    const traffic = [];
    for (const app of this.apps) {
      await app.stop();
      for (const entry of app.trace()) traffic.push({ ...entry, actor: 'app', app: app.index, upstream: app.upstream.kind });
    }
    for (const [client, { kind, from }] of this.clientMarks) {
      for (const c of client.calls.slice(from)) {
        traffic.push({
          t: c.t, method: c.method, path: c.path, status: c.status, ms: c.ms, debugId: c.debugId, actor: 'probe', upstream: kind,
          requestHeaders: c.requestId ? { 'paypal-request-id': c.requestId } : {}, faults: [], said: c.said,
        });
      }
    }
    traffic.sort((a, b) => (a.t || 0) - (b.t || 0));
    const must = this.checks.filter((c) => c.level === 'must');
    const passed = !this.skipped && !this.error && must.length > 0 && must.every((c) => c.passed);
    return {
      passed,
      skipped: this.skipped,
      error: this.error || null,
      checks: this.checks,
      notes: this.notes,
      upstream: [...this.upstreamsUsed],
      traffic,
    };
  }
}
