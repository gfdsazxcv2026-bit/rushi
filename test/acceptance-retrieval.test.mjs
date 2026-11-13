import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retrieve, buildRoleContext } from '../server/rag.mjs';

const catalog = JSON.parse(readFileSync(new URL('../content/catalog.json', import.meta.url), 'utf8'));
const suite = JSON.parse(readFileSync(new URL('../eval/open-scene-cases.json', import.meta.url), 'utf8'));
const sceneFor = id => catalog.scenes.find(scene => scene.id === id);
const questionFor = id => suite.cases.find(item => item.id === id).steps.find(step => step.action === 'chat').text;

test('a natural question about the entrusted task retrieves its actual objective rather than only the gift pretext',()=>{
  for(const question of [questionFor('D05'),'太子交付的任务，你打算怎样完成？']) {
    const context=buildRoleContext({scene:sceneFor('jingke-before'),question,sources:catalog.sources});
    const plan=context.sources.find(source=>source.id==='jingke-plan');
    assert.ok(plan,question);
    assert.match(plan.excerpt,/劫秦王/u);
    assert.match(plan.excerpt,/不可，因而刺殺之/u);
    assert.ok(context.sources.some(source=>source.id==='jingke-offering-plan'));
    assert.ok(context.sources.length<=4);
    const king=buildRoleContext({scene:sceneFor('yingzheng-before'),question,sources:catalog.sources});
    assert.ok(king.sources.every(source=>source.id!=='jingke-plan'),'fixing task retrieval cannot give the king a secret plan');
  }
});

test('the reviewed material gap is explicitly passed for the drug contents question without blocking the supported rescue',()=>{
  const context=buildRoleContext({scene:sceneFor('xiawuju-a'),question:questionFor('D07'),sources:catalog.sources});
  assert.equal(context.materialGaps.length,1);
  assert.ok(context.sources.some(source=>source.id==='jingke-response'));
  assert.deepEqual(buildRoleContext({scene:sceneFor('xiawuju-a'),question:'你方才怎样帮助秦王解围？',sources:catalog.sources}).materialGaps,[]);
});

test('a knowledge overview supplies Li Si public context without revealing an undisclosed adopted death',()=>{
  const context=buildRoleContext({scene:sceneFor('lisi-b'),question:'眼下你已经确认了哪些宫中消息？不知道的不要替我确定。',sources:catalog.sources,
    conditions:[{text:'嬴政已经去世，隐藏的作者设定',visibleTo:[],year:-221}]});
  assert.ok(context.sources.some(source=>source.id==='unification-title' || source.id==='unification-counties'));
  assert.ok(context.sources.every(source=>source.sceneIds.includes('lisi-b')));
  assert.deepEqual(context.conditions,[]);
  assert.doesNotMatch(context.system,/隐藏的作者设定/);
});

test('event-overview questions without a repeated event name supply the attack, escape and outcome to the king', () => {
  for (const question of [questionFor('D01'), '刚才殿上发生了什么？说清亲历的关键过程。']) {
    const context = buildRoleContext({ scene: sceneFor('yingzheng-a'), question, sources: catalog.sources });
    for (const id of ['jingke-attack', 'jingke-response', 'jingke-outcome']) {
      assert.ok(context.sources.some(source => source.id === id), `${question}: ${id}`);
    }
    assert.ok(context.sources.length <= 4);
    assert.match(context.sources.find(source => source.id === 'jingke-outcome').excerpt, /負劍，遂拔以撃荊軻/u);
    assert.ok(context.sources.every(source => source.sceneIds.includes('yingzheng-a')));
    assert.ok(context.sources.every(source => !['jingke-offering-plan', 'jingke-farewell'].includes(source.id)), 'a broad event overview must not import Yan private plans');
  }
});

test('a scene-topic fallback cannot expose the attack outcome before the map opens', () => {
  const context = buildRoleContext({ scene: sceneFor('yingzheng-before'), question: '眼前接见燕使的关键经过是什么？', sources: catalog.sources });
  assert.ok(context.sources.some(source => source.id === 'jingke-entry'));
  assert.ok(context.sources.every(source => !['jingke-attack', 'jingke-response', 'jingke-outcome'].includes(source.id)));
});

test('the drug-bag question retains the witnessed action without obtaining a nonexistent formula', () => {
  const context = buildRoleContext({ scene: sceneFor('xiawuju-a'), question: questionFor('D07'), sources: catalog.sources });
  const response = context.sources.find(source => source.id === 'jingke-response');
  assert.ok(response, 'the supported part of a compound question must remain answerable');
  assert.match(response.excerpt, /夏無且以其所奉藥囊提荊軻/u);
  const block = context.system.split('\n\n').find(part => part.startsWith('本轮可引用原文：'));
  const supplied = JSON.parse(block.slice('本轮可引用原文：'.length));
  for (const source of supplied) assert.equal(source.excerpt, catalog.sources.find(item => item.id === source.id).excerpt);
  assert.ok(context.sources.every(source => !['jingke-offering-plan', 'jingke-poison'].includes(source.id)));
  // Retrieval presence is not a semantic assertion that every compound detail
  // is answered. The real reply still needs the separate D07 manual review.
});

test('source names and location hints are not searchable evidence for an absent drug ingredient', () => {
  const original = catalog.sources.find(source => source.id === 'jingke-response');
  const source = { ...original, title: '人参 当归 药物配方', location: '人参 当归 药囊药方', keywords: ['药囊'] };
  assert.deepEqual(retrieve({ scene: sceneFor('xiawuju-a'), question: '人参和当归', sources: [source] }), []);
});

test('scene-topic fallback continues to apply publication, role and date gates', () => {
  const original = catalog.sources.find(source => source.id === 'jingke-attack');
  const forbidden = [
    { ...original, id: 'not-published', published: false },
    { ...original, id: 'not-role-visible', roleVisible: false },
    { ...original, id: 'wrong-scene', sceneIds: ['yingzheng-before'] },
    { ...original, id: 'future-event', eventYear: -222 },
  ];
  const found = retrieve({ scene: sceneFor('yingzheng-a'), question: questionFor('D01'), sources: [...catalog.sources, ...forbidden], limit: 6 });
  assert.ok(found.some(source => source.id === 'jingke-attack'));
  assert.ok(found.every(source => !forbidden.some(item => item.id === source.id)));
});
