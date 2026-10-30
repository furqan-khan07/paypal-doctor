// Reads credentials from the real environment first, then from ./.env.
// Nothing in here ever prints a value. Use `redact()` on anything that might
// carry one before it reaches a log, a report or the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let cached = null;

export function loadSecrets({ root = PROJECT_ROOT, fresh = false } = {}) {
  if (cached && !fresh) return cached;
  const file = path.join(root, '.env');
  const fromFile = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8')) : {};
  const get = (k) => String(process.env[k] || fromFile[k] || '').trim();
  cached = {
    paypalClientId: get('PAYPAL_CLIENT_ID'),
    paypalClientSecret: get('PAYPAL_CLIENT_SECRET'),
    paypalWebhookId: get('PAYPAL_WEBHOOK_ID'),
    anthropicApiKey: get('ANTHROPIC_API_KEY'),
  };
  return cached;
}

export const hasPayPalKeys = (s = loadSecrets()) => Boolean(s.paypalClientId && s.paypalClientSecret);
export const hasAnthropicKey = (s = loadSecrets()) => Boolean(s.anthropicApiKey);

// Replace any secret value (and anything shaped like a bearer/basic token)
// with ***. Cheap enough to run over every log line.
export function redact(text) {
  if (text == null) return text;
  let s = typeof text === 'string' ? text : JSON.stringify(text);
  const secrets = loadSecrets();
  for (const v of Object.values(secrets)) {
    if (v && v.length >= 6) s = s.split(v).join('***');
  }
  s = s.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***');
  s = s.replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-***');
  return s;
}
