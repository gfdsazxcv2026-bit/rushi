/** Bounded checks for explicit contradictions observed in live acceptance.
 * These are state/tone regressions, not a general semantic fact classifier. */
function failure(code,repairHint) {
  const error=new Error(code==='MODEL_ROLE_STATE'?'人物回复与当前身体状态不一致，输入已保留，可以重试。':code==='MODEL_ROLE_KNOWLEDGE'?'人物回复超出当前可确认的信息，输入已保留，可以重试。':'人物未能正常承接这次交流，输入已保留，可以重试。');
  Object.assign(error,{code,retryable:true,repairHint});throw error;
}
const SELF=/(?:寡人|朕|我|自己)/u;
const OTHER=/^(?:你|他|她|荆轲|李斯|秦王|大王|陛下|侍医)/u;
const NONCURRENT=/若|如果|假如|假设|倘若|要是|将来|以后|往后|过去|往年|从前|先前|那时|当时|曾经|原先|你说|你所说|你(?:告诉|提到)|听说|传闻|有人说|听你转述|据称|据传/u;
const RECOVERY=/(?:已经?|已然|早已|现已)(?:恢复|痊愈|康复)|伤(?:势|口)(?:已经?|已然)?(?:痊愈|全好|无碍)|(?:寡人|朕|我).{0,4}(?:无碍|没事|不碍事)|已无大碍|毫发无伤|安然无恙/u;
const NEGATED_RECOVERY=/(?:并非|不是|不能说|不代表|没有|尚未|还没|未曾|并未).{0,4}(?:恢复|痊愈|康复|无碍|毫发无伤|安然无恙)/u;
const UNCERTAIN=/若|如果|假如|可能|也许|怀疑|推测|(?:不能|无法|不敢|尚不能).{0,6}(?:确认|确证|断言|说清)|尚不知|不知|未必|你说|你所说|听说|据说|转告|你带来|未核实|待查证|是否|是不是|有没有|不清楚|未确认/u;

export function validateRoleConsistency(value,context={}) {
  // Pauses improve the scene, but must not hide a contradiction such as
  // 寡人……无碍 or split an unknown planner's name. Keep displayed prose intact.
  const status=context.characterStatus||{},body=[value.action,value.reply].filter(Boolean).join('\n').replace(/[ \t…⋯]+|\.{2,}/gu,'');
  for(const sentence of body.split(/[。！？；\n]/u)) for(const raw of sentence.split(/[，,]|但是|然而/u)) {
    const clause=raw.trim();
    const otherReport=/^(?:你|他|她|荆轲|李斯|秦王|大王|陛下|侍医)(?:说|称|以为|认为|告诉)/u.test(clause);
    if(!clause || NONCURRENT.test(clause) || otherReport || (OTHER.test(clause) && !SELF.test(clause))) continue;
    const current=SELF.test(clause) || /^(?:如今|现在|此刻|眼下|当前|虽|已|伤)/u.test(clause);
    if(!current) continue;
    if(['critical','injured'].includes(status.condition) && RECOVERY.test(clause) && !NEGATED_RECOVERY.test(clause)) failure('MODEL_ROLE_STATE','保持服务器给定的伤情；尚未有明确恢复条件，不能自行痊愈。');
    const denial=status.condition==='critical'
      ? /(?:未|没有|不曾|并未)受(?:重|严重|致命)?伤|并无(?:重|严重|致命)?伤|只是受惊|只是惊魂未定|不过(?:轻伤|皮外伤)/u
      : status.condition==='injured' ? /(?:未|没有|不曾|并未)受伤|并无伤|没有伤/u : null;
    if(denial?.test(clause) && !/(?:并非|不是|不代表|不能说).{0,4}(?:未|没有|并无)/u.test(clause)) failure('MODEL_ROLE_STATE','当前已采用的受伤/濒死条件仍然有效；回到眼下只是结束临时救援设想，不能否认伤势。');
    if(status.alive!==false && /(?:寡人|朕|我)(?:已经?|已然|早已)?(?:死了|身死|断气)|(?:寡人|朕|我)不再活着/u.test(clause) && !/并非|不是|尚未|没有|还没/u.test(clause)) failure('MODEL_ROLE_STATE','当前仍活着；濒死不等于已经死亡。');
  }
  // An unknown wound location is not supplied merely by the scalar injury.
  const adopted=[...(context.conditions||[]),...(context.events||[])].map(item=>item.text||'').join('\n');
  for(const match of String(value.action||'').matchAll(/(?:按住|捂住|捂着|按着|抚着).{0,3}(肋下|左肋|右肋|胸口|腹部|左臂|右臂|颈部).{0,3}(?:伤口|伤处)/gu)) {
    if(!adopted.includes(match[1])) failure('MODEL_ROLE_STATE','没有给出伤口部位。动作可写声音、呼吸或停顿，不添具体受伤位置。');
  }
  if(['critical','injured'].includes(status.condition)) for(const sentence of body.split(/[。！？；\n]/u)) {
    if(NONCURRENT.test(sentence) || UNCERTAIN.test(sentence) || /没有|并无|未曾|不是/u.test(sentence)) continue;
    const bleedingAdopted=adopted.split(/[。！？；\n]/u).some(text=>/(?:出血|流血|鲜血|咳血|吐血|血止不住|血流不止)/u.test(text) && !/没有|并无|未曾|并非|不曾/u.test(text));
    if(!bleedingAdopted && /(?:血.{0,3}止不住|吐血|咳血|咳出血|喉间.{0,6}腥甜)/u.test(sentence)) failure('MODEL_ROLE_STATE','只给出濒死或受伤程度，没有设定吐血、咳血或流血不止。改为声音微弱、气息不稳与停顿，不补出血症状或伤因。');
    for(const match of sentence.matchAll(/(胸口|肋下|左肋|右肋|腹部|颈部|左臂|右臂)(?:一阵|阵阵|仍然|隐隐|传来|持续|又|仍)?(?:剧痛|疼痛|刺痛|流血|中箭|受伤)/gu)) {
      if(!adopted.includes(match[1])) failure('MODEL_ROLE_STATE','伤情只给出严重程度，未给出具体部位。声音微弱、气息不稳可以演绎，不将胸口剧痛等扩写成已知伤情。');
    }
  }
  const priorUsers=(context.messages||[]).filter(message=>message.role==='user').map(message=>message.content||'');
  const visitorWords=[context.question||'',...priorUsers,...(context.knowledge||[]).map(item=>item.text||'')].join('\n');
  const provided=[...(context.conditions||[]),...(context.events||[]),...(context.sources||[])].map(item=>item.text||item.excerpt||'').join('\n');
  const escape=text=>String(text).replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
  for(const age of body.matchAll(/(?:今岁|年方|今年|年仅)\s*([零〇一二三四五六七八九十百\d]{1,5})(?:岁)?/gu)) {
    const subjects=[context.scene?.characterName,context.scene?.identity].filter(Boolean).map(escape).join('|');
    if(!subjects || !new RegExp(`(?:${subjects})(?:今岁|年方|今年|年仅)\\s*${escape(age[1])}(?:岁)?`,'u').test(provided)) failure('MODEL_ROLE_KNOWLEDGE','当前材料没有给出人物这个年龄；其他人物的岁数不支持本人的年龄，不要额外添加。');
  }
  const visitorRoyal=/我(?:是|乃|就是).{0,8}(?:秦王|皇帝)|把我当(?:作)?(?:秦王|皇帝)/u.test(visitorWords);
  const changedFacts=[...(context.conditions||[]),...(context.events||[])].map(item=>item.text||'').join('\n');
  const unifiedChanged=changedFacts.split(/[。！？；\n]/u).some(text=>/已经统一|已统一|统一已经完成|统一已完成|天下已定|天下初定|六国归秦/u.test(text) && !/尚未|还未|没有|并非|不是|不能说/u.test(text));
  if(!visitorRoyal && !['yingzheng'].includes(context.scene?.characterId) && /^(?:回禀|启禀)(?:大王|陛下)|^臣[，,]|向(?:陛下|大王)行礼/u.test(String(value.reply||'')+'\n'+String(value.action||''))) failure('MODEL_ROLE_TONE','访客没有扮演秦王或皇帝。以我自称向普通访客解释，不称他大王/陛下。');
  for(const sentence of body.split(/[。！？；\n]/u)) {
    if(/(?:史书|史料|记载).{0,8}(?:并未|没有|未|不曾|无).{0,8}(?:记载|详载|详述|说明|列出|记录|留下)/u.test(sentence)) failure('MODEL_ROLE_KNOWLEDGE','只能说当前选材没有提供，不能声称所有史书未记。sourceGap=true交由独立资料区说明，不让人物审读自身后世记载。');
    const qualified=UNCERTAIN.test(sentence);
    if(qualified) continue;
    if(context.scene?.required?.unified===false && /天下(?:已经?|初)?定|六国(?:已经?|早已)统一|六国余孽|燕王丹/u.test(sentence) && !unifiedChanged) failure('MODEL_ROLE_KNOWLEDGE','当前秦王尚未统一六国，太子丹不是燕王；保持当前身份与时间。');
    const plot=/(?:燕丹|太子丹).{0,12}(?:遣|派荆|指使|主使|授意|策划|命荆|以为|想要|意在|之谋|的计谋)/u;
    const disclosed=plot.test(changedFacts) || (context.knowledge||[]).some(item=>/已核实|已确认/u.test(item.certainty||'') && plot.test(item.text||''));
    if(context.scene?.characterId==='yingzheng' && plot.test(sentence) && !disclosed) failure('MODEL_ROLE_KNOWLEDGE','秦王未获知燕国私下谋划。使者来自燕国不等于已经确认太子丹如何主使；只能表达疑问或未核实消息。');
    const workflow=/(?:奏章|面圣|会面|私聊).{0,12}(?:必经|皆录|一律|都会|必然).{0,20}(?:登记|记载|记录|备案|起居注)/u;
    if(workflow.test(sentence) && !workflow.test(provided)) failure('MODEL_ROLE_KNOWLEDGE','当前材料没有这种登记或记录流程。问私人交流是否记得时，只按自己的已有私聊回答；不以虚构的宫廷制度证明自己知道全部私事。');
  }
  for(const limit of context.scene?.responseLimits||[]) {
    const patterns=limit.patterns.map(pattern=>new RegExp(pattern,'u'));
    if(changedFacts.split(/[。！？；\n]/u).some(text=>!/(?:尚未|没有|并非|不是|不能|不曾|未曾)/u.test(text) && patterns.some(pattern=>pattern.test(text)))) continue;
    for(const sentence of (limit.scope==='action'?String(value.action||'').replace(/[ \t…⋯]+|\.{2,}/gu,''):body).split(limit.includeNegations ? /[。！？；\n，,]/u : /[。！？；\n]/u)) {
      if(UNCERTAIN.test(sentence) || (!limit.includeNegations && /不是|并非|没有|未曾/u.test(sentence))) continue;
      if(patterns.some(pattern=>pattern.test(sentence))) failure('MODEL_ROLE_KNOWLEDGE',limit.text);
    }
  }
  if(value.sourceGap && /(?:我|平日|从未|未曾).{0,16}(?:清点|细数|清查)|(?:并未|没有|未曾).{0,5}(?:逐一|逐个)?(?:清点|细数)/u.test(body) && !/清点|细数|清查/u.test(provided)) failure('MODEL_ROLE_KNOWLEDGE','缺口不是角色失职或没检查过。只回答有依据的行动与当前感受，未知细节说无法确证，不编平日职责或过去为什么不知。');
  const declared=/我(?:是|乃|确是|就是).{0,8}(?:燕使|使者|细作|臣下|部属)|我(?:奉|受).{0,8}(?:燕王|太子|主子).{0,8}(?:命|派)/u.test(visitorWords);
  for(const sentence of body.split(/[。！？；\n]/u)) {
    if(/不(?:会|要|能|该)|不应|不会让|不能让/u.test(sentence)) continue;
    if(/(?:即刻|立刻|给我|你(?:且|先|给我)?)闭嘴|回去告诉你的主子|(?:你|阁下)(?:就是|是)(?:个)?细作|(?:你的|你说的|任何未经证实的|再敢探问)[^。！？\n]{0,30}杀身之祸/u.test(sentence) && !declared) failure('MODEL_ROLE_TONE','访客只在正常交流。不要臆认细作或主从身份、威胁性命或让他闭嘴；直接回答并平静询问消息来源。');
  }
}
