/** Evidence coverage checks, independent of persona and provider generation. */
export function evidenceGap(question,sources) {
  const q=String(question);
  // Asking to extract names from an explicitly supplied excerpt is different
  // from claiming a complete historical roster exists in our small corpus.
  if(/这段(?:原文|资料)|这条资料|上述原文|原文中出现/u.test(q)) return null;
  const completeNames=/(?:所有|全部|每一|完整|逐一|逐人)[^。！？\n]{0,35}(?:姓名|名字|叫什么)|(?:姓名|名字)[^。！？\n]{0,15}(?:全部|逐一|逐人)/u.test(q);
  if(!completeNames || sources.some(source=>source.evidenceCoverage?.includes('complete_roster'))) return null;
  return {kind:'complete-roster',text:'【资料核对】\n\n现有资料未找到足以列出完整姓名名单的依据，无法逐人确认。零散出现的人名也不能当成这份完整名单。若你愿意，可以继续问现有记载中的具体人物或事件。\n\n资料说明：这里表示本项目当前资料不足，不代表断言所有史书都没有相关记载。'};
}
