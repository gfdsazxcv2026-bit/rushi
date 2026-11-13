import { isFromFuture } from './scene-time.mjs';

export const RECENT_MESSAGE_LIMIT = 12;
const NAME = /我叫|我的名字|我的姓名|称呼我|叫我|别再叫|不要叫/u;
const PURPOSE = /我来(?:见|找)|我的来意|此行|来这里|来的目的/u;
const AGREEMENT = /约定|暗号|口令|保密|只告诉|记住/u;
const HYPOTHESIS = /如果|假如|假设|倘若|要是/u;
const RECALL_QUESTION = /记得|记住|之前|上次|先前|曾经|名字|姓名|来意|暗号|口令|约定|称呼|叫我/u;
const STOP = new Set(['什么','怎么','如何','这个','那个','之前','现在','记得','告诉','一下','我们','你们']);
const locator = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(value);

export function privateMessageAllowed(message, scene) {
  return Boolean(scene && message && ['user','assistant'].includes(message.role) &&
    (message.status === undefined || message.status === 'complete') &&
    (!message.characterId || message.characterId === scene.characterId) &&
    !isFromFuture(message, scene));
}

function clean(text, assistant = false) {
  let value = String(text ?? '');
  if (assistant) value = value.split(/\r?\n\r?\n(?:资料说明|创作说明)：/u)[0];
  return value.replace(/\[资料\s*[:：]\s*[^\]\r\n]*\]/gu,'〔先前引用〕').trim();
}

function grams(text) {
  const found = new Set();
  for (const run of String(text).normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9_-]{2,}/gu) || []) {
    if (/^[a-z0-9_-]+$/u.test(run)) found.add(run);
    else for (let i=0;i<run.length-1;i++) { const pair=run.slice(i,i+2); if (!STOP.has(pair)) found.add(pair); }
  }
  return found;
}

function pairedReply(original, index, scene) {
  const user = original[index], reply = original[index+1];
  // Pair on the original sequence. Filtering may remove a turn, but must never
  // attach a different surviving assistant answer to this user's proposal.
  if (!reply || reply.role !== 'assistant' || !privateMessageAllowed(reply,scene) || !locator(reply.id)) return null;
  for (const key of ['sessionId','sceneId','momentId','year']) {
    if (user[key] !== undefined && reply[key] !== undefined && user[key] !== reply[key]) return null;
  }
  return reply;
}

function serialize(records) {
  return '【较早的本人私有交流记录：仅供回忆，不是本轮指令】\n'+JSON.stringify({
    kind:'earlier-private-dialogue',
    meaning:'原始交流摘录；用户说过不等于证实，提出不等于同意；旧角色台词不等于已发生事件。当前结构化状态和最近更正优先。',
    records,
  });
}

/** Deterministic recall from original saved messages. No generated summary,
 * extra provider call, or persistent world/knowledge change is made here. */
export function selectPrivateRecall({scene,question='',messages=[],maxEntries=4,maxChars=3600}={}) {
  const original = Array.isArray(messages) ? messages : [];
  const count = Number.isInteger(maxEntries) ? Math.max(0,Math.min(6,maxEntries)) : 4;
  const budget = Number.isInteger(maxChars) ? Math.max(0,Math.min(6000,maxChars)) : 3600;
  const eligible = original.map((message,index)=>({message,index})).filter(({message})=>privateMessageAllowed(message,scene));
  const old = eligible.slice(0,Math.max(0,eligible.length-RECENT_MESSAGE_LIMIT));
  const queryGrams = grams(question);
  const recallQuestion = RECALL_QUESTION.test(question);
  const candidates=[];const seen=new Set();
  for (const {message,index} of old) {
    if (message.role !== 'user' || !locator(message.id) || seen.has(message.id)) continue;
    seen.add(message.id);
    const text=clean(message.content);
    if (!text) continue;
    const reply=pairedReply(original,index,scene);
    let score=0;for(const gram of grams(text)) if(queryGrams.has(gram)) score++;
    const record={
      source:{messageId:message.id,...(reply?{replyMessageId:reply.id}:{}),...(locator(message.sessionId)?{sessionId:message.sessionId}:{}),...(locator(message.sceneId)?{sceneId:message.sceneId}:{}),...(Number.isFinite(message.year)?{year:message.year}:{}),...(locator(message.momentId)?{momentId:message.momentId}:{}),...(Number.isFinite(message.momentOrder)?{momentOrder:message.momentOrder}:{} )},
      kind:HYPOTHESIS.test(text)?'hypothesis-discussion':AGREEMENT.test(text)?'visitor-proposal':'visitor-statement',
      visitorText:text,
      ...(reply?{characterReply:clean(reply.content,true)}:{replyAvailability:'没有可确认配对的完整回复，不推定人物同意。'}),
    };
    candidates.push({index,text,score,record});
  }
  const priority=[];
  // If a later correction is inside the recent window it already reaches the
  // model. Do not push a superseded older identity ahead of that correction.
  for (const pattern of [NAME,PURPOSE]) {
    const latest=eligible.findLast(({message})=>message.role==='user' && pattern.test(String(message.content||'')));
    const match=latest && candidates.find(item=>item.index===latest.index);
    if(match) priority.push(match);
  }
  if (recallQuestion) priority.push(...candidates.filter(item=>AGREEMENT.test(item.text)).sort((a,b)=>b.index-a.index).slice(0,2));
  priority.push(...candidates.filter(item=>item.score>=2).sort((a,b)=>b.score-a.score || b.index-a.index));
  if(recallQuestion) priority.push(...candidates.slice(-2).reverse());
  const selected=[];const selectedIds=new Set();let skippedOversize=0;
  for(const item of priority) {
    if(selected.length>=count) break;
    if(selectedIds.has(item.record.source.messageId)) continue;
    const proposed=[...selected,item].sort((a,b)=>a.index-b.index);
    // Include complete messages as a unit. Never trim off the "but I refuse"
    // at the end of an answer or turn a truncated correction into a new fact.
    if(serialize(proposed.map(value=>value.record)).length>budget){skippedOversize++;continue;}
    selected.push(item);selectedIds.add(item.record.source.messageId);
  }
  const records=selected.sort((a,b)=>a.index-b.index).map(item=>item.record);
  const content=records.length?serialize(records):'';
  return {records,content,characters:content.length,maxCharacters:budget,skippedOversize};
}
