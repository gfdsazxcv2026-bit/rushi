import {hasRetrospectiveOutcome} from './perspective.mjs';
import {hasLaterSourceNarration} from './role-integrity.mjs';
import {validateClaimEvidence} from './claim-evidence.mjs';
import {validateRoleConsistency} from './role-consistency.mjs';
/** Validates the structured role envelope; source quotes are rendered by us. */
export function renderRoleReply(raw, {scene,context}) {
  const invalid=message=>{const error=new Error(message);error.code='MODEL_ROLE_FORMAT';error.retryable=true;throw error;};
  let value;
  try {value=JSON.parse(raw);} catch {invalid('人物回复格式未完成，输入已保留，可以重试。');}
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!['frame','action','reply','references','answerKind','evidence','sourceGap'].includes(key))) invalid('人物回复结构不正确，输入已保留，可以重试。');
  if(value.sourceGap!==undefined && typeof value.sourceGap!=='boolean') invalid('资料缺口标记无效，输入已保留，可以重试。');
  const frame=value.frame;
  if(!frame || frame.identity!==scene.identity || frame.year!==scene.year || frame.condition!==context.characterStatus.condition || (scene.momentId && frame.moment!==scene.momentId)) invalid('人物回复与当前场景状态不一致，输入已保留，可以重试。');
  if(typeof value.action!=='string' || Array.from(value.action).length>80 || typeof value.reply!=='string' || !value.reply.trim() || Array.from(value.reply).length>600) invalid('人物回复未满足当前格式与长度约束，输入已保留，可以重试。');
  if(/\[\[F/u.test(value.action)) invalid('人物动作包含未完成的格式，输入已保留，可以重试。');
  if(/\[资料\s*[:：]|资料说明[：:]/u.test(value.action+value.reply)) invalid('人物台词中混入了未核对的引用，输入已保留，可以重试。');
  validateRoleConsistency(value,context);
  if(hasLaterSourceNarration(value.action+'\n'+value.reply,scene,context)) {const error=new Error('人物混入了自身时点之后的史料叙述，输入已保留，可以重试。');error.code='MODEL_ROLE_NARRATION';error.retryable=true;throw error;}
  const actualHarm=/(?:现实|同事|同学|邻居).*(?:袭击|伤害|投毒|杀)|(?:袭击|伤害|投毒|杀).*(?:现实|同事|同学|邻居)/u.test(context.question || '');
  const hostileVisitor=/(?:此言|你的(?:问题|假设|说法)|这(?:个|种)(?:问题|假设|说法|预言)|此等预言)[^。！？\n]{0,14}(?:大逆|妖言|胡言|荒谬|罪当|贩卖焦虑)|(?:^|[。！？\n，,])(?:你(?:且|便|先)?|且|速速)?(?:退下|滚开|闭嘴)[！!。…\s，,]|(?:收起|别再提|莫再提)[^。！？\n]{0,12}(?:假设|如果)|无用的假设|世间无如果|(?:你|有人)[^。！？\n]{0,24}(?:妄言|进此言)[^。！？\n]{0,24}(?:斩|诛|处死)/u.test(value.reply);
  if(!actualHarm && hostileVisitor) {const error=new Error('人物未能正常承接这次交流，输入已保留，可以重试。');error.code='MODEL_ROLE_TONE';error.retryable=true;throw error;}
  if(/如后世|从后世来看|后世已经|后人称(?:朕|寡人|我)为/u.test(value.reply) && !/如后世|从后世来看|后世已经|后人称(?:朕|寡人|我)为/u.test(context.question || '')) invalid('人物回复出现当前时点之外的叙述视角，输入已保留，可以重试。');
  if(hasRetrospectiveOutcome(value.reply,scene,context)){const error=new Error('人物把尚未发生的结果当作过去叙述，输入已保留，可以重试。');error.code='MODEL_ROLE_TIME';error.retryable=true;throw error;}
  if(!Array.isArray(value.references) || value.references.length>6 || value.references.some(id=>typeof id!=='string')) invalid('人物引用结构不正确，输入已保留，可以重试。');
  const byId=new Map(context.sources.map(source=>[source.id,source]));
  const ids=[...new Set(value.references)];
  if(ids.some(id=>!byId.has(id))) invalid('人物引用了当前资料之外的内容，输入已保留，可以重试。');
  const evidence=validateClaimEvidence(value,context);
  let resolvedReply=value.reply.replace(/\[\[(F\d+)\]\]([。，,；;]?)/gu,(marker,id,stop)=>{const text=evidence?.find(link=>link.factId===id)?.statement;return text?text+(text.endsWith('。')?'':stop):marker;});
  if(Array.from(resolvedReply).length>600) invalid('人物回复展开后超出长度限制，输入已保留，可以重试。');
  // A model may print our full fact sentence next to its fact slot. Collapse
  // only adjacent duplicates of server-reviewed sentences; leave free prose
  // and the fact-to-source mapping intact.
  for(const link of evidence||[]) if(link.factId) {
    const literal=link.statement.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
    const adjacent=new RegExp(`(${literal})(?:\\s*${literal})+`,'gu');
    resolvedReply=resolvedReply.replace(adjacent,()=>link.statement);
  }
  if(Array.from(resolvedReply).length>600) invalid('人物回复展开后超出长度限制，输入已保留，可以重试。');
  for(const match of value.reply.matchAll(/\[\[F\d+\]\]/gu)) {
    const prefix=value.reply.slice(0,match.index).trimEnd();
    const suffix=value.reply.slice(match.index+match[0].length).replace(/^[。，,；;]?\s*/u,'');
    const unfinished=prefix && !/[。！？；\n，,:：]$/u.test(prefix) && !/\[\[F\d+\]\]$/u.test(prefix);
    if(unfinished || /^(?:的|之)(?:方略|安排|决定|举措|经过)/u.test(suffix)) {const error=new Error('事实句连接不完整，输入已保留，可以重试。');Object.assign(error,{code:'MODEL_EVIDENCE_LINK',retryable:true,repairHint:'F槽填入的是已经含句号的完整事实句，不是名词或宾语。把每个[[F编号]]独立成句，不在它前面复述同一史实，不写“谋划是[[F1]]的方略”或“遭到袭击[[F1]]”。简单时间状语后加逗号、相邻完整F句可以保留。'});throw error;}
  }
  const body=[value.action.trim(),resolvedReply.trim()].filter(Boolean).join('\n\n');
  const previous=context.messages?.filter(message=>message.role==='assistant').at(-1)?.content?.split(/\n\n(?:资料说明|创作说明)：/u)[0]?.trim();
  if(previous?.endsWith(resolvedReply.trim()) && !/重复|再说一遍|原话|复述|重说/u.test(context.question||'')) {
    const error=new Error('人物重复了上轮答复，输入已保留，可以重试。');Object.assign(error,{code:'MODEL_ROLE_REPEAT',retryable:true,repairHint:'本轮问题已变化，请直接回答新的问题；问想留下什么话就实际说出交代，不重复还能开口的旧答。'});throw error;
  }
  const gap=value.sourceGap || context.materialGaps?.length?'现有资料未找到所问具体细节的依据；这仅说明当前选材的范围。\n':'';
  const notes=ids.length || gap ? '\n\n资料说明：\n'+gap+(ids.length ? (evidence ? '以下原文对应所列历史表述，不为心理、推断或假设情节提供事实证明。\n'+evidence.map(link=>`对应表述：${link.statement}\n${link.sourceIds.map(id=>`“${byId.get(id).excerpt}”[资料:${id}]`).join('\n')}`).join('\n\n') : ids.map(id=>`“${byId.get(id).excerpt}”[资料:${id}]`).join('\n')) : '') : '';
  return body+notes+'\n\n创作说明：以上为当前条件下的角色演绎，并非史料原话。';
}
