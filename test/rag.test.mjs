import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retrieve, buildRoleContext } from '../server/rag.mjs';

const scene = { id: 'yingzheng-a', status: 'published', characterId: 'yingzheng', characterName: '嬴政', identity: '秦王', title: '行刺刚结束', timeLabel: '战国末期', year: -227, knownFacts: ['荆轲行刺失败。'] };
const source = { id: 's1', title: '史料测试样本', location: '测试位置', excerpt: '荆轲献图而匕首见。', eventYear: -227, sceneIds: ['yingzheng-a'], keywords: ['荆轲', '行刺'], published: true, roleVisible: true };
const actual=JSON.parse(readFileSync(new URL('../content/catalog.json',import.meta.url),'utf8'));

test('retrieval ranks Chinese keywords and returns actual source IDs', () => {
  const result = retrieve({ question: '荆轲为何行刺', scene, sources: [source] });
  assert.equal(result[0].id, 's1');
  assert.ok(result[0].score > 0);
});

test('retrieval rejects future, unpublished, reader-only, unknown-date and other-scene sources', () => {
  const sources = [
    { ...source, id: 'future-secret', eventYear: -210 },
    { ...source, id: 'draft-secret', published: false },
    { ...source, id: 'reader-secret', roleVisible: false },
    { ...source, id: 'unknown-time', eventYear: undefined },
    { ...source, id: 'other-scene', sceneIds: ['lisi-b'] },
  ];
  assert.deepEqual(retrieve({ question: '荆轲行刺', scene, sources }), []);
});

test('retrieval does not manufacture a result for an unrelated question', () => {
  assert.deepEqual(retrieve({ question: '外星飞船有多少发动机', scene, sources: [source] }), []);
});

test('closed scenes and zero limit yield no sources', () => {
  assert.deepEqual(retrieve({ question: '荆轲', scene: { ...scene, status: 'draft' }, sources: [source] }), []);
  assert.deepEqual(retrieve({ question: '荆轲', scene, sources: [source], limit: 0 }), []);
});

test('role context excludes other private chats, future chats and cancelled replies', () => {
  const context = buildRoleContext({ scene, question: '记得吗', messages: [
    { role: 'user', content: '秦王自己的约定', characterId: 'yingzheng', year: -227 },
    { role: 'user', content: '李斯私聊秘密XYZ', characterId: 'lisi', year: -227 },
    { role: 'assistant', content: '未来秘密ABC', characterId: 'yingzheng', year: -210 },
    { role: 'assistant', content: '取消草稿QWE', characterId: 'yingzheng', status: 'cancelled' },
  ] });
  const input = JSON.stringify(context.messages);
  assert.match(input, /秦王自己的约定/);
  assert.doesNotMatch(input, /XYZ|ABC|QWE/);
  assert.equal(context.messages.at(-1).content, '记得吗');
});

test('world facts and conditions are fail-closed without explicit role visibility', () => {
  const context = buildRoleContext({ scene, question: '你知道什么', mode: 'hypothetical',
    conditions: [{ text: '隐藏条件SECRET1', visibleTo: [] }, { text: '无元数据SECRET2' }, { text: '我可知的条件', visibleTo: ['yingzheng'] }],
    events: [{ text: '未知事件SECRET3', knownBy: ['lisi'] }, { text: '我目击的事件', knownBy: ['yingzheng'] }],
  });
  assert.doesNotMatch(context.system, /SECRET1|SECRET2|SECRET3/);
  assert.match(context.system, /我可知的条件|我目击的事件|假设剧情/);
});

test('knowledge remains a sourced claim and does not leak another character knowledge', () => {
  const context = buildRoleContext({ scene, question: '怎么判断', knowledge: [
    { characterId: 'yingzheng', text: '用户说有使者到来', channel: '用户告知', certainty: '未确认' },
    { characterId: 'lisi', text: '李斯秘密KNOWLEDGE' },
    { characterId: 'yingzheng', text: '未来FUTURE', year: -210 },
  ] });
  assert.match(context.system, /用户告知|未确认/);
  assert.doesNotMatch(context.system, /KNOWLEDGE|FUTURE/);
  assert.equal(context.knowledge.length, 1);
});

test('role context rechecks source eligibility and explicitly marks missing evidence', () => {
  const context = buildRoleContext({ scene, question: '荆轲', sources: [{ ...source, excerpt: 'DRAFTLEAK', published: false }] });
  assert.match(context.system, /现有资料未找到依据/);
  assert.doesNotMatch(context.system, /DRAFTLEAK/);
  assert.deepEqual(context.sources, []);
});

test('bounded recent context does not append an identical pending user message twice', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第${i}轮` }));
  messages.push({ role: 'user', content: '当前问题' });
  const context = buildRoleContext({ scene, question: '当前问题', messages });
  assert.equal(context.messages.length, 12);
  assert.equal(context.messages.filter(item => item.content === '当前问题').length, 1);
});

test('temporary hypothetical replies remain discussion memory without erasing adopted status or private memory', () => {
  const context=buildRoleContext({scene,question:'接着说，你眼下最需要我弄清什么？',mode:'hypothetical',
    characterStatus:{condition:'critical',alive:true,sourceConditionIds:['body-adopted']},
    messages:[
      {role:'user',content:'我们的私下口令是秋水。',characterId:'yingzheng'},
      {role:'assistant',content:'寡人记住了。',characterId:'yingzheng'},
      {role:'user',content:'如果李斯赶来救你呢？',characterId:'yingzheng'},
      {role:'assistant',content:'让他过来；若他赶来，先问清消息。',characterId:'yingzheng'},
    ],
  });
  const marked=context.messages.find(message=>message.role==='assistant' && message.content.includes('让他过来'));
  assert.match(marked.content,/往轮临时假设讨论记录/);
  assert.match(marked.content,/让他过来；若他赶来，先问清消息/);
  assert.equal(context.messages[0].content,'我们的私下口令是秋水。');
  assert.equal(context.messages.at(-1).content,'接着说，你眼下最需要我弄清什么？');
  assert.equal(context.characterStatus.condition,'critical');
  assert.deepEqual(context.events,[]);
});

test('hypothesis annotations cannot bring in another role or future conversations', () => {
  const context=buildRoleContext({scene,question:'眼下怎样？',messages:[
    {role:'user',content:'如果李斯私下知道OTHER_ROLE_SECRET呢？',characterId:'lisi'},
    {role:'assistant',content:'OTHER_ROLE_ANSWER',characterId:'lisi'},
    {role:'user',content:'如果后来发生FUTURE_HYPOTHESIS呢？',characterId:'yingzheng',year:-210},
    {role:'user',content:'我眼下只想核实消息。',characterId:'yingzheng'},
    {role:'assistant',content:'先说从何而来。',characterId:'yingzheng'},
  ]});
  assert.doesNotMatch(JSON.stringify(context),/OTHER_ROLE_SECRET|OTHER_ROLE_ANSWER|FUTURE_HYPOTHESIS/);
  assert.equal(context.messages.find(message=>message.role==='assistant').content,'先说从何而来。');
});

test('specific governance topic outranks generic unification words in natural questions',()=>{
  const current=actual.scenes.find(s=>s.id==='yingzheng-b');
  for(const question of ['郡县','天下已经统一，你为何采纳郡县的主张？你眼前还担心什么？','为何不分封，而采用郡县治理？']) assert.equal(retrieve({question,scene:current,sources:actual.sources})[0].id,'unification-counties',question);
});

test('event sequence retrieval connects real passages without following forbidden links',()=>{
  const current=actual.scenes.find(s=>s.id==='yingzheng-a');
  const sources=structuredClone(actual.sources);
  sources.find(s=>s.id==='jingke-entry').relatedSourceIds.push('jingke-aftermath','jingke-plan');
  const result=retrieve({question:'刚才燕使献图后发生了什么？说清关键经过，并为有史料依据的部分标注资料。',scene:current,sources,limit:4});
  assert.deepEqual(new Set(result.map(s=>s.id)),new Set(['jingke-entry','jingke-attack','jingke-response','jingke-outcome']));
});

test('governance reasons retrieve the argument rather than borrowing a title quotation',()=>{
  const current=actual.scenes.find(s=>s.id==='yingzheng-b');
  const result=retrieve({question:'天下已经统一，你为何采纳郡县的主张？',scene:current,sources:actual.sources});
  assert.equal(result[0].id,'unification-counties');
  assert.equal(result[1].id,'unification-counties-reason');
  assert.match(result[1].excerpt,/相攻擊如仇讎/);
});

test('earlier evidence markers do not become a current-turn source whitelist',()=>{
  const context=buildRoleContext({scene,question:'宫门外所有侍卫分别叫什么？',messages:[
    {role:'user',content:'献图后发生了什么？'},
    {role:'assistant',content:'寡人记得那时的惊险[资料:OLD_REFERENCE]。\n\n资料说明：\n“OLD_QUOTATION”[资料:OLD_REFERENCE]'},
  ]});
  assert.doesNotMatch(JSON.stringify(context.messages),/OLD_REFERENCE|OLD_QUOTATION/);
  assert.match(JSON.stringify(context.messages),/惊险/);
  assert.equal(context.citationPolicy,'source-quotes-v1');
});

test('source memories retain their historical time when the same person moves forward',()=>{
  const current=actual.scenes.find(s=>s.id==='yingzheng-b');
  const context=buildRoleContext({scene:current,question:'还记得阿衡吗？',messages:[
    {role:'user',content:'我叫阿衡。',characterId:'yingzheng',year:-227},
    {role:'assistant',content:'寡人记住了。',characterId:'yingzheng',year:-227},
  ]});
  assert.match(context.messages[1].content,/前227年的交流/);
  assert.equal(context.messages[0].content,'我叫阿衡。');
});
