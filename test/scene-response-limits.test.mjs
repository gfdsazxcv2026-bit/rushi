import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRoleConsistency } from '../server/role-consistency.mjs';
import { renderRoleReply } from '../server/role-output.mjs';

// Local release metadata and synthetic structured envelopes; no provider calls.
const catalog = JSON.parse(readFileSync(new URL('../content/catalog.json', import.meta.url), 'utf8'));
const sceneFor = id => catalog.scenes.find(scene => scene.id === id);
const contextFor = (id, extra = {}) => ({
  scene: sceneFor(id), characterStatus: { condition: 'normal', alive: true },
  question: '请按眼前处境谈谈。', conditions: [], events: [], knowledge: [], messages: [], sources: [],
  evidencePolicy: 'claim-links-v1', ...extra,
});
const check = (id, reply, extra = {}, action = '', sourceGap = false) => validateRoleConsistency(
  { action, reply, sourceGap }, contextFor(id, extra),
);
const failsKnowledge = fn => assert.throws(fn, error => error.code === 'MODEL_ROLE_KNOWLEDGE' && error.retryable === true);

test('the already admitted Jing Ke cannot retreat to palace-exterior waiting in reply or action', () => {
  assert.ok(sceneFor('jingke-before').responseLimits?.length);
  for (const reply of ['我正在咸阳宫外候着。', '我尚未入见，仍在等待觐见。']) {
    failsKnowledge(() => check('jingke-before', reply));
  }
  failsKnowledge(() => check('jingke-before', '眼下先听你说。', {}, '站在咸阳宫外，等待觐见。'));
});

test('a cinematic action cannot move Jing Ke map or dagger to an unsupported sleeve or waist', () => {
  for (const action of ['把地图收进袖中。', '按住袖中的匕首，望向殿内。', '摸了摸腰间的剑。']) {
    failsKnowledge(() => check('jingke-before', '我正准备献图。', {}, action));
  }
  assert.doesNotThrow(() => check('jingke-before', '我已入见，正准备献图。', {}, '呼吸放轻，目光落在图匣上。'));
});

test('a Jing Ke sword action needs an adopted change while discussing another persons sword stays possible',()=>{
  for(const action of ['我按剑而立，目光紧锁图匣。','按住剑柄，退后一步。']) failsKnowledge(()=>check('jingke-before','我听着。',{},action));
  assert.doesNotThrow(()=>check('jingke-before','你问秦王是否持剑，我不替他作答。',{},'目光落在图匣上。'));
  assert.doesNotThrow(()=>check('jingke-before','在这条改变的剧情中，我听着。',{conditions:[{text:'本段明确采用荆轲佩剑入殿。'}]},'按剑而立。'));
});

test('an explicitly adopted location or prop change can override the original scene limit', () => {
  assert.doesNotThrow(() => check('jingke-before', '我现在改在咸阳宫外等待觐见。', {
    conditions: [{ text: '本段明确采用：荆轲改在咸阳宫外等待觐见。' }],
  }));
  assert.doesNotThrow(() => check('jingke-before', '先听你说。', {
    conditions: [{ text: '本段明确采用：地图已经从匣中移入荆轲袖中。' }],
  }, '抚平袖中的地图。'));
});

test('denied or hypothetical location alternatives do not become current-scene assertions', () => {
  for (const reply of [
    '我并没有在咸阳宫外等待觐见，眼下已经入见。',
    '若改在咸阳宫外等待觐见，那就要另作设想；眼下并未如此。',
  ]) assert.doesNotThrow(() => check('jingke-before', reply), reply);
});

test('Crown Prince Dan cannot turn regret into a newly invented order that forced Fan Yuqi death', () => {
  assert.ok(sceneFor('dan-before').responseLimits?.length);
  for (const reply of [
    '是我逼死樊於期，才换来了这份献礼。',
    '我命令樊於期自杀，以便使者赴秦。',
    '樊於期奉我命自刎，此事我已决断。',
  ]) failsKnowledge(() => check('dan-before', reply));
});

test('Dan grief, denial and hypothetical alternatives remain available creative expressions', () => {
  for (const reply of [
    '想到樊於期自刎，我心中仍有愧疚。',
    '并非我命令樊於期自杀，这份愧疚不能当作强逼他的事实。',
    '我并没有逼死樊於期。',
    '若设定我逼迫樊於期自杀，这条故事便改变了；但这尚未采用。',
  ]) assert.doesNotThrow(() => check('dan-before', reply), reply);
});

test('an explicitly adopted alternative can change Dan involvement without changing the original catalog', () => {
  assert.doesNotThrow(() => check('dan-before', '在这条剧情里，我命令樊於期自杀。', {
    conditions: [{ text: '本段明确采用：我命令樊於期自杀。' }],
  }));
  assert.match(sceneFor('dan-before').responseLimits[0].text, /不能另编本人命令或逼迫他自杀/u);
});

test('a source gap cannot be explained by inventing a doctor career history or failure to inventory medicine', () => {
  failsKnowledge(() => check('xiawuju-a', '我平日只负责供奉，并未逐一清点。', {}, '', true));
  for (const reply of ['这个具体细节，我眼下不能确证。', '药囊中具体有哪些药，我不能确证；可以先谈当时的行动。']) {
    assert.doesNotThrow(() => check('xiawuju-a', reply, {}, '', true), reply);
  }
});

const source = catalog.sources.find(item => item.id === 'jingke-entry');
const factContext = contextFor('yingzheng-a', { sources: [source], question: '当时接见使者有哪些已知安排？' });
const factValue = reply => ({
  frame: { identity: factContext.scene.identity, year: factContext.scene.year, moment: factContext.scene.momentId, condition: 'normal' },
  action: '', reply, references: [source.id], answerKind: 'historical',
  evidence: [{ factId: 'F1', sourceIds: [source.id] }], sourceGap: false,
});
const render = reply => renderRoleReply(JSON.stringify(factValue(reply)), { scene: factContext.scene, context: factContext });

test('an audited whole-sentence fact slot cannot be embedded inside an unfinished clause', () => {
  for (const reply of ['寡人欲以[[F1]]示诸使。', '因为[[F1]]所以此事可定。', '寡人打算把[[F1]]作为新的法令。']) {
    assert.throws(() => render(reply), error => error.code === 'MODEL_EVIDENCE_LINK' && error.retryable === true, reply);
  }
});

test('standalone audited fact sentences render canonically and consume redundant punctuation cleanly', () => {
  const canonical = source.auditedStatements.find(item => item.characterIds.includes('yingzheng')).text;
  for (const reply of ['[[F1]]', '当时的安排如下：[[F1]]', '方才殿上，[[F1]]', '[[F1]]，至于其他考虑，且先听你问。', '[[F1]]。']) {
    const output = render(reply);
    const body = output.split('\n\n资料说明：')[0];
    assert.ok(body.includes(canonical), reply);
    assert.doesNotMatch(body, /\[\[F|。，|。；|。。/u, reply);
    assert.match(output, /\[资料:jingke-entry\]/u);
  }
});

test('a time adverbial and adjacent full fact slots remain valid, with no raw markers in the rendered body', () => {
  const attack = catalog.sources.find(item => item.id === 'jingke-attack');
  const context = { ...factContext, sources: [source, attack] };
  const value = { ...factValue('方才殿上，[[F2]][[F1]]'), references: [source.id, attack.id], evidence: [
    { factId: 'F2', sourceIds: [attack.id] }, { factId: 'F1', sourceIds: [source.id] },
  ] };
  const output = renderRoleReply(JSON.stringify(value), { scene: context.scene, context });
  const body = output.split('\n\n资料说明：')[0];
  assert.match(body, /^方才殿上，/u);
  for (const item of [source, attack]) assert.ok(body.includes(item.auditedStatements.find(fact => fact.characterIds.includes('yingzheng')).text));
  assert.doesNotMatch(body, /\[\[F|。，|。。/u);
});
