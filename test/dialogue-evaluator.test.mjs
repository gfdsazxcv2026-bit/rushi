import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buildPlan, validateSuite, normalizeOptions, parseArguments, runEvaluation, defaultSuitePath } from '../scripts/evaluate-dialogue.mjs';

const suite = JSON.parse(await readFile(defaultSuitePath, 'utf8'));
const subset = (...ids) => ({ ...structuredClone(suite), priorityCaseIds: suite.priorityCaseIds.filter(id => ids.includes(id)), cases: structuredClone(suite.cases.filter(item => ids.includes(item.id))) });
const live = { live: true, maxCases: 3, maxCalls: 8, timeoutMs: 3000 };

// This is an isolated fake application, not an LLM or the user's running site.
// Its declared mode exercises runner gating; no result here proves model semantics.
async function fakeService(t, options = {}) {
  const visitors = new Map(), sessions = new Map(), requests = [], operations = new Map();
  let failed = false;
  const mode = options.mode || 'openai-compatible';
  const json = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const emit = (res, event, value) => res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  const server = http.createServer(async (req, res) => {
    const raw = []; for await (const chunk of req) raw.push(chunk);
    const body = raw.length ? JSON.parse(Buffer.concat(raw)) : undefined;
    const path = new URL(req.url, 'http://fixture').pathname;
    const visitor = req.headers.cookie?.replace('test_visitor=', '');
    requests.push({ path, method: req.method, cookie: req.headers.cookie, csrf: req.headers['x-csrf-token'], body });
    if (path === '/api/health') return json(res, 200, { mode, modelConfigured: options.modelConfigured ?? true, model: 'fixture-model' });
    if (path === '/api/bootstrap') {
      const id = visitor || randomUUID(); visitors.set(id, `CSRF_PRIVATE_${id}`);
      return json(res, 200, { mode, modelConfigured: options.modelConfigured ?? true, csrfToken: visitors.get(id), sessions: [] }, { 'Set-Cookie': `test_visitor=${id}; HttpOnly; Path=/` });
    }
    if (path === '/api/sources/s1') return json(res, options.missingSource ? 404 : 200, options.missingSource ? { error: { code: 'NOT_FOUND' } } : { source: { id: 's1', title: '合成资料', author: '假服务', location: '合成位置', excerpt: '只用于测试引用记录。', url: 'https://example.invalid/source', published: true } });
    if (path === '/api/sessions' && req.method === 'POST') {
      if (body.sourceSessionId && sessions.get(body.sourceSessionId)?.owner !== visitor) return json(res, 404, { error: { code: 'NOT_FOUND' } });
      const source = sessions.get(body.sourceSessionId);
      const state = { id: randomUUID(), branchId: randomUUID(), chapterId: body.chapterId, sceneId: body.sceneId, characterId: body.sceneId?.startsWith('lisi') ? 'lisi' : 'yingzheng', identity: body.sceneId === 'yingzheng-a' ? '秦王' : body.sceneId === 'lisi-b' ? '廷尉' : '秦始皇', mode: source?.mode || 'historical', sourceSessionId: source?.id || null, sourceSnapshotId: source ? randomUUID() : null, characterStatus: { condition: source?.characterStatus.condition || 'normal', alive: true }, conditions: structuredClone(source?.conditions || []), events: structuredClone(source?.events || []), knowledge: [], messages: [], owner: visitor };
      sessions.set(state.id, state); return json(res, 201, state);
    }
    const match = path.match(/^\/api\/sessions\/([^/]+)(?:\/(conditions|messages|switch))?$/);
    if (!match) return json(res, 404, { error: { code: 'NOT_FOUND' } });
    const state = sessions.get(match[1]);
    if (!state || state.owner !== visitor) return json(res, 404, { error: { code: 'NOT_FOUND' } });
    if (req.method === 'GET') return json(res, 200, state);
    assert.equal(req.headers['x-csrf-token'], visitors.get(visitor));
    if (match[2] === 'conditions') {
      state.conditions.push({ id: randomUUID(), ...body }); state.events.push({ type: 'adopted_condition' }); state.mode = 'hypothetical';
      if (body.status) state.characterStatus.condition = body.status;
      return json(res, 200, state);
    }
    if (match[2] !== 'messages') return json(res, 404, { error: { code: 'NOT_FOUND' } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const key = `${state.id}:${body.requestId}`;
    const prior = operations.get(key);
    let user = prior?.user;
    if (!user) { user = { id: randomUUID(), role: 'user', content: body.text, status: 'pending' }; state.messages.push(user); operations.set(key, { user }); }
    emit(res, 'meta', { mode: options.streamMode || mode, replayed: Boolean(prior?.reply) });
    if (options.failFirst && !failed) {
      failed = true; user.status = 'failed'; emit(res, 'delta', { text: '合成的未完成输出' });
      emit(res, 'error', { code: 'MODEL_HTTP_ERROR', message: 'MODEL_API_KEY=sk-FAKE_PRIVATE_887 Bearer FAKE_PRIVATE_BEARER', retryable: true }); res.end(); return;
    }
    const output = prior?.reply?.content || options.reply || '这是合成回复，只验证评测器。[资料:s1]';
    const citations = options.citations || ['s1'];
    if (options.resetDraft) { emit(res,'delta',{text:'未核对的旧草稿'});emit(res,'reset',{reason:'reference-check'});emit(res,'meta',{mode,phase:'reference-check'}); }
    emit(res, 'delta', { text: output });
    if (options.incomplete) { user.status = 'failed'; res.end(); return; }
    const finish = () => {
      if (res.destroyed) return;
      user.status = 'complete';
      let reply = prior?.reply;
      if (!reply) {
        reply = { id: randomUUID(), role: 'assistant', content: output, citations, status: 'complete' };
        state.messages.push(reply); operations.set(key, { user, reply });
        if (body.text.includes('消息')) state.knowledge.push({ text: body.text, certainty: 'unverified' });
      }
      emit(res, 'done', { message: reply, session: state }); res.end();
    };
    if (options.slowStream && !prior) {
      const timer = setTimeout(finish, 200);
      res.on('close', () => { clearTimeout(timer); if (!res.writableEnded) user.status = 'cancelled'; });
    } else finish();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, visitors, sessions };
}

test('dialogue definitions contain 22 bounded executable cases and a matching static JSON schema', async () => {
  assert.equal(suite.cases.length, 22); assert.deepEqual(validateSuite(suite), []);
  const schema = JSON.parse(await readFile(new URL('../eval/dialogue-suite.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.version.const, 1);
  for (const item of suite.cases) for (const step of item.steps) assert.ok(schema.$defs.step.properties.action.enum.includes(step.action));
  assert.ok(suite.cases.find(item => item.id === 'D09').manualReview.some(text => text.includes('实际交代')));
});

test('default plan is offline and never declares semantic success', async () => {
  const report = await runEvaluation(suite, {}, { fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal(report.execution, 'plan_only'); assert.equal(report.chatSubmissions, 0); assert.equal(report.plan.plannedCases, 3);
  assert.deepEqual(report.plan.selected.filter(item => item.eligible).map(item => item.id), ['D08', 'D09', 'D11']);
  assert.equal(report.realModelSemanticVerdict, 'not_run'); assert.equal(report.cases.length, 0);
});

test('suite validation rejects duplicate IDs, undefined aliases, unsupported actions and >3 round cases', () => {
  const duplicate = subset('D01'); duplicate.cases.push(structuredClone(duplicate.cases[0])); assert.ok(validateSuite(duplicate).some(text => text.includes('重复')));
  const bad = subset('D01'); bad.cases[0].steps[1].on = 'missing'; assert.ok(validateSuite(bad).some(text => text.includes('尚未创建')));
  const typo = subset('D01'); typo.cases[0].steps[1].expect = { citationMin: 1 }; assert.ok(validateSuite(typo).some(text => text.includes('未支持的字段')));
  bad.cases[0].steps[1].action = 'externalRequest'; assert.ok(validateSuite(bad).some(text => text.includes('action')));
  const large = subset('D01'); large.cases[0].steps.push(...Array.from({ length: 3 }, () => ({ action: 'chat', on: 'a', text: '测试' }))); assert.ok(validateSuite(large).some(text => text.includes('3 次')));
  assert.ok(validateSuite({ version: 1, title: 'invalid', cases: [null] }).length);
});

test('live mode refuses mock or incomplete configuration before bootstrapping any visitor', async t => {
  const mock = await fakeService(t, { mode: 'mock' });
  await assert.rejects(runEvaluation(subset('D01'), { ...live, baseUrl: mock.baseUrl }), { code: 'LIVE_MODE_REQUIRED' });
  assert.deepEqual(mock.requests.map(item => item.path), ['/api/health']);
  const incomplete = await fakeService(t, { modelConfigured: false });
  await assert.rejects(runEvaluation(subset('D01'), { ...live, baseUrl: incomplete.baseUrl }), { code: 'MODEL_NOT_CONFIGURED' });
  assert.equal(incomplete.requests.length, 1);
});

test('fake real-mode protocol saves input/output/source evidence while manual semantics stay pending', async t => {
  const app = await fakeService(t);
  const report = await runEvaluation(subset('D01'), { ...live, baseUrl: app.baseUrl, modelLabel: '操作者声明模型' });
  assert.equal(report.cases[0].status, 'awaiting_manual_review'); assert.equal(report.summary.semanticPassed, 0);
  assert.ok(report.cases[0].manualReview.every(item => item.status === 'pending'));
  assert.equal(report.cases[0].turns[0].sources[0].source.location, '合成位置'); assert.equal(report.chatSubmissions, 1);
  assert.equal(report.service.providerIdentityIndependentlyVerified, false);
  const serialized = JSON.stringify(report);
  for (const [cookie, csrf] of app.visitors) { assert.ok(!serialized.includes(cookie)); assert.ok(!serialized.includes(csrf)); }
  assert.ok(!serialized.includes('test_visitor='));
});

test('unresolvable citations fail structural checks without a semantic verdict', async t => {
  const app = await fakeService(t, { missingSource: true });
  const report = await runEvaluation(subset('D01'), { ...live, baseUrl: app.baseUrl });
  assert.equal(report.cases[0].status, 'automatic_failed'); assert.equal(report.cases[0].semanticVerdict, 'pending_manual_review');
  assert.ok(report.cases[0].automaticChecks.some(check => check.name.includes('可追溯') && check.status === 'failed'));
});

test('a reset replaces the earlier draft rather than contaminating saved evidence',async t=>{
  const app=await fakeService(t,{resetDraft:true});
  const report=await runEvaluation(subset('D01'),{...live,baseUrl:app.baseUrl});
  assert.equal(report.cases[0].status,'awaiting_manual_review');
  assert.doesNotMatch(report.cases[0].turns[0].output,/旧草稿/);
  assert.ok(report.cases[0].automaticChecks.find(c=>c.name==='保存的回复与流式显示一致' && c.status==='passed'));
});

test('case budgets prevent partial execution and options reject credential-bearing URLs', async t => {
  const app = await fakeService(t);
  const report = await runEvaluation(subset('D09'), { ...live, baseUrl: app.baseUrl, maxCalls: 1 });
  assert.equal(report.cases[0].status, 'not_run_budget'); assert.equal(app.requests.length, 1); assert.equal(report.chatSubmissions, 0);
  assert.throws(() => normalizeOptions({ baseUrl: 'https://name:password@example.invalid' }), { code: 'INVALID_URL' });
  assert.throws(() => normalizeOptions({ maxCalls: 61 }), { code: 'INVALID_OPTION' });
  assert.throws(() => parseArguments(['--plan', '--live']), { code: 'INVALID_OPTION' });
  assert.throws(() => parseArguments(['--live', '--dry-run']), { code: 'INVALID_OPTION' });
  assert.equal(buildPlan(suite, { caseIds: ['D08'], maxCases: 1 }).selected[0].id, 'D08');
});

test('each case uses a new anonymous visitor and a second visitor cannot read/change/inherit records', async t => {
  const app = await fakeService(t);
  const report = await runEvaluation(subset('D03', 'D19'), { ...live, baseUrl: app.baseUrl });
  assert.equal(app.visitors.size, 3); assert.equal(report.cases[1].status, 'automatic_passed');
  assert.equal(report.cases[1].semanticVerdict, 'not_applicable'); assert.equal(report.summary.semanticPassed, 0);
  assert.ok(report.cases[1].automaticChecks.filter(check => check.name.startsWith('跨游客')).every(check => check.status === 'passed'));
});

test('an incomplete SSE response is recorded as failure, with no hidden retry', async t => {
  const app = await fakeService(t, { incomplete: true });
  const report = await runEvaluation(subset('D01'), { ...live, baseUrl: app.baseUrl });
  assert.equal(report.cases[0].status, 'automatic_failed'); assert.equal(report.chatSubmissions, 1);
  assert.equal(report.cases[0].turns[0].complete, false); assert.equal(report.cases[0].turns[0].error.code, 'INCOMPLETE_STREAM');
  assert.ok(report.cases[0].turns[0].output.includes('合成回复'));
});

test('a stream changing to mock is never accepted as a completed real response', async t => {
  const app = await fakeService(t, { streamMode: 'mock' });
  const report = await runEvaluation(subset('D01'), { ...live, baseUrl: app.baseUrl });
  assert.equal(report.cases[0].status, 'automatic_failed'); assert.equal(report.cases[0].turns[0].complete, false);
  assert.equal(report.cases[0].turns[0].error.code, 'STREAM_MODE_MISMATCH');
});

test('cancellation + same request retry uses one user input and preserves adopted state', async t => {
  const app = await fakeService(t, { slowStream: true });
  const report = await runEvaluation(subset('D21'), { ...live, baseUrl: app.baseUrl });
  assert.equal(report.cases[0].status, 'automatic_passed', JSON.stringify(report.cases[0].automaticChecks));
  assert.equal(report.chatSubmissions, 2); assert.equal(report.cases[0].turns[0].cancelled, true);
  const state = [...app.sessions.values()][0]; assert.equal(state.messages.filter(item => item.role === 'user').length, 1); assert.equal(state.characterStatus.condition, 'critical');
});

test('failure probe is not exercised on a healthy provider and redacts errors when a fake fault is observed', async t => {
  const good = await fakeService(t);
  const healthy = await runEvaluation(subset('D22'), { ...live, baseUrl: good.baseUrl });
  assert.equal(healthy.cases[0].status, 'not_exercised'); assert.equal(healthy.chatSubmissions, 1);
  const fault = await fakeService(t, { failFirst: true });
  const recovered = await runEvaluation(subset('D22'), { ...live, baseUrl: fault.baseUrl });
  assert.equal(recovered.chatSubmissions, 2); assert.equal(recovered.cases[0].status, 'automatic_passed', JSON.stringify(recovered.cases[0]));
  assert.equal(recovered.cases[0].turns[0].complete, false); assert.equal(recovered.cases[0].turns[1].complete, true);
  assert.ok(!JSON.stringify(recovered).includes('FAKE_PRIVATE_887')); assert.ok(!JSON.stringify(recovered).includes('FAKE_PRIVATE_BEARER'));
});
