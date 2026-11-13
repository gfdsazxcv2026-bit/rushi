import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dialogueIntent } from '../server/role-prompt.mjs';
import { buildRoleContext } from '../server/rag.mjs';

const catalog = JSON.parse(readFileSync(new URL('../content/catalog.json', import.meta.url), 'utf8'));
const sceneFor = id => catalog.scenes.find(scene => scene.id === id);
const build = (question, sceneId = 'yingzheng-a', extra = {}) => buildRoleContext({
  scene: sceneFor(sceneId), question, sources: catalog.sources, ...extra,
});

test('personal introductions, corrected names and acceptance questions use conversation instead of unrelated political RAG', () => {
  for (const question of [
    '我叫青禾，来意是了解秦燕交涉。我提出以“秋水”为私下提示，你可以接受，也可以拒绝。',
    '更正：以后请叫我青舟，原先的青禾不用了；来意仍是了解秦燕交涉。',
    '现在你应该怎样称呼我？我来做什么？你当时到底有没有接受秋水提议？按实际答复说。',
    '你还记得我的名字、来意和我们之前说过的约定吗？',
    '你有没有接受我提出的秋水约定？',
  ]) {
    assert.equal(dialogueIntent(question), 'memory', question);
    const context = build(question);
    assert.deepEqual(context.sources, [], question);
    assert.equal(context.messages.at(-1).content, question);
    assert.match(context.system, /直接回答称呼、来意和提议|个人交流|回忆任务/u);
  }
});

test('remembering an actual historical event does not disable relevant current-scene evidence retrieval', () => {
  for (const [sceneId, question, expectedId] of [
    ['yingzheng-a', '你还记得荆轲行刺的经过吗？', 'jingke-attack'],
    ['yingzheng-b', '你还记得统一后郡县之议的主要考虑吗？', 'unification-counties'],
    ['wangjian-b', '你记得征楚时为何一直坚壁不战吗？', 'unification-chu-campaign'],
  ]) {
    assert.notEqual(dialogueIntent(question), 'memory', question);
    const context = build(question, sceneId);
    assert.ok(context.sources.some(source => source.id === expectedId), `${question}: ${expectedId}`);
    assert.ok(context.sources.every(source => source.sceneIds.includes(sceneId) && source.eventYear <= context.scene.year));
  }
});

test('historical recall phrased as a previous question can still supply evidence without sharing another character history', () => {
  const question = '你还记得我上次问荆轲如何行刺吗？请把经过再讲一次，并说明依据。';
  const otherPrivate = { role: 'user', characterId: 'xiawuju', sceneId: 'xiawuju-a', year: -227, status: 'complete', content: 'OTHER_CHARACTER_PRIVATE_639' };
  const context = build(question, 'yingzheng-a', { messages: [otherPrivate] });
  assert.notEqual(dialogueIntent(question), 'memory');
  assert.ok(context.sources.length > 0);
  assert.ok(context.sources.some(source => source.id === 'jingke-attack'));
  assert.doesNotMatch(JSON.stringify(context.messages), /OTHER_CHARACTER_PRIVATE_639/);
});

test('personal-memory routing retains current physical and explicitly adopted hypothetical conditions', () => {
  const scene = sceneFor('yingzheng-a');
  const condition = { text: '本段嬴政濒死，仍能微弱交谈。', visibleTo: ['yingzheng'], year: scene.year, momentId: scene.momentId, momentOrder: scene.momentOrder };
  const context = build('你还记得我的名字和来意吗？', scene.id, {
    mode: 'hypothetical', characterStatus: { condition: 'critical', alive: true }, conditions: [condition],
  });
  assert.deepEqual(context.sources, []);
  assert.equal(context.mode, 'hypothetical');
  assert.equal(context.characterStatus.condition, 'critical');
  assert.equal(context.conditions[0].text, condition.text);
  assert.match(context.system, /假设剧情/u);
});
