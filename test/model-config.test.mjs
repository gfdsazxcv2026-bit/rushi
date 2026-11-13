import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModelConfig, getModelStatus, generateReply } from '../server/model.mjs';
import { runModelCheck } from '../scripts/check-model.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secret = 'FAKE_KEY_DO_NOT_PRINT_23987';
const configEnv = (baseUrl, overrides = {}) => ({ MODEL_MODE: 'openai-compatible', MODEL_BASE_URL: baseUrl, MODEL_NAME: 'fake-provider-model', MODEL_API_KEY: secret, MODEL_TOKEN_PARAMETER: 'max_tokens', MODEL_INSTRUCTION_ROLE: 'system', MODEL_MAX_RETRIES: '1', MODEL_TIMEOUT_MS: '1000', MODEL_MAX_TOKENS: '512', ...overrides });
const context = { system: '测试指令', messages: [{ role: 'user', content: '测试问题' }] };

test('role-json and sampling options are explicit, validated and secret-free in diagnostics',()=>{
  const config=getModelConfig(configEnv('https://example.invalid/v1',{MODEL_OUTPUT_FORMAT:'role-json',MODEL_TEMPERATURE:'0.3',MODEL_PRESENCE_PENALTY:'0'}));
  assert.equal(config.outputFormat,'role-json');assert.equal(config.temperature,.3);assert.equal(config.presencePenalty,0);
  for(const [name,value] of [['MODEL_OUTPUT_FORMAT','wrong'],['MODEL_TEMPERATURE','NaN'],['MODEL_TEMPERATURE','2'],['MODEL_PRESENCE_PENALTY','3']]) assert.throws(()=>getModelConfig(configEnv('https://example.invalid/v1',{[name]:value})),e=>e.code==='MODEL_CONFIG' && !e.message.includes(secret));
  assert.equal(getModelConfig(configEnv('https://example.invalid/v1')).temperature,undefined);
  assert.doesNotMatch(JSON.stringify(getModelStatus(config)),new RegExp(secret));
});

async function collect(config) {
  let result = '';
  for await (const text of generateReply({ scene: {}, context, question: '测试问题', config })) result += text;
  return result;
}

async function provider(handler) {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    requests++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
    await handler(req, res, body, requests);
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, count: () => requests, close: () => new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose); }) };
}

function completed(res, text = '测试回复') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
}

async function command(argv, env) {
  const child = spawn(process.execPath, [resolve(root, 'scripts/check-model.mjs'), ...argv], { cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
  return { exitCode, stdout, stderr, result: JSON.parse(stdout) };
}

test('static status distinguishes mock, incomplete real configuration and ready-but-unverified', () => {
  assert.equal(getModelStatus(getModelConfig({})).code, 'MODEL_MOCK_ONLY');
  const missing = getModelStatus(getModelConfig({ MODEL_MODE: 'openai-compatible' }));
  assert.equal(missing.readyForLive, false);
  assert.equal(missing.code, 'MODEL_NOT_CONFIGURED');
  assert.deepEqual([missing.checks.endpointConfigured, missing.checks.modelConfigured, missing.checks.keyConfigured], [false, false, false]);
  const ready = getModelStatus(getModelConfig(configEnv('https://private-provider.example/v1')));
  assert.equal(ready.readyForLive, true);
  assert.equal(ready.code, 'MODEL_READY_UNVERIFIED');
  assert.doesNotMatch(JSON.stringify(ready), /FAKE_KEY|private-provider|fake-provider-model/);
});

test('real mode requires an explicit base URL instead of silently choosing a paid provider', () => {
  const config = getModelConfig({ MODEL_MODE: 'openai-compatible', MODEL_NAME: 'named-model', MODEL_API_KEY: secret });
  assert.equal(config.baseUrl, '');
  assert.equal(getModelStatus(config).readyForLive, false);
});

test('invalid endpoint components never appear in safe status', () => {
  for (const baseUrl of ['https://user:TOPSECRET@private.example/v1', 'https://private.example/v1?api_key=TOPSECRET', 'https://private.example/v1#TOPSECRET', 'file:///TOPSECRET', 'not-a-url-TOPSECRET', 'https://private.example/v1/chat/completions']) {
    const status = getModelStatus(getModelConfig(configEnv(baseUrl)));
    assert.equal(status.readyForLive, false);
    assert.equal(status.code, 'MODEL_CONFIG');
    assert.doesNotMatch(JSON.stringify(status), /TOPSECRET|private\.example/);
  }
});

test('token parameter, instruction role, integer bounds and retry limit are explicit validated configuration', () => {
  const config = getModelConfig(configEnv('https://provider.example/v1', { MODEL_TOKEN_PARAMETER: 'max_completion_tokens', MODEL_INSTRUCTION_ROLE: 'developer', MODEL_MAX_RETRIES: '0' }));
  assert.equal(config.tokenParameter, 'max_completion_tokens');
  assert.equal(config.instructionRole, 'developer');
  assert.equal(config.maxRetries, 0);
  for (const override of [{ MODEL_TOKEN_PARAMETER: 'SECRET_PARAM' }, { MODEL_INSTRUCTION_ROLE: 'SECRET_ROLE' }, { MODEL_MAX_RETRIES: '2' }, { MODEL_MAX_RETRIES: '-1' }, { MODEL_MAX_TOKENS: 'NaN' }, { MODEL_TIMEOUT_MS: '0' }]) {
    assert.throws(() => getModelConfig(configEnv('https://provider.example/v1', override)), error => error.code === 'MODEL_CONFIG' && !/SECRET_PARAM|SECRET_ROLE/.test(error.message));
  }
});

test('optional thinking configuration distinguishes omitted, false and true without exposing invalid input', () => {
  for (const [value, expected] of [[undefined, undefined], ['', undefined], ['false', false], ['true', true]]) {
    const config = getModelConfig(configEnv('https://provider.example/v1', { MODEL_ENABLE_THINKING: value }));
    assert.equal(config.enableThinking, expected);
    const status = getModelStatus(config);
    assert.equal(status.readyForLive, true);
    assert.equal(status.enableThinking, expected ?? null);
    assert.equal(status.checks.enableThinkingValid, true);
  }
  assert.throws(() => getModelConfig(configEnv('https://provider.example/v1', { MODEL_ENABLE_THINKING: 'TOPSECRET-not-a-bool' })), error => error.code === 'MODEL_CONFIG' && /MODEL_ENABLE_THINKING/.test(error.message) && !/TOPSECRET/.test(error.message));
});

test('newline credentials are invalid without exposing their value', () => {
  const status = getModelStatus(getModelConfig(configEnv('https://provider.example/v1', { MODEL_API_KEY: 'TOPSECRET\nINJECT' })));
  assert.equal(status.readyForLive, false);
  assert.equal(status.checks.credentialFormatValid, false);
  assert.doesNotMatch(JSON.stringify(status), /TOPSECRET|INJECT/);
});

test('fake provider: configured max_completion_tokens and developer role are sent without guessing alternatives', async () => {
  let seen;
  const fake = await provider(async (_req, res, body) => { seen = body; completed(res); });
  try {
    const config = getModelConfig(configEnv(fake.url, { MODEL_TOKEN_PARAMETER: 'max_completion_tokens', MODEL_INSTRUCTION_ROLE: 'developer' }));
    assert.equal(await collect(config), '测试回复');
    assert.equal(seen.max_completion_tokens, 512);
    assert.equal(Object.hasOwn(seen, 'max_tokens'), false);
    assert.equal(seen.messages[0].role, 'developer');
    assert.equal(fake.count(), 1);
  } finally { await fake.close(); }
});

test('fake provider: explicit Qwen non-thinking setting is sent as false at the HTTP body top level', async () => {
  let seen;
  const fake = await provider(async (_req, res, body) => { seen = body; completed(res); });
  try {
    const config = getModelConfig(configEnv(fake.url, { MODEL_NAME: 'qwen3.8-omni-flash', MODEL_TOKEN_PARAMETER: 'max_completion_tokens', MODEL_INSTRUCTION_ROLE: 'system', MODEL_ENABLE_THINKING: 'false' }));
    await collect(config);
    assert.equal(seen.model, 'qwen3.8-omni-flash');
    assert.equal(seen.enable_thinking, false);
    assert.equal(seen.messages[0].role, 'system');
    assert.equal(seen.max_completion_tokens, 512);
    assert.equal(Object.hasOwn(seen, 'max_tokens'), false);
    assert.equal(Object.hasOwn(seen, 'extra_body'), false);
    assert.equal(fake.count(), 1);
  } finally { await fake.close(); }
});

test('fake provider: unspecified thinking flag is omitted and explicit true is preserved', async () => {
  const seen = [];
  const fake = await provider(async (_req, res, body) => { seen.push(body); completed(res); });
  try {
    await collect(getModelConfig(configEnv(fake.url)));
    await collect(getModelConfig(configEnv(fake.url, { MODEL_ENABLE_THINKING: 'true' })));
    assert.equal(Object.hasOwn(seen[0], 'enable_thinking'), false);
    assert.equal(Object.hasOwn(seen[0], 'extra_body'), false);
    assert.equal(seen[1].enable_thinking, true);
    assert.equal(fake.count(), 2);
  } finally { await fake.close(); }
});

test('fake provider: request rejection is not retried with other token parameters', async () => {
  const seen = [];
  const fake = await provider(async (_req, res, body) => { seen.push(body); res.writeHead(400); res.end(`provider says TOPSECRET ${secret}`); });
  try {
    await assert.rejects(() => collect(getModelConfig(configEnv(fake.url, { MODEL_TOKEN_PARAMETER: 'max_completion_tokens' }))), error => error.code === 'MODEL_REQUEST_REJECTED' && !error.retryable && !/TOPSECRET|FAKE_KEY/.test(error.message));
    assert.equal(fake.count(), 1);
    assert.equal(Object.hasOwn(seen[0], 'max_completion_tokens'), true);
    assert.equal(Object.hasOwn(seen[0], 'max_tokens'), false);
  } finally { await fake.close(); }
});

test('fake provider: explicit zero retries means one request even on server failure', async () => {
  const fake = await provider(async (_req, res) => { res.writeHead(503); res.end('TOPSECRET backend error'); });
  try {
    await assert.rejects(() => collect(getModelConfig(configEnv(fake.url, { MODEL_MAX_RETRIES: '0' }))), { code: 'MODEL_HTTP_ERROR' });
    assert.equal(fake.count(), 1);
  } finally { await fake.close(); }
});

test('fake provider: redirects are not followed or echoed', async () => {
  const fake = await provider(async (_req, res) => { res.writeHead(307, { Location: '/TOPSECRET/redirect' }); res.end('TOPSECRET'); });
  try {
    await assert.rejects(() => collect(getModelConfig(configEnv(fake.url))), error => error.code === 'MODEL_REDIRECT' && !/TOPSECRET/.test(error.message));
    assert.equal(fake.count(), 1);
  } finally { await fake.close(); }
});

test('fake provider: CR-only SSE with usage-only chunks is accepted', async () => {
  const fake = await provider(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const events = [JSON.stringify({ choices: [{ index: 0, delta: { content: '短回复' }, finish_reason: 'stop' }] }), JSON.stringify({ choices: [], usage: { completion_tokens: 4 } }), '[DONE]'];
    for (const event of events) { res.write(`data: ${event}\r`); await new Promise(resolveDelay => setTimeout(resolveDelay, 1)); res.write('\r'); }
    res.end();
  });
  try { assert.equal(await collect(getModelConfig(configEnv(fake.url))), '短回复'); }
  finally { await fake.close(); }
});

test('fake provider: refusal text remains a visible completed text response', async () => {
  const fake = await provider(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"refusal":"不能提供现实伤害方法。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  try { assert.equal(await collect(getModelConfig(configEnv(fake.url))), '不能提供现实伤害方法。'); }
  finally { await fake.close(); }
});

test('fake provider: unsupported tool calls cannot be mistaken for a completed character reply', async () => {
  const fake = await provider(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"fake-tool"}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  });
  try {
    await assert.rejects(() => collect(getModelConfig(configEnv(fake.url))), { code: 'MODEL_UNSUPPORTED_OUTPUT' });
    assert.equal(fake.count(), 1);
  } finally { await fake.close(); }
});

test('fake provider: malformed stream structures fail without retry or raw payload exposure', async () => {
  for (const payload of ['null', '["TOPSECRET"]', '{"TOPSECRET":true}', '{"choices":[{"index":1,"delta":{"content":"TOPSECRET"}}]}']) {
    const fake = await provider(async (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${payload}\n\ndata: [DONE]\n\n`); });
    try {
      await assert.rejects(() => collect(getModelConfig(configEnv(fake.url))), error => error.code === 'MODEL_STREAM_INVALID' && !/TOPSECRET/.test(error.message));
      assert.equal(fake.count(), 1);
    } finally { await fake.close(); }
  }
});

test('fake provider: unknown finish reason cannot commit an apparently completed text', async () => {
  const fake = await provider(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"尚未可靠完成"},"finish_reason":"TOPSECRET_unknown"}]}\n\ndata: [DONE]\n\n');
  });
  try {
    await assert.rejects(() => collect(getModelConfig(configEnv(fake.url))), error => error.code === 'MODEL_STREAM_INVALID' && !/TOPSECRET/.test(error.message));
    assert.equal(fake.count(), 1);
  } finally { await fake.close(); }
});

test('default checker inspects configuration without invoking its network generator', async () => {
  let calls = 0;
  const result = await runModelCheck({ env: configEnv('https://never-call.example/v1'), generate: async function* () { calls++; yield 'wrong'; } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.result.networkRequested, false);
  assert.equal(result.result.liveVerified, false);
  assert.equal(result.result.status.code, 'MODEL_READY_UNVERIFIED');
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(result), /never-call|FAKE_KEY/);
});

test('checker reports mock or missing credentials unavailable even when --live was requested', async () => {
  let calls = 0;
  for (const env of [{}, configEnv('https://never-call.example/v1', { MODEL_API_KEY: '' }), configEnv('', { MODEL_NAME: '' })]) {
    const result = await runModelCheck({ argv: ['--live'], env, generate: async function* () { calls++; yield 'wrong'; } });
    assert.equal(result.exitCode, 2);
    assert.equal(result.result.liveVerified, false);
    assert.equal(result.result.networkRequested, false);
  }
  assert.equal(calls, 0);
});

test('checker help and bad arguments never echo credential-like values or call the network', async () => {
  assert.equal((await runModelCheck({ argv: ['--help'], env: { MODEL_MODE: 'bad' } })).exitCode, 0);
  const invalid = await runModelCheck({ argv: [`--api-key=${secret}`] });
  assert.equal(invalid.exitCode, 64);
  assert.equal(invalid.result.networkRequested, false);
  assert.doesNotMatch(JSON.stringify(invalid), /FAKE_KEY/);
});

test('checker invalid configuration identifies safe field names without echoing its value', async () => {
  const result = await runModelCheck({ env: configEnv('https://never-call.example/v1', { MODEL_TIMEOUT_MS: 'TOPSECRET_BAD_NUMBER' }) });
  assert.equal(result.exitCode, 2);
  assert.equal(result.result.networkRequested, false);
  assert.match(result.result.message, /MODEL_TIMEOUT_MS/);
  assert.doesNotMatch(JSON.stringify(result), /TOPSECRET|FAKE_KEY|never-call/);
});

test('fake provider: live checker caps output and attempts and suppresses provider text', async () => {
  let sent;
  const fake = await provider(async (_req, res, body) => { sent = body; completed(res, `TOPSECRET ${secret}`); });
  try {
    const result = await runModelCheck({ argv: ['--live'], env: configEnv(fake.url) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.result.liveVerified, true);
    assert.equal(result.result.requestLimit, 1);
    assert.equal(sent.max_tokens, 256);
    assert.ok(result.result.responseChars > 0);
    assert.doesNotMatch(JSON.stringify(result), /TOPSECRET|FAKE_KEY|127\.0\.0\.1|fake-provider-model/);
    assert.equal(fake.count(), 1);
  } finally { await fake.close(); }
});

test('fake provider: live checker server failure sends only one request and exits 3 safely', async () => {
  const fake = await provider(async (_req, res) => { res.writeHead(503); res.end(`TOPSECRET ${secret}`); });
  try {
    const result = await runModelCheck({ argv: ['--live'], env: configEnv(fake.url) });
    assert.equal(result.exitCode, 3);
    assert.equal(result.result.liveVerified, false);
    assert.equal(result.result.code, 'MODEL_HTTP_ERROR');
    assert.doesNotMatch(JSON.stringify(result), /TOPSECRET|FAKE_KEY|127\.0\.0\.1/);
    assert.equal(fake.count(), 1);
  } finally { await fake.close(); }
});

test('checker cancellation before a live request performs no network and exits 130', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runModelCheck({ argv: ['--live'], env: configEnv('https://never-call.example/v1'), signal: controller.signal });
  assert.equal(result.exitCode, 130);
  assert.equal(result.result.networkRequested, false);
});

test('CLI default and --help return documented exit codes without network calls', async () => {
  const fake = await provider(async (_req, res) => completed(res));
  try {
    const dry = await command([], configEnv(fake.url));
    assert.equal(dry.exitCode, 0);
    assert.equal(dry.result.networkRequested, false);
    assert.equal(dry.result.liveVerified, false);
    assert.equal(fake.count(), 0);
    const missing = await command([], configEnv(fake.url, { MODEL_API_KEY: '' }));
    assert.equal(missing.exitCode, 2);
    const help = await command(['--help'], configEnv(fake.url, { MODEL_MODE: 'bad' }));
    assert.equal(help.exitCode, 0);
    assert.equal(fake.count(), 0);
  } finally { await fake.close(); }
});

test('CLI --live explicitly calls the local fake provider once and never prints secrets or response text', async () => {
  const fake = await provider(async (_req, res) => completed(res, `TOPSECRET ${secret}`));
  try {
    const result = await command(['--live'], configEnv(fake.url));
    assert.equal(result.exitCode, 0);
    assert.equal(result.result.liveVerified, true);
    assert.equal(fake.count(), 1);
    assert.doesNotMatch(result.stdout + result.stderr, /TOPSECRET|FAKE_KEY|127\.0\.0\.1/);
  } finally { await fake.close(); }
});
