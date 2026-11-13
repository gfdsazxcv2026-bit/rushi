import { randomUUID } from 'node:crypto';
import { characterIds as characters, characterName, aliases } from './characters.mjs';
import { momentOf, isFromFuture } from './scene-time.mjs';

export class AppError extends Error {
  constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); }
}
export const fail = (status, code, message, details) => { throw new AppError(status, code, message, details); };
const statusValues = ['normal', 'injured', 'critical'];
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const namePattern = [...aliases.keys()].sort((a,b) => b.length-a.length).map(escapeRegExp).join('|');
const namedCharacter = new RegExp(`(${namePattern})`, 'u');
const directCharacter = new RegExp(`(${namePattern})(?:本人)?(?:的)?\\s*(?=(?:现在|目前|此刻|此时|已经|已|仍|正|尚|处于|身受|遭受|被|受伤|重伤|伤|濒|垂|快|将死|未|没|不|并|还|生命|身体|病|获救|脱离|康复|痊愈))`, 'u');
const momentMetadata = scene => ({ momentId: momentOf(scene), ...(Number.isFinite(scene.momentOrder) ? { momentOrder: scene.momentOrder } : {}) });
function statusFromClause(text) {
  const recoveryNegated=/(?:尚未|仍未|还未|没有|并未|并没有|未曾|并非|未能).{0,6}(?:恢复|康复|痊愈|脱离)/u.test(text);
  if (recoveryNegated && /脱离(?:生命)?危险/u.test(text)) return 'critical';
  if (!recoveryNegated && /(已经恢复|已恢复|已经康复|已康复|已经痊愈|已痊愈|身体无恙|没有受伤|未受伤)/u.test(text)) return 'normal';
  if (!recoveryNegated && /脱离(?:生命)?危险/u.test(text)) return 'injured';
  const critical = /(濒死|濒临死亡|垂死|奄奄一息|生命垂危|命在旦夕|危在旦夕|生命危急|快(?:要)?死|将死未死|重伤垂危)/u;
  const notCritical = /(?:没有|不是|并非|不再|不会|未曾).{0,4}(濒死|濒临死亡|垂死|生命垂危)/u.test(text);
  if (critical.test(text) && !notCritical) return 'critical';
  const death = /(已死|死亡|死了|去世|遇害|身亡|刺死|杀死|毒死|死去|驾崩)/u;
  const notDead = /(?:没有|尚未|并未|未曾|不会|不曾|没能|未能|未被|差点|险些|几乎|可能|也许|将要).{0,8}(死|去世|遇害|驾崩)|没死|不死/u.test(text);
  if (death.test(text) && !notDead) return 'dead';
  if (/(受伤|重伤|伤重|中刀|中剑|被刺中|刺伤|中了一刀|中了一剑|中箭)/u.test(text) && !/(没有|未曾|不会|未被|没能|未能).{0,4}(受伤|重伤|刺中|刺伤|中箭)/u.test(text)) return 'injured';
  return null;
}
// A bounded parser for explicit author settings, never for ordinary chat. No secrets are returned.
export function extractPhysicalFacts(text, fallbackCharacterId) {
  const facts = new Map();
  let subject = null;
  const hasNamedCharacter = namedCharacter.test(text);
  for (const clause of String(text).split(/[，,；;。！？!?\n]+/u)) {
    const sentence=clause.trim();
    const direct=sentence.match(directCharacter);
    let status;
    if(direct) {
      const prefix=sentence.slice(0,direct.index);
      if(/听说|得知|以为|认为|猜测|看到|目睹|亲眼|声称|传言|谣言|说|告诉|告知|转告|通知/u.test(prefix)) {subject=null;continue;}
      subject=aliases.get(direct[1]);
      status=statusFromClause(sentence.slice(direct.index+direct[1].length));
    } else {
      if(namedCharacter.test(sentence)) {subject=null;continue;}
      const bare=sentence.replace(/^(?:本段剧情设定为|本段设定为|设定为|设定|假设|当前人物|当前角色|本角色)\s*[：:]?\s*/u,'');
      if(!/^(?:现在|目前|此时|此刻|并且|而且|已经|已|仍|正|尚未|处于|身受|受伤|重伤|伤重|濒死|濒临|垂死|奄奄|生命|命在|危在|快要|快死|将死|身体|伤势|获救|脱离|康复|痊愈|恢复|未受伤|没死|没有|并未|并没有|尚|还)/u.test(bare)) {subject=null;continue;}
      status=statusFromClause(bare);
    }
    const target=subject || (!hasNamedCharacter && characters.includes(fallbackCharacterId)?fallbackCharacterId:null);
    if(target && status && facts.get(target)?.status!=='dead') facts.set(target,{characterId:target,status});
  }
  return [...facts.values()];
}
function conditionFacts(condition) {
  if (condition.type === 'character_dead' && characters.includes(condition.characterId)) return [{characterId:condition.characterId,status:'dead'}];
  if (condition.type === 'character_status' && characters.includes(condition.characterId) && statusValues.includes(condition.status)) return [{characterId:condition.characterId,status:condition.status}];
  if (Array.isArray(condition.physicalFacts)) return condition.physicalFacts.filter(f=>characters.includes(f.characterId) && [...statusValues,'dead'].includes(f.status));
  // Read compatibility for old custom settings. Do not rewrite their original text or records.
  return ['custom','not_unified'].includes(condition.type) ? extractPhysicalFacts(condition.text || '') : [];
}
export function getCharacterStatus(state, scene) {
  const characterId = typeof scene === 'string' ? scene : scene.characterId;
  if (!characters.includes(characterId)) fail(400, 'INVALID_CHARACTER', '请选择已登记的人物。');
  const time = typeof scene === 'object' ? scene : state;
  const overrides = state.overrides || {};
  const aliveKey = `${characterId}_alive`;
  const baseline = typeof scene === 'object' && typeof scene.worldFacts?.[aliveKey] === 'boolean' ? scene.worldFacts[aliveKey] : state.world?.[aliveKey];
  let alive = typeof overrides[aliveKey] === 'boolean' ? overrides[aliveKey] : baseline !== false;
  let condition = statusValues.includes(overrides[`${characterId}_condition`]) ? overrides[`${characterId}_condition`] : 'normal';
  let sourceConditionIds = [];
  for (const record of state.conditions || []) {
    if (isFromFuture(record,time)) continue;
    for (const fact of conditionFacts(record)) {
      if (fact.characterId !== characterId) continue;
      if (fact.status === 'dead') { alive=false; sourceConditionIds=record.id?[record.id]:[]; }
      else if (alive) { condition=fact.status; sourceConditionIds=record.id?[record.id]:[]; }
    }
  }
  return { condition, alive, sourceConditionIds };
}
export function canonicalWorld(scene) {
  return { ...Object.fromEntries(characters.map(id=>[`${id}_alive`,true])), unified: scene.chapterId !== 'jingke', ...(scene.worldFacts || {}) };
}
export function assertScene(scene, state) {
  if (!characters.includes(scene.characterId)) fail(400, 'INVALID_CHARACTER', '请选择已登记的人物。');
  const world = { ...canonicalWorld(scene), ...state.overrides };
  for (const id of characters) world[`${id}_alive`] = getCharacterStatus(state,{...scene,characterId:id}).alive;
  const required = { ...(scene.required || {}), [`${scene.characterId}_alive`]: true };
  const labels = { ...Object.fromEntries(characters.map(id=>[`${id}_alive`,`${characterName(id)}存活`])), unified: '统一已经完成' };
  const conflicts = Object.entries(required).filter(([key, value]) => world[key] !== value)
    .map(([key, expected]) => ({ key, expected, actual: world[key], message: `${labels[key] || key}：当前设定与场景前提不一致` }));
  if (conflicts.length) fail(409, 'SCENE_CONFLICT', '当前剧情不满足这个场景的前提。请换兼容人物，调整设定后另建分支，或从史实重开。', conflicts);
  return world;
}
export function initialState(scene, inherited) {
  if (inherited && scene.year < inherited.year) fail(409, 'TIME_CONFLICT', '不能把未来快照带回较早场景。请恢复旧会话或从本章史实开始。');
  if (inherited && scene.year === inherited.year && inherited.momentId && momentOf(inherited) !== momentOf(scene)) fail(409, 'TIME_CONFLICT', '同一年中的不同事件阶段不能直接继承剧情。请恢复原阶段的会话，或从目标阶段史实开始。');
  if (inherited && scene.year > inherited.year) {
    const unresolved=characters.filter(id=>{const status=getCharacterStatus(inherited,id);return status.alive && status.condition==='critical';});
    if(unresolved.length) fail(409,'SCENE_CONFLICT','来源时点仍有人处于濒死状态，跨年后的生死或恢复结果尚未明确。请先在来源分支明确结果，或从本章史实重开。',unresolved.map(id=>({key:`${id}_critical_time_gap`,message:`${characterName(id)}的濒死状态尚未交代结果，不能默认多年后已经恢复。`})));
    if(inherited.world?.unified===false && !getCharacterStatus(inherited,'yingzheng').alive && scene.required?.unified===true && inherited.overrides?.unified!==true) fail(409,'SCENE_CONFLICT','来源分支中嬴政在统一前已经死亡，无法直接采用下一章“统一已完成”的历史前提。请明确新的背景，或从本章史实重开。');
  }
  const state = inherited ? structuredClone(inherited) : { conditions: [], events: [], knowledge: [], overrides: {}, mode: 'historical' };
  state.year = scene.year;
  state.momentId = momentOf(scene);
  if (Number.isFinite(scene.momentOrder)) state.momentOrder = scene.momentOrder;
  else delete state.momentOrder;
  state.world = assertScene(scene, state);
  return state;
}
export function adoptCondition(state, scene, input) {
  const text = String(input.text || '').trim();
  if (!text || text.length > 500) fail(400, 'INVALID_CONDITION', '剧情设定请填写 1～500 字。');
  let type = input.type || 'custom';
  let characterId = input.characterId, status = input.status;
  if (!['custom', 'character_dead', 'character_status', 'not_unified'].includes(type)) fail(400, 'INVALID_CONDITION', '不支持的设定类型。');
  if (characterId !== undefined && !characters.includes(characterId)) fail(400, 'INVALID_CHARACTER', '请选择已登记的人物。');
  const notUnified=type==='not_unified' || (type==='custom' && /(未能统一|没有统一|尚未统一|统一没有发生)/u.test(text));
  let physicalFacts = type==='custom'?extractPhysicalFacts(text,scene.characterId):[];
  if(type==='custom' && physicalFacts.length===1) {characterId=physicalFacts[0].characterId;status=physicalFacts[0].status;type=status==='dead'?'character_dead':'character_status';}
  if(type==='character_status') {
    if(!characters.includes(characterId) || !statusValues.includes(status)) fail(400,'INVALID_CHARACTER_STATUS','请选择有效人物及受伤、濒死或恢复状态。');
    physicalFacts=[{characterId,status}];
  }
  if(type==='character_dead') physicalFacts=[{characterId,status:'dead'}];
  if (type === 'custom' && /(未能统一|没有统一|尚未统一|统一没有发生)/u.test(text)) type = 'not_unified';
  if (type === 'character_dead' && !characters.includes(characterId)) fail(400, 'INVALID_CHARACTER', '请选择有效人物。');
  const next = structuredClone(state);
  next.overrides ||= {};
  for(const fact of physicalFacts) {
    if(fact.status!=='dead' && !getCharacterStatus(state,{...scene,characterId:fact.characterId}).alive) fail(409,'SCENE_CONFLICT','已经死亡的人物不能通过恢复伤势直接复活。请从较早快照另开分支或从史实重开。');
    if(fact.status==='dead') next.overrides[`${fact.characterId}_alive`]=false;
    else next.overrides[`${fact.characterId}_condition`]=fact.status;
  }
  if (type === 'character_dead') next.overrides[`${characterId}_alive`] = false;
  if (notUnified) next.overrides.unified = false;
  const now = new Date().toISOString();
  const condition = { id: randomUUID(), text, type, ...(characterId ? { characterId } : {}), ...(type==='character_status'?{status}:{}), ...(physicalFacts.length?{physicalFacts}:{}), source: '用户明确采用', year: scene.year, ...momentMetadata(scene), createdAt: now, visibleTo: input.knownToCurrent === true ? [scene.characterId] : [] };
  next.conditions.push(condition);
  next.events.push({ id: randomUUID(), text: `采用条件：${text}`, type: 'adopted_condition', source: condition.id, year: scene.year, ...momentMetadata(scene), createdAt: now, visibleTo: [...condition.visibleTo] });
  if (input.knownToCurrent === true) next.knowledge.push({ characterId: scene.characterId, text, year: scene.year, ...momentMetadata(scene), channel: '作者明确设定当前角色已知', certainty: 'adopted', source: condition.id, createdAt: now });
  next.mode = 'hypothetical';
  next.world = { ...canonicalWorld(scene), ...next.overrides };
  for (const id of characters) next.world[`${id}_alive`] = getCharacterStatus(next,{...scene,characterId:id}).alive;
  return next;
}
export function recordUserClaim(state, scene, text, source) {
  const next = structuredClone(state);
  // Chat is a received claim, never an authoritative world edit.
  const onlyQuestion = /(?:是否|有没有|会不会|是不是真的|可曾)/u.test(text) && !/(?:我告诉|我得知|我收到|现已|确已)/u.test(text);
  if (/(已经|已死|死了|死亡|去世|遇害|受伤|重伤|濒死|垂危|统一|收到|消息|告诉|通知|未来|后来)/u.test(text) && !/(如果|假如|假设|要是|倘若|会怎样|会如何)/u.test(text) && !onlyQuestion) {
    next.knowledge.push({ characterId: scene.characterId, text: `用户告知：${text}`, year: scene.year, ...momentMetadata(scene), channel: '用户当面告知', certainty: 'unverified', source, createdAt: new Date().toISOString() });
  }
  return next;
}
