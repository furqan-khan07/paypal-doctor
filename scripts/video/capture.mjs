// Records the dashboard footage for the demo video with headless Chrome, plus a
// full-width docs/dashboard.png. Headless rendering needs no macOS screen-recording
// permission. Numbers on screen come from the latest report, so after a real sandbox
// run you re-run this and the footage is right.
//
//   npm run video:setup      (once)
//   npm run demo             (or a real run: some report has to exist; Ctrl+C the dashboard)
//   npm run video:capture
//
// Options: --screenshot-only, --chrome <path>, --ffmpeg <path>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { startDashboard } from '../../dashboard/server.js';
import { latestReport, DOCTOR_DIR } from '../../src/report.js';
import { commitMessage } from '../../src/apply.js';
import { PROJECT_ROOT } from '../../src/env.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const CHROME = opt('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const FFMPEG = opt('ffmpeg', process.env.FFMPEG || '/opt/anaconda3/envs/paypal-doctor-video/bin/ffmpeg');
const PORT = Number(opt('port', 4431));
const OUT_DIR = path.join(PROJECT_ROOT, 'video');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = latestReport();
if (!report?.verify) {
  console.error('No verified report yet. Run `npm run demo` (or the real run) first.');
  process.exit(2);
}
const usingSandbox = report.verify.upstream === 'sandbox';
const verified = report.findings.filter((f) => f.verification?.status === 'verified').length;
const finalProbes = report.verify.final.probes;
const finalGreen = finalProbes.filter((p) => p.passed).length;

// ---- page helpers ------------------------------------------------------------

// The page is laid out at 1440x810 and scaled up to a real 1920x1080.
const VIDEO_CSS = `
  body { zoom: 1.3333; min-height: 0 !important; }
  .notice { margin-top: 10px; padding: 6px 12px; }
  .vitals { margin: 10px 0; }
  .split { height: var(--pd-main) !important; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr) !important; }
  .bottom { display: none; margin-top: 0; }
  body.show-traffic .split { display: none; }
  body.show-traffic .bottom { display: flex; height: var(--pd-main); }
  .detail { font-size: 15px; }
  #pd-cursor { position: fixed; z-index: 99999; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none;
    transition: transform .55s cubic-bezier(.3,.8,.3,1); filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
  #pd-card { position: fixed; inset: 0; z-index: 99990; display: flex; flex-direction: column; justify-content: center;
    padding: 0 110px; background: var(--bg); color: var(--text); opacity: 0; pointer-events: none; transition: opacity .35s; }
  #pd-card.on { opacity: 1; }
  #pd-card h1 { font-size: 44px; line-height: 1.15; margin: 0 0 22px; letter-spacing: -0.6px; }
  #pd-card .big { font: 700 78px/1.05 var(--font); margin: 0 0 6px; font-variant-numeric: tabular-nums; }
  #pd-card .bad { color: var(--bad); } #pd-card .ok { color: var(--ok); }
  #pd-card p { font-size: 22px; line-height: 1.4; margin: 0 0 30px; color: var(--muted); max-width: 1000px; }
  #pd-card pre { font: 15px/1.5 var(--mono); background: var(--code-bg); border: 1px solid var(--line); border-radius: 10px;
    padding: 18px 22px; margin: 0; white-space: pre-wrap; color: var(--text); max-height: 500px; overflow: hidden; }
  #pd-card .row { display: flex; gap: 70px; }
  .pd-focus { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 8px; }
`;

async function dress(page) {
  await page.addStyleTag({ content: VIDEO_CSS });
  await page.evaluate(() => {
    const c = document.createElement('div');
    c.id = 'pd-cursor';
    c.innerHTML = '<svg viewBox="0 0 22 22"><path d="M3 2l15 9-7 1.5L8 20z" fill="#fff" stroke="#111" stroke-width="1.2"/></svg>';
    document.documentElement.append(c); // outside the zoomed body, so it moves in real pixels
    // Whatever height is left under the header, the banner and the vitals.
    const used = document.querySelector('.split').getBoundingClientRect().top / 1.3333;
    document.documentElement.style.setProperty('--pd-main', `${Math.floor(810 - used - 14)}px`);
    const card = document.createElement('div');
    card.id = 'pd-card';
    document.body.append(card);
    window.dispatchEvent(new Event('resize'));
  });
}

const moveCursor = (page, x, y) => page.evaluate((a, b) => {
  document.getElementById('pd-cursor').style.transform = `translate(${a}px, ${b}px)`;
}, x, y);

// Click the findings row for a finding, with the cursor travelling there first.
async function clickFinding(page, match) {
  const box = await page.evaluate((m) => {
    const row = [...document.querySelectorAll('#findings-grid .ag-row')].find((r) => r.textContent.includes(m.title) && r.textContent.includes(m.where));
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    const b = row.getBoundingClientRect();
    return { x: b.left + 160, y: b.top + b.height / 2 };
  }, match);
  if (!box) throw new Error(`No row for ${match.title} ${match.where}`);
  await moveCursor(page, box.x, box.y);
  await sleep(650);
  await page.mouse.click(box.x, box.y);
  await sleep(350);
}

const scrollDetailTo = (page, heading, offset = 14) => page.evaluate((h, o) => {
  const d = document.querySelector('#detail');
  const el = [...d.querySelectorAll('h4, summary')].find((x) => x.textContent.trim().toLowerCase().startsWith(h));
  if (el) d.scrollTo({ top: el.offsetTop - d.offsetTop - o, behavior: 'smooth' });
}, heading, offset);

const pointAt = async (page, selector, dx = 40, dy = 16) => {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top };
  }, selector);
  if (box) await moveCursor(page, box.x + dx, box.y + dy);
};

const showCard = (page, html) => page.evaluate((h) => {
  const c = document.getElementById('pd-card');
  c.innerHTML = h;
  c.classList.add('on');
}, html);
const hideCard = (page) => page.evaluate(() => document.getElementById('pd-card').classList.remove('on'));

// Replay the real log of the last run into the Run log tab, sped up to fit the shot.
async function replayLog(page, seconds) {
  const file = path.join(DOCTOR_DIR, 'last-run.log');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  await page.evaluate(() => {
    document.getElementById('log').textContent = '';
    document.getElementById('job-state').textContent = '· the last run, sped up';
    document.querySelector('.tabs [data-tab="log"]').click();
  });
  const step = Math.max(10, (seconds * 1000 - 800) / Math.max(1, lines.length));
  for (const line of lines) {
    await page.evaluate((l) => {
      const el = document.getElementById('log');
      const span = document.createElement('span');
      span.className = l.level;
      span.textContent = `${l.text}\n`;
      el.append(span);
      el.parentElement.scrollTop = el.parentElement.scrollHeight;
    }, line);
    await sleep(step);
  }
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const findingBy = (ruleId, test = () => true) => report.findings.find((f) => f.ruleId === ruleId && test(f));
const row = (f) => ({ title: f.title.slice(0, 18), where: `${f.file}:${f.line}` });

// ---- the shots: durations match VIDEO_SCRIPT.md --------------------------------

const webhook = findingBy('webhook-unverified');
const amount = findingBy('client-supplied-amount');
const capture = findingBy('missing-request-id', (f) => /capture/i.test(`${f.symbol} ${f.message}`));
const status = findingBy('capture-status-unchecked', (f) => !/webhook/i.test(f.symbol));

// A featured finding that didn't verify means the voiceover needs changing too.
for (const [name, f] of Object.entries({ webhook, amount, capture, status })) {
  if (!f) {
    console.error(`The report has no ${name} finding, and the shots are built around it. Edit SHOTS in this file.`);
    process.exit(2);
  }
  if (f.verification?.status !== 'verified') console.warn(`Heads up: the ${name} finding is "${f.verification?.status}", not verified. Rewrite its shot and voiceover line.`);
}

const SHOTS = [
  {
    id: '1-forged-webhook',
    seconds: 26,
    async run(page) {
      await clickFinding(page, row(webhook));
      await sleep(4000);
      await scrollDetailTo(page, 'proof');
      await sleep(1000);
      await pointAt(page, '.proof .col:first-child li:nth-child(2)');
      await sleep(9000);
      await pointAt(page, '.proof .col:last-child li:nth-child(2)');
    },
  },
  {
    id: '2-one-cent-cart',
    seconds: 22,
    async run(page) {
      await clickFinding(page, row(amount));
      await sleep(5000);
      await scrollDetailTo(page, 'proof');
      await sleep(800);
      await pointAt(page, '.proof .col:first-child .checks li');
      await sleep(6000);
      await pointAt(page, '.proof .col:last-child .checks li');
    },
  },
  {
    id: '3-lost-capture-response',
    seconds: 32,
    async run(page) {
      await clickFinding(page, row(capture));
      await sleep(1500);
      await scrollDetailTo(page, 'proof');
      await sleep(9000);
      await page.evaluate(() => {
        document.body.classList.add('show-traffic');
        const box = document.getElementById('only-selected');
        if (!box.checked) box.click();
        document.querySelector('.tabs [data-tab="traffic"]').click();
        window.dispatchEvent(new Event('resize'));
      });
      await sleep(600);
      await pointAt(page, '#traffic-grid .ag-row[row-index="4"]', 500, 14);
      await sleep(7000);
      await pointAt(page, '#traffic-grid .ag-row[row-index="13"]', 500, 14);
    },
    async after(page) {
      await page.evaluate(() => {
        document.body.classList.remove('show-traffic');
        const box = document.getElementById('only-selected');
        if (box.checked) box.click();
        window.dispatchEvent(new Event('resize'));
      });
    },
  },
  {
    id: '4-pending-capture',
    seconds: 18,
    async run(page) {
      await clickFinding(page, row(status));
      await sleep(1000);
      await scrollDetailTo(page, 'proof');
      await sleep(800);
      await pointAt(page, '.proof .col:first-child .checks li:nth-child(4)');
    },
  },
  {
    id: '5-the-run',
    seconds: 20,
    async run(page) {
      await page.evaluate(() => {
        document.body.classList.add('show-traffic');
        window.dispatchEvent(new Event('resize'));
      });
      await replayLog(page, 17);
    },
    async after(page) {
      await page.evaluate(() => {
        document.getElementById('job-state').textContent = '';
      });
    },
  },
  {
    id: '6-regression-pass',
    seconds: 10,
    async run(page) {
      await page.evaluate(() => document.querySelector('.tabs [data-tab="final"]').click());
      await moveCursor(page, 300, 120);
    },
    async after(page) {
      await page.evaluate(() => {
        document.body.classList.remove('show-traffic');
        document.querySelector('.tabs [data-tab="traffic"]').click();
      });
    },
  },
  {
    id: '7-real-code',
    seconds: 19,
    async run(page) {
      await moveCursor(page, -60, -60);
      await showCard(page, `
        <h1>On real code</h1>
        <p>60 public PayPal repos. Every finding checked by hand. Details in docs/validation.md.</p>
        <div class="row">
          <div><div class="big bad">189 of 237</div><p>wrong on the first run,<br>before any fixes</p></div>
          <div><div class="big ok">23 of 27</div><p>correct after the fixes, on 20 repos<br>the detectors had never seen</p></div>
        </div>`);
    },
  },
  {
    id: '8-commits',
    seconds: 13,
    async run(page) {
      const patched = report.findings.filter((f) => f.fix?.status === 'ready').sort((a, b) => a.fix.chainIndex - b.fix.chainIndex);
      const titles = patched.map((f) => `fix(paypal): ${f.title} (${f.file})`).join('\n');
      const sample = commitMessage(amount).split('\n').slice(4, 9).join('\n');
      await showCard(page, `
        <h1 style="font-size:34px">paypal-doctor apply --yes --commits</h1>
        <p style="margin-bottom:18px">One commit per verified patch, with its proof in the message.</p>
        <pre>${esc(titles)}\n\n${esc(sample)}</pre>`);
    },
  },
  {
    id: '9-close',
    seconds: 8,
    async run(page) {
      await showCard(page, `
        <h1>paypal-doctor</h1>
        <p style="margin-bottom:10px">Finds PayPal integration bugs, writes the fix, and proves it${usingSandbox ? ' in the sandbox' : ''}.</p>
        <p style="margin-bottom:10px">${verified} of ${report.findings.length} verified · ${finalGreen} of ${finalProbes.length} probes green on the patched app</p>
        <p style="margin:0;color:var(--text);font-family:var(--mono)">github.com/furqan-khan07/paypal-doctor</p>`);
    },
  },
];

// ---- run ------------------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });
const server = await startDashboard({ port: PORT });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--hide-scrollbars', '--force-dark-mode=false', '--disable-extensions'],
});

try {
  // Full-width screenshot for the README, undressed.
  const shot = await browser.newPage();
  await shot.setViewport({ width: 1600, height: 1040, deviceScaleFactor: 2 });
  await shot.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await shot.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  await shot.screenshot({ path: path.join(PROJECT_ROOT, 'docs', 'dashboard.png') });
  await shot.close();
  console.log('Wrote docs/dashboard.png');

  if (!args.includes('--screenshot-only')) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle2' });
    await dress(page);
    await sleep(1000);

    const raw = path.join(OUT_DIR, 'footage-raw.webm');
    const mp4 = path.join(OUT_DIR, 'footage.mp4');
    const recorder = await page.screencast({ path: raw, ffmpegPath: FFMPEG, fps: 24, quality: 24 });
    const started = Date.now();
    let total = 0;
    for (const s of SHOTS) {
      const t0 = Date.now();
      await s.run(page);
      total += s.seconds;
      const left = s.seconds * 1000 - (Date.now() - t0);
      if (left < 0) console.warn(`Shot ${s.id} ran ${Math.round(-left / 100) / 10}s long`);
      await sleep(Math.max(0, left));
      if (s.after) await s.after(page);
      console.log(`  ${s.id} done at ${Math.round((Date.now() - started) / 100) / 10}s (planned ${total}s)`);
    }
    await hideCard(page).catch(() => {});
    await recorder.stop();
    await page.close();
    // The piped WebM has no duration header; a real MP4 is easier to work with.
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', raw, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '24', '-movflags', '+faststart', mp4]);
    fs.rmSync(raw, { force: true });
    console.log(`Wrote ${path.relative(PROJECT_ROOT, mp4)} (${total}s planned). Next: record the voiceover from VIDEO_SCRIPT.md, then npm run video:merge -- voiceover.m4a`);
  }
} finally {
  await browser.close();
  server.close();
  server.closeAllConnections?.();
}
process.exit(0);
