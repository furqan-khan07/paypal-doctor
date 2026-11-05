// One door to Claude. Four modes:
//   live    call the API (needs ANTHROPIC_API_KEY)
//   record  call the API and save each response as a fixture
//   replay  answer from fixtures only (no network, no key)
//   off     never answer
// `auto` = live when a key is present, otherwise replay.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadSecrets, hasAnthropicKey, redact, PROJECT_ROOT } from '../env.js';

export const MODEL = process.env.PAYPAL_DOCTOR_MODEL || 'claude-opus-5-5';
export const FIXTURES_ROOT = path.join(PROJECT_ROOT, 'src', 'llm', 'fixtures');

// USD per million tokens. Cache writes are 1.25x input (5-minute TTL).
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
// Stops a run from spending more than this, in case a loop or a retry goes wrong.
const MAX_USD = Number(process.env.PAYPAL_DOCTOR_MAX_USD) || 6;
let processSpend = 0;

export function costOf(model, usage) {
  const key = Object.keys(PRICES).find((k) => (model || '').startsWith(k));
  const p = PRICES[key] || PRICES['claude-opus-5-5'];
  return {
    usd: ((usage.input_tokens || 0) * p.input + (usage.output_tokens || 0) * p.output +
      (usage.cache_read_input_tokens || 0) * p.cacheRead + (usage.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6,
    priced: !!key,
  };
}

export const slug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 150);

export function fixturePath(target, key) {
  return path.join(FIXTURES_ROOT, slug(target), `${slug(key)}.json`);
}

export function resolveMode(requested = 'auto') {
  if (requested === 'auto') return hasAnthropicKey() ? 'live' : 'replay';
  if ((requested === 'live' || requested === 'record') && !hasAnthropicKey()) {
    throw new Error(`--llm ${requested} needs ANTHROPIC_API_KEY in .env (or the environment).`);
  }
  return requested;
}

export function createLLM({ mode = 'auto', target = 'default' } = {}) {
  const resolved = resolveMode(mode);
  const dir = path.join(FIXTURES_ROOT, slug(target));
  let client = null;
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, models: [], replayed: 0, missing: 0 };
  // One line per real API call, with the usage block exactly as the API returned it.
  const usageLog = path.join(process.env.PAYPAL_DOCTOR_HOME || path.join(PROJECT_ROOT, '.doctor'), 'llm-usage.jsonl');

  const fixturePath = (key) => path.join(dir, `${slug(key)}.json`);

  let useFallbacks = true;

  async function callLive({ key, system, prompt, schema, maxTokens = 16000, effort = 'high' }) {
    if (processSpend >= MAX_USD) throw new Error(`Stopped: this run has spent $${processSpend.toFixed(2)}, over the $${MAX_USD} limit (PAYPAL_DOCTOR_MAX_USD).`);
    client ??= new Anthropic({ apiKey: loadSecrets().anthropicApiKey });
    const params = {
      model: MODEL,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort, format: { type: 'json_schema', schema } },
    };
    let response;
    try {
      // Server-side fallback: if the model declines, the API retries on its
      // recommended fallback model inside the same call.
      response = useFallbacks
        ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
        : await client.messages.create(params);
    } catch (err) {
      if (useFallbacks && err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(err.message)) {
        // Older accounts/SDKs may not have the fallback beta - carry on without it.
        useFallbacks = false;
        return callLive({ key, system, prompt, schema, maxTokens, effort });
      }
      if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY in .env.');
      if (err instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit hit (429). Wait a minute and re-run.');
      if (err instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${err.status}: ${redact(err.message)}`);
      throw new Error(`Could not reach the Anthropic API: ${redact(err.message)}`);
    }
    const u = response.usage || {};
    const { usd, priced } = costOf(response.model, u);
    usage.calls += 1;
    usage.inputTokens += u.input_tokens || 0;
    usage.outputTokens += u.output_tokens || 0;
    usage.cacheReadTokens += u.cache_read_input_tokens || 0;
    usage.cacheWriteTokens += u.cache_creation_input_tokens || 0;
    usage.costUsd += usd;
    if (!usage.models.includes(response.model)) usage.models.push(response.model);
    processSpend += usd;
    try {
      fs.mkdirSync(path.dirname(usageLog), { recursive: true });
      fs.appendFileSync(usageLog, `${JSON.stringify({ at: new Date().toISOString(), key, model: response.model, stop: response.stop_reason, usage: u, usd, priced })}\n`);
    } catch {
      // the log is a convenience; never fail a run over it
    }
    if (response.stop_reason === 'refusal') throw new Error('The model declined this request (stop_reason: refusal).');
    if (response.stop_reason === 'max_tokens') throw new Error('The model ran out of output tokens before finishing.');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { output: JSON.parse(text), model: response.model };
  }

  return {
    mode: resolved,
    model: MODEL,
    usage,
    // Returns { output, from: 'live'|'fixture', handWritten } or null.
    async json({ key, ...req }) {
      if (resolved === 'off') return null;
      if (resolved === 'replay') {
        const file = fixturePath(key);
        if (!fs.existsSync(file)) {
          usage.missing += 1;
          return null;
        }
        const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
        usage.replayed += 1;
        return { output: fx.output, from: 'fixture', handWritten: !!fx.handWritten, model: fx.model };
      }
      const { output, model } = await callLive({ key, ...req });
      if (resolved === 'record') {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fixturePath(key), JSON.stringify({ key, model, recordedAt: new Date().toISOString(), handWritten: false, output }, null, 2) + '\n');
      }
      return { output, from: 'live', handWritten: false, model };
    },
  };
}
