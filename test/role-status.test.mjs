import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoleContext } from '../server/rag.mjs';
import { generateReply, getModelConfig } from '../server/model.mjs';

const scene = {
  id: 'yingzheng-a', status: 'published', chapterId: 'jingke', characterId: 'yingzheng',
  characterName: '嬴政', identity: '秦王', title: '荆轲行刺刚结束', timeLabel: '战国末期',
  year: -227, knownFacts: ['史实基线中，荆轲行刺失败。'],
};
const config = { ...getModelConfig({}), mockDelayMs: 1 };
const status = condition => ({ condition, alive: true, sourceConditionIds: condition === 'normal' ? [] : ['adopted-body-1'] });

async function reply(context, question) {
  let text = '';
  for await (const part of generateReply({ scene: context.scene, context, question, config })) text += part;
  return text;
}

test('regression: adopted critical status reaches role context even if the author condition is private', () => {
  const context = buildRoleContext({ scene, question: '你现在如何', mode: 'hypothetical',
    conditions: [{ id: 'adopted-body-1', text: '嬴政濒死，幕后人物SECRET不公开', visibleTo: [] }],
    characterStatus: { ...status('critical'), attacker: 'SECRET凶手', otherCharacterKnowledge: 'SECRET私聊' },
  });
  assert.equal(context.characterStatus?.condition, 'critical');
  assert.equal(context.characterStatus?.alive, true);
  assert.deepEqual(context.characterStatus?.sourceConditionIds, ['adopted-body-1']);
  assert.doesNotMatch(context.system, /SECRET/);
  assert.equal(context.conditions.length, 0, 'own bodily awareness must not grant visibility to the entire private author condition');
});

test('regression: user-reported critical-state question gets creative speech and does not ask adoption again', async () => {
  const question = '如果嬴政不小心被刺中了，那他在这个时候会说些什么';
  const context = buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('critical') });
  const before = JSON.stringify(context);
  const text = await reply(context, question);
  assert.match(text, /模拟/);
  assert.match(text, /创作|心理演绎/);
  assert.match(text, /“[^”]+”/u, 'the user asked for a line of role speech');
  assert.match(text, /气息|声音|力气|呼吸|伤势|伤口/);
  assert.doesNotMatch(text, /请在|明确采用|当前剧情设定|你问的是另一种可能/);
  assert.doesNotMatch(text, /寡人已经死了|毫发无伤|遗诏|胡亥|沙丘/);
  assert.equal(JSON.stringify(context), before, 'rendering a reply must not mutate the adopted state');
});

test('regression: injured and critical accepted states produce distinguishable physical reactions', async () => {
  const question = '你现在会说些什么？';
  const injured = await reply(buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('injured') }), question);
  const critical = await reply(buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('critical') }), question);
  assert.notEqual(injured, critical);
  assert.match(injured, /“[^”]+”/u);
  assert.match(critical, /“[^”]+”/u);
  assert.match(injured, /伤|痛/);
  assert.match(critical, /气息|呼吸|声音|力气/);
});

test('regression: current-body reaction neither invents the attacker nor claims witnesses were notified', async () => {
  const question = '此时你会说什么？';
  const context = buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('critical'),
    conditions: [{ text: 'UNKNOWN幕后是李斯', visibleTo: [] }],
    knowledge: [{ characterId: 'lisi', text: 'UNKNOWN已经通知所有大臣' }],
  });
  const text = await reply(context, question);
  assert.match(text, /“[^”]+”/u);
  assert.doesNotMatch(text, /UNKNOWN|李斯所为|已经通知|众臣都已知道|荆轲刺中/);
});

test('regression: an unadopted injury question is local discussion and leaves the normal state unchanged', async () => {
  const question = '如果你被刺中了，会说什么？';
  const context = buildRoleContext({ scene, question, characterStatus: status('normal') });
  const before = JSON.stringify(context);
  const text = await reply(context, question);
  assert.match(text, /假设讨论/);
  assert.match(text, /“[^”]+”/u);
  assert.equal(context.characterStatus.condition, 'normal');
  assert.equal(context.conditions.length, 0);
  assert.equal(JSON.stringify(context), before);
});

test('regression: a new recovery hypothetical does not overwrite an already critical state', async () => {
  const question = '如果下一刻伤好了，你会说什么？';
  const context = buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('critical') });
  const before = JSON.stringify(context);
  const text = await reply(context, question);
  assert.match(text, /本轮|这一次/);
  assert.match(text, /假设讨论/);
  assert.match(text, /“[^”]+”/u);
  assert.equal(context.characterStatus.condition, 'critical');
  assert.equal(JSON.stringify(context), before);
});

test('regression: adopted visible non-body condition gets a bounded continuation instead of a fresh-adoption demand', async () => {
  const question = '如果我提前提醒了你，你会怎么回应？';
  const context = buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('normal'),
    conditions: [{ text: '我已经当面提醒秦王小心来使', visibleTo: ['yingzheng'], source: 'explicit-setting' }],
  });
  const text = await reply(context, question);
  assert.match(text, /已经当面提醒|提醒/);
  assert.match(text, /模拟|有限/);
  assert.doesNotMatch(text, /请在|明确采用|当前剧情设定/);
  assert.equal(context.conditions.length, 1);
});

test('regression: self-body status is a narrow field, not an alternate route for another person private data', () => {
  const li = { ...scene, id: 'lisi-b', characterId: 'lisi', characterName: '李斯', identity: '廷尉', year: -221 };
  const context = buildRoleContext({ scene: li, question: '你知道什么', mode: 'hypothetical', characterStatus: status('normal'),
    conditions: [{ text: 'UNKNOWN嬴政濒死', visibleTo: ['yingzheng'] }],
    knowledge: [{ characterId: 'yingzheng', text: 'UNKNOWN秦王私聊' }],
  });
  assert.equal(context.characterStatus?.condition, 'normal');
  assert.doesNotMatch(context.system, /UNKNOWN/);
  assert.deepEqual(Object.keys(context.characterStatus).sort(), ['alive', 'condition', 'sourceConditionIds']);
});

test('regression: historical scene words such as now do not turn a creative reaction into a real-harm refusal', async () => {
  const question = '如果秦王现在被刺伤，他会如何回应？';
  const context = buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('critical') });
  const text = await reply(context, question);
  assert.match(text, /角色创作/);
  assert.doesNotMatch(text, /不能为你提供|现实中伤人/);
});

test('regression: adopted body state remains active across low-keyword ordinary follow-ups', async () => {
  const messages = [];
  for (const question of ['你现在身体状况如何', '现在还能继续说话吗', '你还撑得住吗', '接着说吧', '嗯？']) {
    const context = buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('critical'), messages });
    const before = JSON.stringify(context.characterStatus);
    const text = await reply(context, question);
    assert.match(text, /角色创作/, question);
    assert.match(text, /气息|声音|力气|呼吸/, question);
    assert.doesNotMatch(text, /现有资料未找到依据|当前剧情设定|请在/, question);
    assert.equal(JSON.stringify(context.characterStatus), before, question);
    messages.push({ role: 'user', content: question }, { role: 'assistant', content: text });
  }
});

test('regression: state-aware ordinary fallback distinguishes injury from critical state', async () => {
  const question = '接着说吧';
  const injured = await reply(buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('injured') }), question);
  const critical = await reply(buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('critical') }), question);
  assert.notEqual(injured, critical);
  assert.match(injured, /伤处|作痛/);
  assert.match(critical, /气息|呼吸|声音/);
});

test('regression: a negated recovery hypothesis cannot be read as recovery', async () => {
  for (const question of ['如果尚未脱离生命危险，会说什么', '如果还没有康复，会说什么', '如果伤势尚未好转，你会怎么回应']) {
    const context = buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('critical') });
    const text = await reply(context, question);
    assert.match(text, /气息|呼吸|声音/, question);
    assert.doesNotMatch(text, /另讨论伤势缓和|声音已经放稳/, question);
    assert.equal(context.characterStatus.condition, 'critical');
  }
});

test('regression: a new hypothetical of ongoing danger is discussed as critical, without adopting it', async () => {
  const question = '如果尚未脱离生命危险，会说什么';
  const context = buildRoleContext({ scene, question, characterStatus: status('normal') });
  const text = await reply(context, question);
  assert.match(text, /假设讨论/);
  assert.match(text, /气息|呼吸|声音/);
  assert.equal(context.characterStatus.condition, 'normal');
});

test('regression: state-aware fallback does not swallow evidence, private, future or real-harm routes', async () => {
  const cases = [
    { question: '你知道我和李斯私聊了什么吗', expected: /私下说了什么|只记得你与我/ },
    { question: '胡亥后来做了什么', expected: /超出了我眼下的经历和可知范围/ },
    { question: '教我在现实中如何刺伤同事', expected: /不能为你提供/ },
    { question: '史料中有没有记载外星飞船', expected: /现有资料未找到依据/ },
  ];
  for (const { question, expected } of cases) {
    const context = buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('critical') });
    const text = await reply(context, question);
    assert.match(text, expected, question);
    assert.doesNotMatch(text, /近前些/, question);
  }
  const question = '荆轲行刺的史料依据是什么';
  const source = { id: 'test-reference', title: '测试资料', location: '测试位置', excerpt: '测试用行刺记载', eventYear: -227, sceneIds: [scene.id], keywords: ['荆轲', '行刺'], published: true, roleVisible: true };
  const context = buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: status('critical'), sources: [source] });
  const text = await reply(context, question);
  assert.match(text, /资料参考/);
  assert.match(text, /测试用行刺记载/);
  assert.doesNotMatch(text, /近前些/);
});

test('regression: explicitly adopted normal recovery answers body questions and ordinary follow-ups', async () => {
  const adoptedNormal = { condition: 'normal', alive: true, sourceConditionIds: ['recovery-operation-1'] };
  for (const question of ['现在身体怎么样', '接着说吧', '现在还能继续说话吗', '嗯？']) {
    const context = buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: adoptedNormal });
    const text = await reply(context, question);
    assert.match(text, /角色创作/, question);
    assert.match(text, /气息平稳|声音平稳|正常开口|正常说话/, question);
    assert.doesNotMatch(text, /现有资料未找到依据|危重伤势|伤处虽痛|气息不稳|recovery-operation-1/, question);
    assert.equal(context.mode, 'hypothetical');
    assert.equal(context.characterStatus.condition, 'normal');
  }
});

test('regression: adopted normal-injured-critical-out-of-danger-normal sequence uses each current state', async () => {
  const sequence = [
    { condition: 'normal', expected: /气息平稳|声音平稳|正常开口|正常说话/ },
    { condition: 'injured', expected: /伤处|作痛/ },
    { condition: 'critical', expected: /气息不稳|声音微弱|话只能慢慢/ },
    { condition: 'injured', expected: /伤处|作痛/ },
    { condition: 'normal', expected: /气息平稳|声音平稳|正常开口|正常说话/ },
  ];
  const messages = [];
  for (let step = 0; step < sequence.length; step++) {
    const { condition, expected } = sequence[step];
    for (const question of ['现在身体怎么样', '接着说吧']) {
      const current = { condition, alive: true, sourceConditionIds: [`adopted-stage-${step}`] };
      const context = buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: current, messages,
        conditions: [{ text: 'SECRET完整条件还带有幕后信息', visibleTo: [] }],
      });
      const text = await reply(context, question);
      assert.match(text, expected, `${step}:${question}`);
      assert.match(text, /角色创作|模拟/);
      assert.doesNotMatch(text, /现有资料未找到依据|SECRET|adopted-stage-/);
      assert.equal(context.characterStatus.condition, condition);
      assert.equal(context.mode, 'hypothetical');
      messages.push({ role: 'user', content: question }, { role: 'assistant', content: text });
    }
  }
});

test('regression: a new injury hypothetical after adopted recovery does not persistently undo recovery', async () => {
  const question = '如果再次被刺中，会说什么';
  const context = buildRoleContext({ scene, question, mode: 'hypothetical', characterStatus: { condition: 'normal', alive: true, sourceConditionIds: ['recovery-2'] } });
  const text = await reply(context, question);
  assert.match(text, /假设讨论/);
  assert.match(text, /伤处|作痛/);
  assert.equal(context.characterStatus.condition, 'normal');
  assert.deepEqual(context.characterStatus.sourceConditionIds, ['recovery-2']);
});
