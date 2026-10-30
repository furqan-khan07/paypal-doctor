// Live-mode plumbing against a fake Anthropic API: checks the request we
// build (model, structured output schema, cached system prompt, fallback
// beta) and that the JSON answer is parsed and recorded as a fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const seen = [];
let rejectBeta = false;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body);
    seen.push({ url: req.url, headers: req.headers, body: json });
    if (rejectBeta && json.fallbacks) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: unknown beta' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_fake', type: 'message', role: 'assistant', model: json.model, stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify({ explanation: 'ok', edits: [], notes: '' }) }],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
const { createLLM, FIXTURES_ROOT } = await import('../src/llm/client.js');
const { FIX_SYSTEM, FIX_SCHEMA } = await import('../src/prompts.js');

test('live mode sends a structured-output request and parses the answer', async () => {
  const llm = createLLM({ mode: 'live', target: 'unit-test' });
  const out = await llm.json({ key: 'k1', system: FIX_SYSTEM, prompt: 'hello', schema: FIX_SCHEMA });
  assert.deepEqual(out.output, { explanation: 'ok', edits: [], notes: '' });
  const req = seen.at(-1);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.equal(req.body.output_config.effort, 'high');
  assert.equal(req.body.system[0].cache_control.type, 'ephemeral');
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.headers['anthropic-beta'] || '', /server-side-fallback-2026-07-01/);
});

test('falls back to a plain request if the fallback beta is rejected', async () => {
  rejectBeta = true;
  const llm = createLLM({ mode: 'live', target: 'unit-test' });
  const out = await llm.json({ key: 'k2', system: FIX_SYSTEM, prompt: 'hello', schema: FIX_SCHEMA });
  assert.equal(out.output.explanation, 'ok');
  assert.equal(seen.at(-1).body.fallbacks, undefined);
  rejectBeta = false;
});

test('record mode writes a fixture that replay mode reads back', async () => {
  const dir = path.join(FIXTURES_ROOT, 'unit-test');
  try {
    await createLLM({ mode: 'record', target: 'unit-test' }).json({ key: 'fix|a|b.js|c|1', system: FIX_SYSTEM, prompt: 'x', schema: FIX_SCHEMA });
    const replayed = await createLLM({ mode: 'replay', target: 'unit-test' }).json({ key: 'fix|a|b.js|c|1' });
    assert.equal(replayed.from, 'fixture');
    assert.equal(replayed.handWritten, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});
