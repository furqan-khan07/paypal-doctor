// One probe execution against one materialised copy of the app.
import path from 'node:path';
import { startApp } from './app-runner.js';

export class ProbeRun {
  constructor({ dir, config, upstream, mockUpstream, workDir, label }) {
    Object.assign(this, { dir, config, upstream, mockUpstream, workDir, label });
    this.checks = [];
    this.notes = [];
    this.apps = [];
    this.skipped = null;
    this.upstreamsUsed = new Set();
  }

  async app({ env = {}, faults = [], useMock = false, apiBase } = {}) {
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
    if (!app.ready) this.notes.push(`App did not become ready${app.exited() ? ` (exited with code ${app.exited().code})` : ''}. Last output: ${app.output().slice(-3).join(' | ') || '(none)'}`);
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
      for (const entry of app.trace()) traffic.push({ ...entry, app: app.index, upstream: app.upstream.kind });
    }
    const must = this.checks.filter((c) => c.level === 'must');
    const passed = !this.skipped && must.length > 0 && must.every((c) => c.passed);
    return {
      passed,
      skipped: this.skipped,
      checks: this.checks,
      notes: this.notes,
      upstream: [...this.upstreamsUsed],
      traffic,
    };
  }
}
