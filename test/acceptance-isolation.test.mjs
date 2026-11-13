import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, root } from '../server/index.mjs';

// Actual release catalog + real local HTTP/SQLite. The injected generator is
// deliberately fake; these checks never load .env or contact a model provider.
const catalog = JSON.parse(readFileSync(new URL('../content/catalog.json', import.meta.url), 'utf8'));
const scratch = resolve(root, '../../work/final-acceptance-boundaries');
mkdirSync(scratch, { recursive: true });

async function setup(t, generate = async function* () { yield '合成回复，仅验证事务恢复。'; }) {
  const dataDir = mkdtempSync(resolve(scratch, 'run-'));
  let app, generationCount = 0;
  async function start() {
    app = createApp({ dataDir, catalog: structuredClone(catalog),
      env: { VISITOR_REQUESTS_PER_MINUTE: '200', DAILY_MODEL_REQUESTS: '1000', GLOBAL_DAILY_MODEL_REQUESTS: '10000' },
      modelConfig: { mode: 'mock', timeoutMs: 5000, maxRetries: 0 },
      generate: async function* (args) { generationCount++; yield* generate(args); },
    });
    await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  }
  await start();
  function visitor() {
    let cookie = '', csrf = '';
    return {
      async boot() {
        const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/bootstrap`, { headers: cookie ? { Cookie: cookie } : {} });
        cookie = r.headers.get('set-cookie')?.split(';')[0] || cookie;
        const body = await r.json(); csrf = body.csrfToken; return body;
      },
      async request(path, body) {
        const r = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
          method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: r.status, body: r.headers.get('content-type')?.includes('text/event-stream') ? await r.text() : await r.json() };
      },
    };
  }
  t.after(async () => {
    await app.close();
    assert.ok(resolve(dataDir).startsWith(scratch + sep), 'cleanup is restricted to this test scratch');
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { visitor, restart: async () => { await app.close(); await start(); }, get generationCount() { return generationCount; } };
}
async function open(visitor, sceneId, extra = {}) {
  const scene = catalog.scenes.find(item => item.id === sceneId);
  const r = await visitor.request('/api/sessions', { chapterId: scene.chapterId, sceneId, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body;
}

test('all published scenes reject another visitor message/replay and stolen snapshot without a generation', async t => {
  const h = await setup(t), owner = h.visitor(), stranger = h.visitor();
  const boot = await owner.boot(); await stranger.boot();
  const ownStranger = await open(stranger, 'yingzheng-a');
  assert.equal(boot.scenes.length, 18, 'all released scenes, including new major characters, must be checked for visitor isolation');
  for (const scene of boot.scenes) {
    const s = await open(owner, scene.id);
    const snapshot = s.snapshots[0].id;
    for (const [path, body] of [
      [`/api/sessions/${s.id}`, undefined],
      [`/api/sessions/${s.id}/messages`, { text: '尝试越权读取或重放', requestId: randomUUID() }],
      [`/api/sessions/${s.id}/conditions`, { text: '越权设定', operationId: randomUUID() }],
      [`/api/sessions/${s.id}/switch`, { sceneId: scene.id }],
      ['/api/sessions', { chapterId: scene.chapterId, sceneId: scene.id, sourceSessionId: s.id, sourceSnapshotId: snapshot }],
      ['/api/sessions', { chapterId: 'jingke', sceneId: 'yingzheng-a', sourceSessionId: ownStranger.id, sourceSnapshotId: snapshot }],
    ]) assert.equal((await stranger.request(path, body)).status, 404, `${scene.id} ${path}`);
    assert.deepEqual((await owner.request(`/api/sessions/${s.id}`)).body.messages, []);
  }
  assert.equal(h.generationCount, 0);
});

test('every same-year after-to-before transition rejects reuse while an independent earlier scene remains available', async t => {
  const h = await setup(t), visitor = h.visitor(); const boot = await visitor.boot();
  const beforeScenes = boot.scenes.filter(scene => scene.chapterId==='jingke' && scene.year===-227 && scene.momentOrder<20);
  const afterScenes = boot.scenes.filter(scene => scene.momentId === 'jingke-after');
  assert.equal(beforeScenes.length, 5); assert.equal(afterScenes.length, 2);
  for (const afterScene of afterScenes) {
    const after = await open(visitor, afterScene.id);
    const adopted = await visitor.request(`/api/sessions/${after.id}/conditions`, { text: '行刺后的私有标记不可进入事前', type: 'custom', knownToCurrent: true, operationId: randomUUID() });
    assert.equal(adopted.status, 200);
    for (const beforeScene of beforeScenes) {
      for (const [path, body] of [
        [`/api/sessions/${after.id}/switch`, { sceneId: beforeScene.id }],
        ['/api/sessions', { chapterId: 'jingke', sceneId: beforeScene.id, sourceSessionId: after.id, sourceSnapshotId: adopted.body.snapshots[0].id }],
      ]) {
        const r = await visitor.request(path, body); assert.equal(r.status, 409); assert.equal(r.body.error.code, 'TIME_CONFLICT');
      }
      const earlier = await open(visitor, beforeScene.id);
      assert.equal(earlier.mode, 'historical'); assert.equal(earlier.conditions.length, 0);
      assert.equal(earlier.messages.length, 0); assert.equal(earlier.characterStatus.alive, true);
      assert.notEqual(earlier.branchId, after.branchId);
    }
    assert.equal((await visitor.request(`/api/sessions/${after.id}`)).body.conditions.length, 1);
  }
  assert.equal(h.generationCount, 0);
});

test('the current unpublished chapters and their scene/source/static paths remain closed, including the detached chapter draft', async t => {
  const h = await setup(t), visitor = h.visitor(); await visitor.boot();
  for (const chapter of catalog.chapters.filter(item => item.status !== 'published' || item.reviewStatus !== 'checked')) {
    assert.equal((await visitor.request(`/api/chapters/${chapter.id}`)).status, 404, chapter.id);
    assert.equal((await visitor.request(`/api/sources?chapterId=${chapter.id}`)).status, 404, chapter.id);
    for (const scene of catalog.scenes.filter(item => item.chapterId === chapter.id)) {
      assert.equal((await visitor.request('/api/sessions', { chapterId: chapter.id, sceneId: scene.id })).status, 404, scene.id);
    }
    for (const id of chapter.sourceIds || []) assert.equal((await visitor.request(`/api/sources/${id}`)).status, 404, id);
  }
  for (const path of ['/content/drafts/bolangsha.json', '/content/catalog.json', '/server/index.mjs', '/.env']) {
    assert.equal((await visitor.request(path)).status, 404, path);
  }
  assert.equal(h.generationCount, 0);
});

test('a failed operation survives service restart and retries under the same id once without changing adopted body state', async t => {
  let attempts = 0;
  const h = await setup(t, async function* () {
    attempts++;
    if (attempts === 1) { yield 'FAKE_DRAFT_NOT_SAVED'; throw new Error('deterministic synthetic provider failure'); }
    yield 'FAKE_FINAL_REPLY';
  });
  const visitor = h.visitor(); await visitor.boot(); const s = await open(visitor, 'yingzheng-a');
  const adopted = await visitor.request(`/api/sessions/${s.id}/conditions`, { text: '嬴政濒死，尚能微弱说话。', type: 'character_status', characterId: 'yingzheng', status: 'critical', operationId: randomUUID() });
  assert.equal(adopted.status, 200);
  const input = { text: '我收到一条尚待核实的消息，先问清再说。', requestId: randomUUID() };
  const failed = await visitor.request(`/api/sessions/${s.id}/messages`, input);
  assert.match(failed.body, /event: error/);
  const initial = (await visitor.request(`/api/sessions/${s.id}`)).body;
  assert.equal(initial.messages.length, 1); assert.equal(initial.messages[0].status, 'failed');
  assert.equal(initial.knowledge.length, 0); assert.equal(initial.characterStatus.condition, 'critical');
  await h.restart();
  assert.ok((await visitor.boot()).sessions.some(item => item.id === s.id));
  const restored = (await visitor.request(`/api/sessions/${s.id}`)).body;
  assert.equal(restored.messages[0].id, initial.messages[0].id);
  assert.deepEqual(restored.conditions, initial.conditions);
  const retry = await visitor.request(`/api/sessions/${s.id}/messages`, input); assert.match(retry.body, /event: done/);
  const complete = (await visitor.request(`/api/sessions/${s.id}`)).body;
  assert.equal(complete.messages.length, 2); assert.equal(complete.messages[0].id, initial.messages[0].id);
  assert.equal(complete.messages[0].status, 'complete'); assert.equal(complete.messages[1].content, 'FAKE_FINAL_REPLY');
  assert.doesNotMatch(JSON.stringify(complete.messages), /FAKE_DRAFT_NOT_SAVED/);
  assert.deepEqual(complete.conditions, initial.conditions); assert.equal(complete.characterStatus.condition, 'critical');
  await h.restart(); await visitor.boot();
  const replay = await visitor.request(`/api/sessions/${s.id}/messages`, input); assert.match(replay.body, /"replayed":true/);
  assert.equal(attempts, 2, 'post-restart replay does not call even the fake provider');
  assert.equal((await visitor.request(`/api/sessions/${s.id}`)).body.messages.length, 2);
});
