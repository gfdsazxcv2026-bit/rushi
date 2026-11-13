/** A small, scene-configured check for known retrospective outcome mistakes.
 * It deliberately permits plans, forecasts, negation and adopted alternatives;
 * this is a regression guard, not a general historical truth classifier. */
export function hasRetrospectiveOutcome(reply,scene,context) {
  const sentences=String(reply).split(/[。！？；\n]/u).filter(Boolean);
  const adopted=[...(context.conditions||[]),...(context.events||[])].map(item=>String(item.text||'')).join('\n');
  for(const boundary of scene.perspectiveLimits||[]) {
    if(!Number.isFinite(boundary.eventYear) || boundary.eventYear<=scene.year) continue;
    const subject=text=>(boundary.subjects||[]).some(word=>text.includes(word));
    const outcome=text=>(boundary.outcomes||[]).some(word=>text.includes(word));
    if(subject(adopted) && outcome(adopted)) continue;
    for(let i=0;i<sentences.length;i++) {
      const sentence=sentences[i];
      if(!outcome(sentence) || !(subject(sentence) || (/其/u.test(sentence)&&subject(sentences[i-1]||'')))) continue;
      if(/若|如果|假如|可能|未必|恐怕|担心|担忧|会|将|尚未|没有|不曾|不能确认|听说|你说|你所说/u.test(sentence)) continue;
      if(/已经|早已|已然|最终|后来|加速了|导致了|造成了|反令/u.test(sentence)) return true;
    }
  }
  return false;
}
