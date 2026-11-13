import { buildRolePrompt, dialogueIntent } from './role-prompt.mjs';
import { evidenceGap } from './evidence.mjs';
import { isFromFuture } from './scene-time.mjs';
import { selectPrivateRecall, privateMessageAllowed, RECENT_MESSAGE_LIMIT } from './private-recall.mjs';
/** Small, inspectable lexical retrieval. No external embedding service is used. */
const STOP = new Set(['什么', '怎么', '如何', '为何', '为什么', '如果', '假如', '假设', '是否', '可以', '能否', '告诉', '知道', '现在', '这个', '那个', '之前', '之后', '你是', '我是', '一下', '有没有', '能不能']);
const HYPOTHESIS = /如果|假如|假设|倘若|要是/u;

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function grams(value) {
  const text = normalized(value);
  const result = new Set();
  for (const word of text.match(/[a-z0-9_-]{2,}/g) ?? []) result.add(word);
  for (const run of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let i = 0; i < run.length - 1; i++) {
      const part = run.slice(i, i + 2);
      if (!STOP.has(part)) result.add(part);
    }
  }
  return result;
}

function validForRole(source, scene) {
  return source?.published === true && source?.roleVisible === true &&
    Array.isArray(source.sceneIds) && source.sceneIds.includes(scene?.id) &&
    Number.isFinite(source.eventYear) && Number.isFinite(scene?.year) &&
    source.eventYear <= scene.year && typeof source.excerpt === 'string' &&
    source.excerpt.trim().length > 0 && typeof source.id === 'string';
}

export function retrieve({ question = '', scene, sources = [], limit = 3 } = {}) {
  if (!scene || scene.status === 'draft') return [];
  const max = Math.max(0, Math.min(6, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 3));
  if (!max) return [];
  const query = normalized(question);
  const queryGrams = grams(query);
  // A visitor can ask about "what just happened" without repeating the event's
  // name. The already-visible scene title supplies a retrieval topic only for
  // event-overview questions; it is never evidence and grants no source access.
  const overview = /经过|过程|关键动作|关键经过|亲历|如何脱险|怎么失败|(?:刚才|方才).{0,8}发生|确认.{0,8}(?:消息|事项)|(?:宫中|朝堂|朝廷).{0,8}消息/u.test(query);
  const eligible = sources.filter(source => validForRole(source, scene));
  const eligibleIds = new Set(eligible.map(source => source.id));
  const hasEventAnchor = eligible.some(source =>
    (source.relatedSourceIds || []).some(id => eligibleIds.has(id)) &&
    (source.keywords || []).some(keyword => {
      const key = normalized(keyword);
      return key.length >= 2 && !STOP.has(key) && query.includes(key);
    }));
  // Keep an explicit event topic (for example 征楚) ahead of broad scene words
  // such as 统一. Use the title only when the query has no connected anchor.
  const topic = overview && !hasEventAnchor ? normalized(scene.title) : '';
  const keywordFrequency = new Map();
  for (const source of eligible) for (const keyword of new Set((source.keywords || []).map(normalized))) keywordFrequency.set(keyword, (keywordFrequency.get(keyword) || 0) + 1);
  const ranked = [];
  for (const source of eligible) {
    const textGrams = grams([source.excerpt, ...(source.keywords ?? [])].join(' '));
    let score = 0;
    for (const gram of queryGrams) if (textGrams.has(gram)) score += .5;
    for (const keyword of source.keywords ?? []) {
      const key = normalized(keyword);
      if (key.length >= 2 && !STOP.has(key) && (query.includes(key) || topic.includes(key))) {
        const specificity = 1 + Math.log((eligible.length + 1) / ((keywordFrequency.get(key) || 1) + 1));
        // An explicit question match retains full weight. Scene-title matches
        // only help locate the event chain behind broad words such as 殿上.
        score += (6 + Math.min(key.length, 4)) * specificity * (query.includes(key) ? 1 : .65);
      }
    }
    if (score > 0) ranked.push({ ...source, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  // A sequence question needs connected passages, not just the entry into a
  // scene. Links live in content configuration and still pass every role gate.
  const sequence = overview || /后.{0,8}发生|为何|为什么|理由|主张|哪里|何处|多少|地点|兵力|任务|谋划|交付/u.test(query);
  if (!sequence || !ranked.length) return ranked.slice(0, max);
  const byId = new Map(eligible.map(source => [source.id, source]));
  const first = ranked[0];
  const ordered = [first, ...(first.relatedSourceIds || []).map(id => byId.get(id)).filter(Boolean).map(source => ({ ...source, score: ranked.find(item => item.id === source.id)?.score || 0 })), ...ranked.slice(1)];
  return [...new Map(ordered.map(source => [source.id, source])).values()].slice(0, max);
}

function explicitlyVisible(record, scene) {
  const visible = [...(Array.isArray(record?.visibleTo) ? record.visibleTo : []), ...(Array.isArray(record?.knownBy) ? record.knownBy : [])];
  if (!visible.includes(scene.characterId)) return false;
  return !isFromFuture(record,scene);
}

function limitedText(record, limit = 600) {
  return String(typeof record === 'string' ? record : record?.text ?? record?.description ?? '').slice(0, limit);
}

function safeRoleRecords(records, scene) {
  return records.filter(record => explicitlyVisible(record, scene)).slice(-20).map(record => ({
    text: limitedText(record),
    source: String(record.source ?? '当前互动').slice(0, 120),
    certainty: String(record.certainty ?? '已明确采用').slice(0, 80),
    year: Number.isFinite(record.year) ? record.year : scene.year,
  })).filter(record => record.text);
}

function ownCharacterStatus(status, scene) {
  // This narrow server-owned field conveys bodily awareness, not the author
  // condition's text, attacker, witnesses, or any other character's knowledge.
  const supplied = status && (!status.characterId || status.characterId === scene.characterId) ? status : {};
  return {
    condition: ['normal', 'injured', 'critical'].includes(supplied.condition) ? supplied.condition : 'normal',
    alive: supplied.alive !== false,
    sourceConditionIds: Array.isArray(supplied.sourceConditionIds) ? supplied.sourceConditionIds.filter(id => typeof id === 'string').slice(-20).map(id => id.slice(0, 100)) : [],
  };
}

export function buildRoleContext({ scene, question = '', sources = [], conditions = [], events = [], knowledge = [], messages = [], mode = 'historical', characterStatus } = {}) {
  if (!scene?.id || !scene.characterId || !Number.isFinite(scene.year)) throw new TypeError('场景必须包含 id、characterId 和 year。');
  const visibleConditions = safeRoleRecords(conditions, scene);
  const visibleEvents = safeRoleRecords(events, scene);
  const ownKnowledge = knowledge.filter(record => record.characterId === scene.characterId && !isFromFuture(record,scene)).slice(-24).map(record => ({
    text: limitedText(record),
    channel: String(record.channel ?? '用户告知').slice(0, 80),
    certainty: String(record.certainty ?? '未确认').slice(0, 80),
    source: String(record.source ?? '当前会话').slice(0, 120),
    characterId: scene.characterId,
  })).filter(record => record.text);
  const ownRecent = messages.filter(message => privateMessageAllowed(message,scene)).slice(-RECENT_MESSAGE_LIMIT);
  const privateRecall = selectPrivateRecall({scene,question,messages});
  const discussedHypotheses=[];
  let previousUser='';
  const recent=ownRecent.map(message=>{
    const storedContent=String(message.content ?? '').slice(0,4000);
    const content=message.role==='assistant' ? storedContent.split(/\n\n资料说明：/u)[0].replace(/\[资料\s*[:：]\s*[^\]\r\n]*\]/gu,'〔先前资料引用〕') : storedContent;
    if(message.role==='user') {previousUser=content;if(HYPOTHESIS.test(content)) discussedHypotheses.push(content.slice(0,500));return {role:'user',content};}
    if(HYPOTHESIS.test(previousUser)) return {role:'assistant',content:`【往轮临时假设讨论记录】上轮问句中的新增条件只在那轮设想内有效，除非下方当前状态另有明确采用记录；人物到场、救治或通知不能从以下演绎升级为已经发生。\n${content}`};
    const earlier = Number.isFinite(message.year) && message.year < scene.year;
    return {role:'assistant',content:earlier ? `【此前${message.year < 0 ? '前'+Math.abs(message.year) : message.year}年的交流，不是此刻刚发生】\n${content}` : content};
  });
  const userQuestion = String(question).slice(0, 4000);
  const followupEvidence = /^(这些|这段|刚才|你刚才|你说|上面).*(依据|出处|原文|资料)/u.test(userQuestion);
  const previousQuestion = ownRecent.filter(message=>message.role==='user' && message.content!==userQuestion).at(-1)?.content || '';
  // Personal introductions and agreements need this visitor's conversation,
  // rather than unrelated political history triggered by a stated purpose.
  const selected = dialogueIntent(userQuestion)==='memory' ? [] : retrieve({ question: followupEvidence ? `${previousQuestion}\n${userQuestion}` : userQuestion, scene, sources, limit: 4 });
  if (recent.at(-1)?.role !== 'user' || recent.at(-1).content !== userQuestion) recent.push({ role: 'user', content: userQuestion });
  if (privateRecall.content) recent.unshift({role:'user',content:privateRecall.content});
  const currentCharacterStatus = ownCharacterStatus(characterStatus, scene);
  const materialGaps=(scene.materialGaps||[]).filter(gap=>new RegExp(gap.questionPattern,'u').test(userQuestion)).map(gap=>gap.text);
  const historicalFacts = (scene.knownFacts ?? []).slice(0, 16).map(fact => limitedText(fact, 500)).filter(Boolean);
  const system = buildRolePrompt({ scene, question:userQuestion, mode, characterStatus:currentCharacterStatus,
    conditions:visibleConditions, events:visibleEvents, knowledge:ownKnowledge, facts:historicalFacts,
    sources:selected, discussedHypotheses });
  return { system, citationPolicy: 'source-quotes-v1', evidencePolicy:'claim-links-v1', materialGaps, evidenceGap:evidenceGap(userQuestion,selected), privateRecall, messages: recent, sources: selected, scene, characterStatus: currentCharacterStatus, conditions: visibleConditions, events: visibleEvents, knowledge: ownKnowledge, question: userQuestion, mode: mode === 'hypothetical' ? 'hypothetical' : 'historical' };
}
