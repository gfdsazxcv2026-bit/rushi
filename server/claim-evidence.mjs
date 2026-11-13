const KINDS=new Set(['historical','interpretation','hypothesis','conversation','mixed']);
const plain=value=>value && typeof value==='object' && !Array.isArray(value);
const error=(repairHint='')=>{const failure=new Error('历史表述与资料对应尚未通过核对，输入已保留，可以重试。');failure.code='MODEL_EVIDENCE_LINK';failure.retryable=true;if(repairHint)failure.repairHint=repairHint;throw failure;};

export function auditedFacts(sources=[],characterId) {
  return sources.flatMap(source=>(source.auditedStatements||[]).filter(item=>item.characterIds.includes(characterId)).map(item=>({sourceId:source.id,text:item.text}))).map((fact,index)=>({...fact,id:`F${index+1}`}));
}

/** Establishes inspectable links, not general semantic entailment. Classification
 * and support still need human review; known hypothetical forms are guarded. */
export function validateClaimEvidence(value,context) {
  const required=context.evidencePolicy==='claim-links-v1';
  if(!required && value.evidence===undefined && value.answerKind===undefined) return null;
  if(!KINDS.has(value.answerKind) || !Array.isArray(value.evidence) || value.evidence.length>5) error();
  if(!Array.isArray(value.references)) error();
  // Human-reviewed, source-local regression limits cover observed overclaims.
  // Literal phrases are deliberately finite; this is not a truth classifier.
  const limits=context.sources.flatMap(source=>(source.claimLimits||[]).map(limit=>({...limit,sourceId:source.id})));
  for(const limit of limits) for(const sentence of value.reply.split(/[。！？；\n]/u)) {
    if((limit.phrases||[]).some(phrase=>sentence.includes(phrase)) && !/推测|可能|也许|或许|假设|如果|若/u.test(sentence)) error(limit.repairHint);
  }
  if(['interpretation','hypothesis','conversation'].includes(value.answerKind) && (value.evidence.length || value.references.length || /\[\[F\d+\]\]/u.test(value.reply))) error('当前answerKind为纯判断、假设或交流：reply不可含任何[[F编号]]，references和evidence必须都是[]。删除事实槽和顺带复述的历史经过，直接回应判断；若确需同时交代历史，改用mixed并为每个F槽填写factId及对应sourceIds。');
  if(['historical','mixed'].includes(value.answerKind) && !value.evidence.length) error();
  const available=new Set(context.sources.map(source=>source.id));
  const facts=new Map(auditedFacts(context.sources,context.scene?.characterId).map(fact=>[fact.id,fact]));
  const used=new Set(),seen=new Set(),resolved=[];
  for(const link of value.evidence) {
    if(!plain(link) || Object.keys(link).some(key=>!['statement','sourceIds','factId'].includes(key))) error();
    const fact=link.factId===undefined?null:facts.get(link.factId);
    if(link.factId!==undefined && (!fact || link.statement!==undefined)) error();
    const span=fact?`[[${fact.id}]]`:link.statement;
    if(typeof span!=='string' || !span.trim() || Array.from(span).length>180 || /\r|\n/u.test(span) || !value.reply.includes(span)) error();
    const statement=fact?.text||span;
    if(seen.has(span)) error();seen.add(span);
    // A proposed future procedure must not acquire historical backing merely
    // by citing an older reception. Mixed replies may cite their past facts.
    if(/^(?:若|如果|假如|假设|倘若|要是)|(?:我|寡人|朕)(?:会|将会)|尚未(?:施行|实行)|(?:这是|只是|此乃)设想/u.test(statement.trim())) error();
    if(!Array.isArray(link.sourceIds) || !link.sourceIds.length || link.sourceIds.length>3 || new Set(link.sourceIds).size!==link.sourceIds.length || link.sourceIds.some(id=>typeof id!=='string'||!available.has(id))) error();
    if(fact && (link.sourceIds.length!==1 || link.sourceIds[0]!==fact.sourceId)) error();
    for(const limit of limits.filter(limit=>link.sourceIds.includes(limit.sourceId))) if((limit.phrases||[]).some(phrase=>statement.includes(phrase))) error(limit.repairHint);
    for(const id of link.sourceIds) {
      const source=context.sources.find(source=>source.id===id);
      if(!source.auditedStatements) continue;
      const permitted=source.auditedStatements.filter(item=>item.characterIds.includes(context.scene?.characterId));
      if(!permitted.some(item=>item.text===statement)) error('这条资料的auditedStatements已有人工核对的事实。请在reply使用对应[[F编号]]，evidence使用factId与该sourceIds，服务器填入事实文字；原因、心理与推测另写。');
    }
    for(const id of link.sourceIds) used.add(id);
    resolved.push({statement,sourceIds:link.sourceIds,...(fact?{factId:fact.id}:{})});
  }
  const references=new Set(value.references);
  if(references.size!==used.size || [...references].some(id=>!used.has(id))) error();
  if(value.reply.replace(/\[\[F\d+\]\]/gu,'').includes('[[F')) error();
  for(const token of value.reply.matchAll(/\[\[(F\d+)\]\]/gu)) if(!resolved.some(link=>link.factId===token[1])) error();
  return resolved;
}
