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
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, replayed: 0, missing: 0 };

  const fixturePath = (key) => path.join(dir, `${slug(key)}.json`);

  async function callLive({ system, prompt, schema, maxTokens = 16000, effort = 'high' }) {
    client ??= new Anthropic({ apiKey: loadSecrets().anthropicApiKey });
    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: prompt }],
        output_config: { effort, format: { type: 'json_schema', schema } },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY in .env.');
      if (err instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit hit (429). Wait a minute and re-run.');
      if (err instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${err.status}: ${redact(err.message)}`);
      throw new Error(`Could not reach the Anthropic API: ${redact(err.message)}`);
    }
    usage.calls += 1;
    usage.inputTokens += response.usage?.input_tokens || 0;
    usage.outputTokens += response.usage?.output_tokens || 0;
    usage.cacheReadTokens += response.usage?.cache_read_input_tokens || 0;
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
      const { output, model } = await callLive(req);
      if (resolved === 'record') {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fixturePath(key), JSON.stringify({ key, model, recordedAt: new Date().toISOString(), handWritten: false, output }, null, 2) + '\n');
      }
      return { output, from: 'live', handWritten: false, model };
    },
  };
}
