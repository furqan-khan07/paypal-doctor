/* global agGrid */
// paypal-doctor dashboard. Two AG Grid (Community) grids: findings and the
// PayPal traffic the probes generated. Everything else is plain DOM.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { report: null, meta: null, selected: null, mode: 'mock', llm: 'auto', running: false };

// ---------- theme ----------------------------------------------------------

const savedTheme = (() => {
  try {
    return localStorage.getItem('pd-theme');
  } catch {
    return null;
  }
})();
const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
document.documentElement.dataset.theme = savedTheme || (prefersLight ? 'light' : 'dark');
$('#theme-btn').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('pd-theme', next);
  } catch {
    // private mode - fine
  }
};

const gridTheme = agGrid.themeQuartz.withParams({
  backgroundColor: 'var(--panel)',
  foregroundColor: 'var(--text)',
  chromeBackgroundColor: 'var(--panel-2)',
  headerBackgroundColor: 'var(--panel-2)',
  headerTextColor: 'var(--muted)',
  borderColor: 'var(--line)',
  rowHoverColor: 'var(--hover)',
  selectedRowBackgroundColor: 'var(--selected)',
  accentColor: 'var(--accent)',
  fontFamily: 'var(--font)',
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 600,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  spacing: 6,
});

// ---------- small renderers ------------------------------------------------

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const sevPill = (s) => `<span class="pill sev-${esc(s)}">${esc(s)}</span>`;
const verdictOf = (f) => f.verification?.status || (f.fix?.status === 'ready' ? 'not-run' : 'no-patch');
const VERDICT_LABEL = { verified: 'VERIFIED', fixed: 'FIXED', 'static-only': 'STATIC CHECK', failed: 'FAILED', skipped: 'SKIPPED', error: 'APP ERROR', 'not-run': 'NOT VERIFIED', 'no-patch': 'NO PATCH' };
const chip = (v) => `<span class="chip ${esc(v)}">${VERDICT_LABEL[v] || esc(v)}</span>`;

function phaseCell(result, phase) {
  if (!result) return '<span class="muted">-</span>';
  if (result.error) return '<span class="dot warn">app error</span>';
  if (result.skipped) return '<span class="dot warn">skipped</span>';
  if (phase === 'before') return result.passed ? '<span class="dot">not reproduced</span>' : '<span class="dot bad">reproduced</span>';
  return result.passed ? '<span class="dot ok">passes</span>' : '<span class="dot bad">fails</span>';
}

function foundBy(f) {
  if (f.source !== 'llm') return '<span class="badge">static</span>';
  if (f.llm?.handWritten) return '<span class="badge fixture" title="A hand-written stand-in for the Claude review, not model output">fixture</span>';
  const recorded = f.llm?.from === 'fixture';
  return `<span class="badge llm" title="${recorded ? 'Replayed from a recorded Claude response' : 'Live Claude call'}">Claude${recorded ? ' · rec' : ''}</span>`;
}

// Says plainly when what's on screen isn't the real thing.
function renderNotice(r) {
  const el = $('#notice');
  const parts = [];
  const handWritten = r?.findings?.some((f) => f.llm?.handWritten || f.fix?.handWritten);
  if (handWritten) parts.push('The Claude steps on this page are hand-written fixtures, not model output.');
  if (r?.verify?.upstream === 'mock') parts.push('Verification ran against the local PayPal mock, not the sandbox.');
  el.hidden = parts.length === 0;
  el.textContent = parts.length ? `Demo data: ${parts.join(' ')} Add keys to .env and run with --mode sandbox --llm live for the real thing.` : '';
}

// ---------- findings grid ----------------------------------------------------

const findingsGrid = agGrid.createGrid($('#findings-grid'), {
  theme: gridTheme,
  rowData: [],
  rowHeight: 50,
  headerHeight: 36,
  getRowId: (p) => p.data.id,
  rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
  defaultColDef: { sortable: true, resizable: true, filter: true, suppressHeaderMenuButton: true },
  columnDefs: [
    { headerName: 'Severity', field: 'severity', width: 96, cellRenderer: (p) => sevPill(p.value), comparator: (a, b) => SEV_RANK[a] - SEV_RANK[b], sort: 'asc', suppressHeaderFilterButton: true },
    { headerName: 'Finding', field: 'title', flex: 2, minWidth: 170, cellRenderer: (p) => `<div class="two"><span class="clip">${esc(p.data.title)}</span><span class="sub">${esc(p.data.ruleId)}</span></div>` },
    { headerName: 'Where', field: 'file', flex: 1.2, minWidth: 120, valueGetter: (p) => `${p.data.file}:${p.data.line}`, cellRenderer: (p) => `<div class="two"><span class="mono clip">${esc(p.value)}</span><span class="sub">${esc(p.data.symbol)}</span></div>` },
    { headerName: 'Source', field: 'source', width: 94, valueGetter: (p) => (p.data.source === 'llm' ? 'Claude' : 'static'), cellRenderer: (p) => foundBy(p.data) },
    { headerName: 'Patch', colId: 'patch', width: 70, valueGetter: (p) => (p.data.fix?.status === 'ready' ? p.data.fix.chainIndex : null), cellRenderer: (p) => (p.value ? `<span class="mono">#${p.value}</span>` : '<span class="muted">none</span>'), suppressHeaderFilterButton: true },
    {
      headerName: 'Before → after patch',
      colId: 'proof',
      width: 200,
      valueGetter: (p) => [p.data.verification?.before ? (p.data.verification.before.passed ? 'not reproduced' : 'reproduced') : '', p.data.verification?.after ? (p.data.verification.after.passed ? 'passes' : 'fails') : ''].join(' -> '),
      cellRenderer: (p) => (p.data.verification ? `<span class="proof-cell">${phaseCell(p.data.verification.before, 'before')}<span class="arrow">→</span>${phaseCell(p.data.verification.after, 'after')}</span>` : '<span class="muted">not verified</span>'),
    },
    { headerName: 'Verdict', colId: 'verdict', width: 114, valueGetter: (p) => verdictOf(p.data), cellRenderer: (p) => chip(p.value) },
  ],
  onSelectionChanged: (e) => {
    const [row] = e.api.getSelectedRows();
    state.selected = row?.id || null;
    renderDetail();
    refreshTraffic();
  },
  overlayNoRowsTemplate: '<span class="muted">No findings yet - run a scan.</span>',
});
$('#find-filter').oninput = (e) => findingsGrid.setGridOption('quickFilterText', e.target.value);

// ---------- traffic grid ---------------------------------------------------

const ruleOf = (id) => state.report?.findings.find((f) => f.id === id);
const trafficGrid = agGrid.createGrid($('#traffic-grid'), {
  theme: gridTheme,
  rowData: [],
  rowHeight: 32,
  headerHeight: 34,
  defaultColDef: { sortable: true, resizable: true, filter: true, suppressHeaderMenuButton: true },
  columnDefs: [
    { headerName: '#', valueGetter: (p) => p.node.rowIndex + 1, width: 52, sortable: false, filter: false },
    { headerName: 'Finding', colId: 'finding', width: 150, valueGetter: (p) => (p.data.findingId ? `${ruleOf(p.data.findingId)?.ruleId || p.data.findingId}` : 'regression pass') },
    { headerName: 'Phase', field: 'phase', width: 86, suppressHeaderFilterButton: true, cellRenderer: (p) => `<span class="dot ${p.value === 'before' ? 'bad' : 'ok'}">${esc(p.value)}</span>` },
    { headerName: 'Upstream', field: 'upstream', width: 88, suppressHeaderFilterButton: true, cellRenderer: (p) => `<span class="badge">${esc(p.value)}</span>` },
    { headerName: 'Caller', field: 'actor', width: 76, suppressHeaderFilterButton: true, headerTooltip: 'app = the app under test; probe = paypal-doctor acting as the buyer', cellRenderer: (p) => (p.value === 'probe' ? '<span class="badge llm" title="paypal-doctor playing the buyer">probe</span>' : '<span class="muted">app</span>') },
    { headerName: 'Method', field: 'method', width: 72, suppressHeaderFilterButton: true, cellClass: 'mono' },
    { headerName: 'Path', field: 'path', flex: 1, minWidth: 284, cellClass: 'mono', tooltipField: 'path', valueFormatter: (p) => String(p.value || '').replace(/\/[A-Z0-9]{13,}(?=\/|$)/, '/{id}') },
    { headerName: 'Status', field: 'status', width: 72, suppressHeaderFilterButton: true, cellRenderer: (p) => `<span class="mono status-${String(p.value)[0]}">${p.value === 0 ? 'error' : esc(p.value)}</span>` },
    { headerName: 'PayPal said', colId: 'said', flex: 1, minWidth: 156, tooltipValueGetter: (p) => saidOf(p.data), valueGetter: (p) => saidOf(p.data) },
    { headerName: 'PayPal-Request-Id', colId: 'rid', width: 122, cellClass: 'mono', tooltipValueGetter: (p) => p.value, valueGetter: (p) => p.data.requestHeaders?.['paypal-request-id'] || '' },
    { headerName: 'Fault injected', colId: 'faults', flex: 1, minWidth: 170, tooltipValueGetter: (p) => p.value, valueGetter: (p) => (p.data.faults || []).join('; ') },
    { headerName: 'ms', field: 'ms', width: 58, suppressHeaderFilterButton: true, cellClass: 'mono' },
    { headerName: 'Debug id', field: 'debugId', width: 140, cellClass: 'mono' },
  ],
  overlayNoRowsTemplate: '<span class="muted">No PayPal traffic yet - verify some patches.</span>',
});
$('#traffic-filter').oninput = (e) => trafficGrid.setGridOption('quickFilterText', e.target.value);
const csvName = (what) => `paypal-doctor-${state.report?.target?.name || 'report'}-${what}.csv`;
$('#export-traffic').onclick = () => trafficGrid.exportDataAsCsv({ fileName: csvName('paypal-traffic'), columnKeys: ['finding', 'phase', 'upstream', 'actor', 'method', 'path', 'status', 'said', 'rid', 'faults', 'ms', 'debugId'] });
$('#export-findings').onclick = () => findingsGrid.exportDataAsCsv({
  fileName: csvName('findings'),
  processCellCallback: (p) => (p.column.getColId() === 'title' ? `${p.node.data.title} (${p.node.data.ruleId})` : p.value),
});
$('#only-selected').onchange = refreshTraffic;

function saidOf(t) {
  const b = t.responseBody;
  if (t.error) return t.error;
  if (t.said) return t.said;
  if (!b || typeof b !== 'object') return '';
  if (b.details?.[0]?.issue) return b.details[0].issue;
  if (b.verification_status) return `verification ${b.verification_status}`;
  const cap = b.purchase_units?.[0]?.payments?.captures?.[0];
  if (cap) return `order ${b.status}, capture ${cap.status}`;
  if (b.access_token) return 'access token';
  if (b.status) return `${b.id ? `${b.id} ` : ''}${b.status}`;
  if (b.state) return `v1 ${b.state}`;
  return b.name || '';
}

function refreshTraffic() {
  const all = state.report?.traffic || [];
  const only = $('#only-selected').checked && state.selected;
  trafficGrid.setGridOption('rowData', only ? all.filter((t) => t.findingId === state.selected) : all);
  $('#traffic-count').textContent = all.length ? `${only ? `${trafficGrid.getDisplayedRowCount()}/` : ''}${all.length}` : '';
}

// ---------- vitals ---------------------------------------------------------

function renderVitals() {
  const r = state.report;
  renderNotice(r);
  const f = r?.findings || [];
  const bySev = (s) => f.filter((x) => x.severity === s).length;
  const patched = f.filter((x) => x.fix?.status === 'ready').length;
  const verified = f.filter((x) => ['verified', 'fixed', 'static-only'].includes(x.verification?.status)).length;
  const failed = f.filter((x) => x.verification?.status === 'failed').length;
  const final = r?.verify?.final;
  const finalGreen = final ? final.probes.filter((p) => p.passed).length : 0;
  const tiles = [
    { k: 'Findings', v: f.length, s: f.length ? `${bySev('critical')} critical · ${bySev('high')} high · ${bySev('medium')} medium` : 'run a scan', cls: f.length ? 'bad' : '' },
    { k: f.some((x) => x.llm?.handWritten) ? 'From LLM fixture' : 'Found by Claude', v: f.filter((x) => x.source === 'llm').length, s: r?.scan ? `review pass: ${r.scan.llm.mode === 'replay' ? 'replayed' : 'live'}` : '-' },
    { k: 'Patched', v: r?.fix ? `${patched}/${f.length}` : '-', s: r?.fix ? `patches: ${f.some((x) => x.fix?.handWritten) ? 'hand-written fixtures' : r.fix.llmMode === 'replay' ? 'recorded Claude output' : r.fix.model}` : 'not yet' },
    { k: 'Verified', v: r?.verify ? `${verified}/${patched}` : '-', s: r?.verify ? (failed ? `${failed} failed` : 'bug reproduced, then fixed') : 'not yet', cls: r?.verify ? (failed ? 'bad' : 'ok') : '' },
    { k: 'Regression pass', v: final ? `${finalGreen}/${final.probes.length}` : '-', s: final ? (final.remainingFindings.length ? `${final.remainingFindings.length} left in re-scan` : 're-scan clean') : 'all patches applied', cls: final ? (final.allPassed ? 'ok' : 'warn') : '' },
    { k: 'PayPal calls', v: r?.traffic?.length || 0, s: r?.verify ? `against ${r.verify.upstream === 'sandbox' ? 'the sandbox' : 'the local mock'}` : '-', cls: '' },
  ];
  $('#vitals').innerHTML = tiles.map((t) => `<div class="vital ${t.cls || ''}"><div class="k">${esc(t.k)}</div><div class="v">${esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`).join('');
  const target = r?.target;
  const folder = target?.root?.split(/[\\/]/).filter(Boolean).pop();
  $('#target-line').textContent = target ? `${target.name} · ${folder}/${r.updatedAt ? ` · updated ${new Date(r.updatedAt).toLocaleTimeString()}` : ''}` : 'no report yet';
  $('#target-line').title = target?.root || '';
}

// ---------- detail panel ---------------------------------------------------

function codeBlock(lines, hitLine) {
  return `<pre class="code">${lines.map((l) => `<span class="ln${l.line === hitLine ? ' hit' : ''}"><span class="n">${l.line}</span>${esc(l.text)}</span>`).join('')}</pre>`;
}

function diffBlock(diff) {
  const lines = diff.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
  return `<pre class="code diff">${lines.map((l) => {
    const cls = l.startsWith('+++') || l.startsWith('---') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
    return `<span class="ln ${cls}">${esc(l) || ' '}</span>`;
  }).join('')}</pre>`;
}

function checksList(result) {
  if (!result) return '<p class="muted">Not run.</p>';
  if (result.error) return `<p class="callout">The app did not start: ${esc(result.error)}</p>`;
  if (result.skipped) return `<p class="callout">Skipped: ${esc(result.skipped)}</p>`;
  const items = result.checks.map((c) => {
    const mark = c.passed ? '<span class="mark ok">✓</span>' : c.level === 'must' ? '<span class="mark bad">✗</span>' : '<span class="mark soft">!</span>';
    return `<li>${mark}<div>${esc(c.name)}${c.detail ? `<div class="d">${esc(c.detail)}</div>` : ''}</div></li>`;
  }).join('');
  const notes = result.notes?.length ? `<ul class="notes">${result.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  return `<ul class="checks">${items}</ul>${notes}`;
}

function renderDetail() {
  const f = state.report?.findings.find((x) => x.id === state.selected);
  const el = $('#detail');
  if (!f) {
    el.innerHTML = '<div class="empty">Pick a finding to see the code, the patch, and the proof.</div>';
    return;
  }
  const v = f.verification;
  const fix = f.fix;
  const parts = [];
  parts.push(`<div class="row">${sevPill(f.severity)} ${chip(verdictOf(f))} ${foundBy(f)}</div>`);
  parts.push(`<h3>${esc(f.title)}</h3>`);
  parts.push(`<div class="where">${esc(f.file)}:${f.line} · ${esc(f.symbol)}${f.related?.length ? ` · related ${f.related.map((r) => `${esc(r.file)}:${r.line}`).join(', ')}` : ''}</div>`);
  parts.push(`<p>${esc(f.message)}</p>`);
  parts.push(codeBlock(f.snippet || [], f.line));

  parts.push(`<h4>Patch${fix?.chainIndex ? ` #${fix.chainIndex}` : ''}</h4>`);
  if (fix?.status === 'ready') {
    parts.push(`<p>${esc(fix.explanation)}</p>`);
    if (fix.notes) parts.push(`<p class="callout">${esc(fix.notes)}</p>`);
  } else {
    parts.push(`<p class="muted">${esc(fix?.reason || 'No patch yet - run Fix.')}</p>`);
  }

  parts.push('<h4>Proof</h4>');
  if (v) {
    const calls = (state.report.traffic || []).filter((t) => t.findingId === f.id).length;
    if (v.probe) {
      parts.push(`<p class="row"><strong>${esc(v.probeTitle)}</strong> <span class="badge">${esc((v.after?.upstream || []).join(' + ') || v.mode)}</span> ${calls ? `<button class="small-btn" id="show-traffic">${calls} PayPal calls</button>` : ''}</p>`);
      parts.push(`<div class="proof"><div class="col"><h5><span>Before the patch</span>${phaseCell(v.before, 'before')}</h5>${checksList(v.before)}</div><div class="col"><h5><span>After the patch</span>${phaseCell(v.after, 'after')}</h5>${checksList(v.after)}</div></div>`);
    } else {
      parts.push('<p class="muted">No dynamic probe for this rule; verified by re-scanning the patched code.</p>');
    }
    parts.push(`<p class="row"><span class="dot ${v.staticCleared ? 'ok' : 'bad'}">${v.staticCleared ? 'static re-scan no longer reports it' : 'static re-scan still reports it'}</span></p>`);
  } else {
    parts.push('<p class="muted">Not verified yet - run Verify.</p>');
  }

  if (fix?.status === 'ready') {
    parts.push(`<details class="diffs" open><summary>Diff · ${fix.files.map((f) => esc(f.file)).join(', ')}</summary>${fix.files.map((file) => diffBlock(file.diff)).join('')}</details>`);
  }

  parts.push('<h4>PayPal docs</h4>');
  parts.push(`<ul class="docs">${(f.docs || []).map((d) => `<li><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.label)}</a></li>`).join('')}</ul>`);

  const prov = [];
  if (f.source === 'llm') prov.push(f.llm?.handWritten ? 'from a hand-written stand-in for the Claude review pass' : `found by the Claude review pass${f.llm?.from === 'fixture' ? ' (replayed from a recorded response)' : ''}`);
  if (fix?.status === 'ready') prov.push(`patch ${fix.source === 'fixture' ? `replayed from a ${fix.handWritten ? 'hand-written' : 'recorded'} fixture` : `written live by ${fix.model}`}`);
  if (v) prov.push(`verified against ${v.mode === 'sandbox' ? 'the PayPal sandbox' : 'the local mock'} at ${new Date(v.at).toLocaleString()}`);
  if (prov.length) parts.push(`<p class="provenance">${esc(prov.join(' · '))}</p>`);

  el.innerHTML = parts.join('\n');
  el.scrollTop = 0;
  $('#show-traffic')?.addEventListener('click', () => {
    $('#only-selected').checked = true;
    selectTab('traffic');
    refreshTraffic();
    $('.bottom').scrollIntoView({ behavior: 'smooth' });
  });
}

// ---------- regression pass ------------------------------------------------

function renderFinal() {
  const final = state.report?.verify?.final;
  const el = $('#final-list');
  if (!final) {
    el.innerHTML = '<p class="muted">Runs after verification: every probe against the app with all patches applied.</p>';
    $('#final-count').textContent = '';
    return;
  }
  $('#final-count').textContent = `${final.probes.filter((p) => p.passed).length}/${final.probes.length}`;
  const cards = final.probes.map((p) => `<div class="final-card"><h5><span>${esc(p.title)}</span>${phaseCell(p, 'after')}</h5>${checksList(p)}</div>`);
  if (final.remainingFindings.length) cards.push(`<div class="final-card"><h5>Static re-scan</h5><ul class="checks">${final.remainingFindings.map((r) => `<li><span class="mark bad">✗</span><div>${esc(r.ruleId)} <span class="d">${esc(r.file)}:${r.line}</span></div></li>`).join('')}</ul></div>`);
  else cards.push('<div class="final-card"><h5><span>Static re-scan of the patched app</span><span class="dot ok">clean</span></h5><p class="muted">No findings left.</p></div>');
  el.innerHTML = cards.join('');
}

// ---------- tabs, log, controls -------------------------------------------

function selectTab(name) {
  document.querySelectorAll('.tabs [role="tab"]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab-body').forEach((b) => (b.hidden = b.dataset.body !== name));
}
document.querySelectorAll('.tabs [role="tab"]').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));

function appendLog(line) {
  const el = $('#log');
  const span = document.createElement('span');
  span.className = line.level;
  span.textContent = `${line.text}\n`;
  el.append(span);
  while (el.childNodes.length > 600) el.firstChild.remove();
  el.parentElement.scrollTop = el.parentElement.scrollHeight;
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 6000);
}

function setRunning(job) {
  state.running = !!job;
  document.body.classList.toggle('running', !!job);
  document.querySelectorAll('.actions button').forEach((b) => (b.disabled = !!job));
  $('#job-state').textContent = job ? `· running ${job.stage}` : '';
}

document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
  if (b.disabled) return;
  state.mode = b.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
}));
document.querySelectorAll('[data-llm]').forEach((b) => (b.onclick = () => {
  if (b.disabled) return;
  state.llm = b.dataset.llm;
  document.querySelectorAll('[data-llm]').forEach((x) => x.classList.toggle('on', x === b));
}));
document.querySelectorAll('[data-stage]').forEach((b) => (b.onclick = async () => {
  selectTab('log');
  const res = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage: b.dataset.stage, mode: state.mode, llm: state.llm }) });
  if (!res.ok) toast((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
}));

// ---------- data -----------------------------------------------------------

async function loadReport() {
  const res = await fetch('/api/report', { cache: 'no-store' });
  state.report = res.ok ? await res.json() : null;
  const rows = state.report?.findings || [];
  findingsGrid.setGridOption('rowData', rows);
  renderVitals();
  renderFinal();
  refreshTraffic();
  if (!state.selected && rows.length) {
    const first = [...rows].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0];
    state.selected = first.id;
  }
  const node = state.selected && findingsGrid.getRowNode(state.selected);
  if (node) node.setSelected(true);
  else renderDetail();
}

async function loadMeta() {
  const res = await fetch('/api/meta', { cache: 'no-store' });
  state.meta = await res.json();
  const sb = $('#sandbox-btn');
  sb.disabled = !state.meta.keys.paypal;
  sb.title = state.meta.keys.paypal ? 'Run probes against api-m.sandbox.paypal.com' : 'Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env to enable';
  const live = $('#live-btn');
  live.disabled = !state.meta.keys.anthropic;
  live.title = state.meta.keys.anthropic ? 'Call Claude live' : 'Add ANTHROPIC_API_KEY to .env to enable';
  for (const line of state.meta.history || []) appendLog(line);
  setRunning(state.meta.job);
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
  es.addEventListener('job', (e) => setRunning(JSON.parse(e.data)));
  es.addEventListener('report', () => loadReport());
  es.onerror = () => {
    es.close();
    setTimeout(connect, 2000);
  };
}

await loadMeta();
await loadReport();
connect();
