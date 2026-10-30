import { redact } from './env.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const color = {
  dim: c(2), bold: c(1), red: c(31), green: c(32), yellow: c(33), blue: c(34), magenta: c(35), cyan: c(36),
};

// Listeners let the dashboard stream the same lines the terminal sees.
const listeners = new Set();
export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(level, parts) {
  const text = redact(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
  for (const fn of listeners) fn({ level, text, ts: Date.now() });
  return text;
}

export const log = {
  info: (...p) => console.log(emit('info', p)),
  step: (...p) => console.log(color.bold(emit('step', p))),
  ok: (...p) => console.log(color.green(emit('ok', p))),
  warn: (...p) => console.warn(color.yellow(emit('warn', p))),
  error: (...p) => console.error(color.red(emit('error', p))),
  dim: (...p) => console.log(color.dim(emit('dim', p))),
};
