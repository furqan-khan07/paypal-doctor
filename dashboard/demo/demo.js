// The hosted demo's landing section: naming a pad on the test strip, and jumping to a
// finding in the dashboard. The page reads fine without this.
const caption = document.getElementById('strip-caption');
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const pads = [...document.querySelectorAll('.pad[data-finding]')];
const dashboardBtn = document.getElementById('caption-open');

function show(finding) {
  const pad = pads.find((p) => p.dataset.finding === finding);
  if (!pad || !caption) return;
  pads.forEach((p) => p.classList.toggle('is-picked', p.dataset.finding === finding));
  caption.querySelector('.caption-title').textContent = pad.dataset.title;
  caption.querySelector('.caption-check').textContent = pad.dataset.check;
  caption.querySelector('.caption-before').textContent = pad.dataset.before;
  caption.querySelector('.caption-after').textContent = pad.dataset.after;
  caption.classList.add('has-pick');
  dashboardBtn.dataset.finding = finding;
}

for (const pad of pads) {
  pad.addEventListener('mouseenter', () => show(pad.dataset.finding));
  pad.addEventListener('focus', () => show(pad.dataset.finding));
  pad.addEventListener('click', () => show(pad.dataset.finding));
}

// Anything marked with a finding opens that finding in the grid.
document.addEventListener('click', (e) => {
  const link = e.target.closest?.('[data-open-finding], #caption-open');
  if (!link) return;
  const id = link.dataset.finding;
  if (!id) return;
  e.preventDefault();
  window.dispatchEvent(new CustomEvent('pd:select', { detail: id }));
  document.getElementById('evidence').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
});
