import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, root } from '../server/index.mjs';
import { catalog } from './fixtures.mjs';

// These are real HTTP/SQLite checks with a fake generator, not model-quality tests.
const scratch = resolve(root, '../../work/api-tests');
mkdirSync(scratch, { recursive: true });
function client(url, initialCookie = '') {
  let cookie = initialCookie, csrf = '';
  return {
    async init() {
      const response = await fetch(url + '/api/bootstrap', { headers: cookie ? { Cookie: cookie } : {} });
      cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
      const body = await response.json(); csrf = body.csrfToken; return body;
    },
    async request(path, body) {
      return fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: {
        Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    async json(path, body) { const response = await this.request(path, body); return { status: response.status, body: await response.json() }; },
    get cookie() { return cookie; },
  };
}
async function scenario(t, generate) {
  const dataDir = mkdtempSync(resolve(scratch, 'private-recall-'));
  const instances = [], captured = [];
  t.after(async () => {
    for (const item of instances.toReversed()) await item.close();
    assert.ok(resolve(dataDir).startsWith(scratch + sep), 'cleanup stays inside the test scratch directory');
    rmSync(dataDir, { recursive: true, force: true });
  });
  async function start(cookie = '') {
    const app = createApp({ catalog: structuredClone(catalog), dataDir,
      env: { VISITOR_REQUESTS_PER_MINUTE: '200', DAILY_MODEL_REQUESTS: '1000', GLOBAL_DAILY_MODEL_REQUESTS: '10000' },
      modelConfig: { mode: 'mock', timeoutMs: 5000 },
      generate: async function* (args) {
        captured.push(structuredClone(args.context));
        if (generate) yield* generate(args);
        else yield args.question.includes('约定') ? '我没有答应这个约定。' : '合成回复，仅核对保存和上下文传递。';
      },
    });
    await new Promise(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    let closed = false;
    const item = { app, url, async close() { if (!closed) { closed = true; await app.close(); } } };
    instances.push(item);
    const visitor = client(url, cookie); await visitor.init();
    return { ...item, visitor };
  }
  return { start, captured, dataDir };
}
async function fresh(visitor, sceneId = 'yingzheng-a', chapterId = 'jingke', extra = {}) {
  const result = await visitor.json('/api/sessions', { sceneId, chapterId, ...extra });
  assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
}
async function send(visitor, id, text, success = true) {
  const response = await visitor.request(`/api/sessions/${id}/messages`, { text, requestId: randomUUID() });
  const output = await response.text(); assert.equal(response.status, 200, output);
  assert.match(output, success ? /event: done/ : /event: error/); return output;
}
async function fill(visitor, id, count = 7) {
  for (let index = 0; index < count; index++) await send(visitor, id, `第${index + 1}轮，谈谈眼前的局面。`);
}
const recallQuestion = '还记得我的名字、来意，以及我们之前提出的约定吗？';

test('HTTP long chat recalls located name, purpose and the actual refusal without adopting a world event', async t => {
  const { start, captured } = await scenario(t);
  const { visitor } = await start(); const session = await fresh(visitor);
  await send(visitor, session.id, '我叫青禾，我来见你是为了了解秦燕交涉。');
  await send(visitor, session.id, '约定把秋水作为我们的暗号，可以吗？');
  await fill(visitor, session.id);
  const before = (await visitor.json(`/api/sessions/${session.id}`)).body;
  assert.equal(before.messages.length, 18, 'the first four messages are beyond the recent twelve');
  const callsBefore = captured.length;
  await send(visitor, session.id, recallQuestion);
  assert.equal(captured.length, callsBefore + 1, 'recall does not call a second summary generator');
  const context = captured.at(-1), records = context.privateRecall.records;
  const identity = records.find(record => record.source.messageId === before.messages[0].id);
  const agreement = records.find(record => record.source.messageId === before.messages[2].id);
  assert.match(identity.visitorText, /青禾.*秦燕交涉/);
  assert.equal(identity.source.sessionId, session.id);
  assert.equal(identity.source.sceneId, 'yingzheng-a');
  assert.equal(identity.source.replyMessageId, before.messages[1].id);
  assert.equal(agreement.kind, 'visitor-proposal');
  assert.equal(agreement.characterReply, '我没有答应这个约定。');
  assert.equal(agreement.source.replyMessageId, before.messages[3].id);
  assert.equal(context.messages.at(-1).content, recallQuestion);
  assert.deepEqual(context.conditions, []); assert.deepEqual(context.events, []);
  const after = (await visitor.json(`/api/sessions/${session.id}`)).body;
  assert.deepEqual(after.conditions, before.conditions); assert.deepEqual(after.events, before.events);
});

test('older private recall remains isolated across characters, visitors and independent branches', async t => {
  const { start, captured } = await scenario(t);
  const { visitor, url } = await start();
  const emperor = await fresh(visitor, 'yingzheng-b', 'unification');
  await send(visitor, emperor.id, '我叫PRIVATE_RECALL_OWNER_817，我的来意是只与你谈私事。');
  await fill(visitor, emperor.id);
  const li = (await visitor.json(`/api/sessions/${emperor.id}/switch`, { sceneId: 'lisi-b' })).body;
  await send(visitor, li.id, recallQuestion);
  assert.doesNotMatch(JSON.stringify(captured.at(-1)), /PRIVATE_RECALL_OWNER_817/);
  assert.deepEqual(captured.at(-1).privateRecall.records, []);
  const otherVisitor = client(url); await otherVisitor.init();
  assert.equal((await otherVisitor.json(`/api/sessions/${emperor.id}`)).status, 404);
  assert.equal((await otherVisitor.json('/api/sessions', { chapterId: 'unification', sceneId: 'yingzheng-b', sourceSessionId: emperor.id })).status, 404);
  const otherEmperor = await fresh(otherVisitor, 'yingzheng-b', 'unification');
  await send(otherVisitor, otherEmperor.id, recallQuestion);
  assert.doesNotMatch(JSON.stringify(captured.at(-1)), /PRIVATE_RECALL_OWNER_817/);
  const independent = await fresh(visitor, 'yingzheng-b', 'unification');
  await send(visitor, independent.id, recallQuestion);
  assert.doesNotMatch(JSON.stringify(captured.at(-1)), /PRIVATE_RECALL_OWNER_817/);
  const back = (await visitor.json(`/api/sessions/${li.id}/switch`, { sceneId: 'yingzheng-b' })).body;
  assert.equal(back.id, emperor.id);
  await send(visitor, back.id, recallQuestion);
  assert.match(JSON.stringify(captured.at(-1).privateRecall), /PRIVATE_RECALL_OWNER_817/);
});

test('explicit cross-chapter continuation recalls a frozen source and ignores later parent corrections', async t => {
  const { start, captured } = await scenario(t);
  const { visitor } = await start(); const parent = await fresh(visitor);
  await send(visitor, parent.id, '我叫SOURCE_OLD_NAME_493，我的来意是讨论燕国处境。');
  await fill(visitor, parent.id);
  const child = await fresh(visitor, 'yingzheng-b', 'unification', { sourceSessionId: parent.id });
  assert.ok(child.sourceSnapshotId);
  await send(visitor, parent.id, '更正：别再叫我旧名字，我叫PARENT_NEW_NAME_682。');
  await send(visitor, child.id, '你还记得上次的名字和来意吗？');
  const context = captured.at(-1);
  assert.match(JSON.stringify(context.privateRecall), /SOURCE_OLD_NAME_493/);
  assert.doesNotMatch(JSON.stringify(context), /PARENT_NEW_NAME_682/);
  const original = context.privateRecall.records.find(record => record.visitorText.includes('SOURCE_OLD_NAME_493'));
  assert.equal(original.source.sessionId, parent.id);
  assert.equal(original.source.sceneId, 'yingzheng-a');
  assert.equal(original.source.year, -227);
  assert.equal(context.scene.year, -221);
  const independent = await fresh(visitor, 'yingzheng-b', 'unification');
  await send(visitor, independent.id, '还记得之前的名字吗？');
  assert.doesNotMatch(JSON.stringify(captured.at(-1)), /SOURCE_OLD_NAME_493|PARENT_NEW_NAME_682/);
});

test('private recall is reconstructed from SQLite after an actual application restart with the same visitor cookie', async t => {
  const { start, captured } = await scenario(t);
  const first = await start(); const session = await fresh(first.visitor);
  await send(first.visitor, session.id, '我叫RESTART_NAME_159，我的来意是求教秦燕交涉。');
  await fill(first.visitor, session.id);
  const original = (await first.visitor.json(`/api/sessions/${session.id}`)).body.messages[0];
  const cookie = first.visitor.cookie; await first.close();
  const second = await start(cookie);
  const restored = await second.visitor.init();
  assert.ok(restored.sessions.some(item => item.id === session.id));
  await send(second.visitor, session.id, recallQuestion);
  const record = captured.at(-1).privateRecall.records.find(item => item.source.messageId === original.id);
  assert.match(record.visitorText, /RESTART_NAME_159/);
  assert.equal(record.source.sessionId, session.id);
  const stranger = client(second.url); await stranger.init();
  assert.equal((await stranger.json(`/api/sessions/${session.id}`)).status, 404);
});

test('a failed turn stays retryable in the record and never becomes an older private memory', async t => {
  const { start, captured } = await scenario(t, async function* ({ question }) {
    if (question.includes('FAILED_MEMORY_NAME_871')) throw new Error('synthetic provider failure');
    yield '合成完整回复。';
  });
  const { visitor } = await start(); const session = await fresh(visitor);
  await send(visitor, session.id, '我叫FAILED_MEMORY_NAME_871，请记住我的来意。', false);
  await fill(visitor, session.id, 8);
  const saved = (await visitor.json(`/api/sessions/${session.id}`)).body;
  assert.equal(saved.messages[0].status, 'failed');
  await send(visitor, session.id, recallQuestion);
  assert.doesNotMatch(JSON.stringify(captured.at(-1)), /FAILED_MEMORY_NAME_871/);
  assert.ok(saved.messages.every(message => message.role !== 'assistant' || !message.content.includes('FAILED_MEMORY_NAME_871')));
});
