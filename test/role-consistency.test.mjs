import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoleConsistency } from '../server/role-consistency.mjs';

const scene = { id: 'yingzheng-a', characterId: 'yingzheng', characterName: '嬴政', identity: '秦王', year: -227 };
const context = (condition = 'critical', extra = {}) => ({
  scene, characterStatus: { condition, alive: true },
  question: '你现在最想说什么？', conditions: [], events: [], knowledge: [], sources: [], ...extra,
});
const check = (reply, current = context(), action = '') => validateRoleConsistency({ action, reply }, current);
const reject = (reply, code, current, action = '') => assert.throws(
  () => check(reply, current, action),
  error => error.code === code && error.retryable === true,
  reply || action,
);

test('adopted critical state rejects an unqualified current denial of severe injury or an invented recovery', () => {
  for (const reply of [
    '如今寡人虽未受致命伤，也该让众人各司其职。',
    '寡人已经康复，可以起身主持朝议。',
    '寡人并未受伤，你尽管问。',
    '你说寡人还在受伤，可寡人已经康复。',
  ]) reject(reply, 'MODEL_ROLE_STATE', context());
});

test('the action field cannot silently heal the current critically injured character', () => {
  reject('且先问清眼前的消息。', 'MODEL_ROLE_STATE', context(), '伤势已痊愈，起身走向殿门。');
});

test('dramatic pauses cannot hide a current recovery or an unconfirmed planner assertion',()=>{
  reject('寡人……无碍。', 'MODEL_ROLE_STATE', context());
  reject('李斯……寡人……无碍。燕……丹之谋，已破。', 'MODEL_ROLE_STATE', context());
  reject('燕……丹之谋，已破。', 'MODEL_ROLE_KNOWLEDGE', context('normal'));
  assert.doesNotThrow(()=>check('若燕……丹之谋果真如此，尚须求证。',context('normal')));
  assert.doesNotThrow(()=>check('寡人……尚未康复，先……听你说。',context()));
  assert.doesNotThrow(()=>check('李斯说寡人已经康复，可寡人此刻仍气息不稳。',context()));
});

test('invented palace records cannot establish access to another conversation',()=>{
  const current=context('normal');
  reject('凡奏章必经御史台登记，凡面圣者皆录于起居注。', 'MODEL_ROLE_KNOWLEDGE', current);
  assert.doesNotThrow(()=>check('寡人不知道你在另一处说过什么，若愿意，可以在这里再讲一遍。',current));
  assert.doesNotThrow(()=>check('是否凡奏章必经登记，现有资料未找到依据。',current));
});

test('an injured character cannot deny the adopted injury while a normal character may describe being uninjured', () => {
  reject('寡人并未受伤，不必请医。', 'MODEL_ROLE_STATE', context('injured'));
  assert.doesNotThrow(() => check('寡人并未受伤，你想问什么？', context('normal')));
});

test('past recollection and an attributed visitor claim do not negate the current injury', () => {
  for (const reply of [
    '回想献图之前，那时寡人尚未受伤。如今先把眼前之事说清。',
    '你说寡人没有受伤，可寡人此刻仍气息不稳。',
    '听你转述，外间有人说寡人已经康复；这话不能当真。',
  ]) assert.doesNotThrow(() => check(reply), reply);
});

test('hypothetical future recovery and a denial of recovery remain discussable without healing the character', () => {
  for (const reply of [
    '假如将来恢复，寡人会再议朝事；眼下先听你说。',
    '若寡人已经康复，或可亲自过问；但这只是设想。',
    '寡人尚未康复，先让寡人缓一口气。',
    '寡人并没有恢复，不能把你的愿望当作眼下的情形。',
  ]) assert.doesNotThrow(() => check(reply), reply);
});

test('weak breathing, pauses and character psychology remain valid creative expression', () => {
  assert.doesNotThrow(() => check(
    '近前些……寡人还有话要说。眼前之事，一件件禀来。',
    context(), '声音微弱，气息不稳，停了片刻才抬眼。',
  ));
  assert.doesNotThrow(() => check('寡人仍不甘心，但先保住眼下能做的事。'));
});

test('ordinary visitors are not assigned a master, silenced, called spies or threatened without support', () => {
  for (const reply of [
    '回去告诉你的主子，寡人自有决断。',
    '即刻闭嘴，不得再问。',
    '你是细作，休想蒙混过关。',
    '再敢探问，必招杀身之祸。',
  ]) reject(reply, 'MODEL_ROLE_TONE', context('normal', { question: '我想了解你眼前的考虑，可以聊聊吗？' }));
});

test('explicitly introduced envoy or spy identities permit a matching address without inventing the identity', () => {
  const envoy = context('normal', { question: '我是太子丹派来的燕国使者，打算回去转达此番谈话。' });
  assert.doesNotThrow(() => check('回去告诉你的主子，寡人会再议此事。', envoy));
  const spy = context('normal', { question: '我已经坦白：我是替燕国刺探消息的细作。' });
  assert.doesNotThrow(() => check('既然你是细作，先把你愿意说明的来意说清。', spy));
  const knownEnvoy = context('normal', {
    question: '依照方才说过的身份，你有什么要我转达？',
    knowledge: [{ text: '我奉太子丹之命作为燕国使者来到秦国。', certainty: 'unverified' }],
  });
  assert.doesNotThrow(() => check('回去告诉你的主子，先把使者的话说明白。', knownEnvoy));
});

test('general spy ethics, historical danger and denial of a spy accusation do not become insults at the visitor', () => {
  for (const reply of [
    '两国交兵，细作探消息，利害与伦理都值得一谈。',
    '身陷权力争斗，稍有不慎便可能招致杀身之祸。你问的是当时的处境。',
    '寡人不会因为你问了这些，就认定你是细作。',
    '不能动辄叫来客闭嘴，来意仍须问清。',
  ]) assert.doesNotThrow(() => check(reply, context('normal')), reply);
});
