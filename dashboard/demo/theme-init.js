// Runs before first paint, so a visitor in light mode doesn't get a flash of dark.
// app.js makes the same choice later and owns the toggle.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('pd-theme');
  } catch (e) {
    // Private mode. The system setting decides.
  }
  var light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = saved || (light ? 'light' : 'dark');
})();
