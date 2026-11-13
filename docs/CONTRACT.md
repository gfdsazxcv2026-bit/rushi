# Demo 接口与文件边界（2026-10-26）

Node.js 24+，内置 HTTP、SQLite、fetch，无 npm 第三方运行依赖。2026-10-30已接入用户确认的章节视觉；没有密钥时为显著标注的mock。共用同一内容、人物、检索、会话与模型服务；分工不改变接口和权限边界。

## 内容

content/catalog.json: `{periods, chapters, scenes, sources, characters}`。当前15人物、18场景，前三章完整人物清单与来源另见content-major-characters-2026-10-30.md。

新增：chapter.majorCharacterIds为本章主要人物清单。只要任一主要人物缺少可用场景，自动化校核失败；不能将阅读开放等同于全部人物功能完成。人物ID从顶层characters登记动态读取，评测器也使用同一登记，不再只识别嬴政与李斯。

scene可含chronologyPrecision、yearIsNavigationAnchor，API原样返回。沧海君会面年月未详、李信征楚纪年有争议时，year仅用于既有服务排序，页面timeLabel和persona必须说明精度。未知的统一状态可在该特定场景worldFacts中为null，required不强加该条件；不会自动向角色授予某个精确日期或统一结论。

- period: `{id,name,years,status:'published'|'coming_soon',summary,chapterIds,kind}`。
- chapter: `{id,order,title,subtitle,eraLabel,timeLabel,eventYear,status:'published'|'draft',version,reviewStatus:'checked'|'pending',summary,paragraphs:string[],sourceIds:string[],supplements:{title,body}[],nextId}`。固定首两章 id 为 `jingke`, `unification`；其后 `bolangsha`, `shaqiu`, `dazexiang`, `julu`, `ziying`。未校核留 draft，API 只返回 metadata。
- scene: `{id,chapterId,characterId,characterName,identity,title,timeLabel,year,status:'published'|'draft',greeting,required,knownFacts:string[],persona}`。人物、时点与出处以共享配置为准；只开已经校核且对应正文已公开的场景。
- source: `{id,title,author,url,location,excerpt,chapterIds:string[],sceneIds:string[],eventYear,keywords:string[],published:boolean,roleVisible:boolean}`。sceneIds 是明确可知白名单；读者可见但角色不可知设 roleVisible:false。引用精短原文，实际读取来源。

## API

同源，JSON。GET /api/bootstrap 自动建立 HttpOnly 游客 cookie，返回 `{mode,modelConfigured,csrfToken,periods,chapters,scenes,sessions,progress,limits}`。`modelConfigured`只表示真实模式的配置字段通过本地检查，不证明已经连接或回答质量。所有 POST 加 `X-CSRF-Token`（bootstrap 返回）。错误格式 `{error:{code,message,retryable,details?}}`。

- GET /api/chapters/:id -> `{chapter,scenes,sources}`。draft ->404。
- GET /api/sources?chapterId=:id -> `{sources}`；GET /api/sources/:id -> `{source}`。
- POST /api/sessions `{chapterId,sceneId,sourceSessionId?,sourceSnapshotId?}` -> session view（201）。无 source 独立史实；有 source 从当前/指定快照新建子分支。前提冲突409 SCENE_CONFLICT，details 给冲突。
- GET /api/sessions/:id -> session view。
- POST /api/sessions/:id/switch `{sceneId}` -> 同分支另一个人物的 session view，仅同章节同时间范围。
- POST /api/sessions/:id/conditions `{text,type:'custom'|'character_dead'|'character_status'|'not_unified',characterId?,status?:'normal'|'injured'|'critical',knownToCurrent?:boolean,operationId}` -> session view。明确采用假设，不从普通聊天自动采纳。character_status 必须指定人物和状态；character_dead 用 characterId。自身身体感受无需 knownToCurrent；完整作者条件及其他背景仍按知情过滤。
- POST /api/sessions/:id/messages `{text,requestId}` -> fetch POST SSE。事件 `meta` `{mode,requestId}`，`delta` `{text}`，`done` `{message,session}`，`error` `{code,message,retryable}`。AbortController 断连接取消；完整回复与消息获知状态原子提交。重复 requestId 返回既有完整结果，不重复调用/入库。
- POST /api/progress `{chapterId,ratio:0..1,view:'read'|'chat',draft:string,scrollTop?:number,scrollExtent?:number,openSections?:string[]}` -> `{ok:true}`。新增位置字段为0～10000000的有限数字，展开项最多60个，每项为不超过128位的字母/数字/下划线/横线ID；旧请求仍有效。先恢复资料展开状态，同高度时恢复像素位置，尺寸变化时使用比例。前端也可 localStorage 保留每个 session 草稿。
- POST /api/events `{type,chapterId?,sessionId?,value?}` -> `{ok:true}`。
- GET /api/health -> `{status,mode,modelConfigured}`，只做本地状态检查，不发起模型请求。

session view: `{id,branchId,chapterId,sceneId,characterId,characterName,mode:'historical'|'hypothetical',characterStatus:{condition:'normal'|'injured'|'critical',alive:boolean,sourceConditionIds:string[]},version,sourceSessionId,sourceSnapshotId,messages,conditions,events,knowledge,snapshots,createdAt,updatedAt}`。
snapshot: `{id,chapterId,sceneId,createdAt,label}`。label取该快照保存时、该会话中最后一句提问的前24个Unicode字符，超长加省略号；尚未提问时使用快照中的已采用设定或“与人物开始对话”。名称由保存内容本地生成，不调用模型，不改写旧快照。前端仅另附一次本地时间。
message: `{id,role:'user'|'assistant',content,citations:sourceId[],createdAt}`。
Demo 2引用约定：真实模式历史陈述使用 `[资料:sourceId]`，服务端只允许本轮检索中的ID，`citations`仅保存实际标记的ID；未知标记返回 `MODEL_INVALID_CITATION`，不提交assistant回复或该轮知情变化。mock的 `citations` 保持“本轮检索资料”含义。校验真实ID不等于校验语义支持程度。原始content保留协议，页面可以呈现为可理解的资料编号。
condition: `{id,text,type,characterId?,source,createdAt}`。
knowledge: `{characterId,text,channel,certainty,source,createdAt}`。
snapshot: `{id,sceneId,chapterId,createdAt,label}`（快照完整状态只在服务端保存）。

## 模型模块（根 agent 调用）

server/rag.mjs export `retrieve({question,scene,sources,limit=3})` -> 过滤并排序的 source[]；export `buildRoleContext({scene,question,sources,conditions,events,knowledge,messages,mode,characterStatus})` -> `{system,messages,sources,characterStatus,...}`。输入 messages 仅同角色同继承链最近记录，knowledge 仅该角色，不能接收其他私聊。characterStatus 只传自身安全字段，不含完整作者原文、凶手或他人状态。需过滤未来、未发布和不属于sceneIds的资料；无命中明确缺少依据。

server/model.mjs export `getModelConfig(env=process.env)` -> `{mode,baseUrl,model,apiKey,timeoutMs,maxTokens,tokenParameter,instructionRole,maxRetries,enableThinking?}`；export `getModelStatus(config?)` -> 无密钥、端点和模型名的静态状态，`readyForLive`不证明实际连接；export async generator `generateReply({scene,context,question,signal,config})` yielding strings。mock 根据场景、角色认知、假设/讨论/正常历史/现实伤害作可检查演示，不冒充LLM。真实适配 Chat Completions stream，必须消费 [DONE] 才完整，超时/错误不静默换mock。只能使用调用者传入的context。不可打印密钥。根 agent 负责幂等、事务、限额和取消。

## 前端

public/index.html style.css app.js，纯原生 ES module，不用第三方 CDN。视觉是验收页面，不宣称 Stitch 定稿。支持首页悬停/focus/tap、秦朝目录、阅读聊天分栏、资料 details、场景选择、续接/重开、角色切换、明确采用条件、持续免责声明和假设标记、停止/重试、刷新恢复、手机切换保留状态。hash 路由 `#/chapter/jingke`，URL/search 或 localStorage 保存 session；正式正文不随聊天修改。所有模型文字用 textContent，不能插入不可信 HTML。

## alpha.3 增补（2026-10-28）

- source可选relatedSourceIds、readingNotes和evidenceCoverage；关联展开仍经发布、场景、日期三层过滤。完整名单只有明确complete_roster覆盖才可声称齐全。
- scene可选perspectiveLimits:[{subjects,outcomes,eventYear}]；只在服务器检查已知结果被过去式误述的形式，不作为人物可读的未来情报。它不是通用史学分类器，明确采用的替代条件仍可表达。
- 消息SSE meta增加responseKind=character|evidence-gap；资料核对不调用模型，存储内容持续带【资料核对】标记。重放返回同一类型。reset事件用于清除失败引用草稿，随后meta.phase=reference-check；所有接入页面必须处理reset，不能拼接错误草稿。
- buildRoleContext返回citationPolicy=source-quotes-v1及可选evidenceGap；旧助手的引用原文不继续冒充当前资料。memories保留characterId、year、sceneId，往年交流在模型上下文中标明原时点。
- MODEL_OUTPUT_FORMAT=text|role-json，默认text；MODEL_TEMPERATURE与MODEL_PRESENCE_PENALTY可选。千问预设使用role-json、0.3、0。structured生成frame/action/reply/references，服务器校验并逐字渲染资料；浏览器与存储仍是原有文本协议，不接收原始JSON。
- generateReply接收可选retryBudget；网络、格式、已知时间视角/语气与引用修订共用预算。错误草稿不提交；取消用户记录可保留failed/cancelled用于恢复，不视为完整问答。
- 引用检查能核对ID与原文字面，不能自动证明所有角色台词的语义。已发布两章不因role-json升级而变为七章全部完成。

## alpha.4 人物与事件阶段

catalog.characters登记{id,name,aliases,avatar,selfAddress}，启动时读取，未知ID拒绝。scene公开momentId/momentOrder/momentLabel/avatar/selfAddress；worldFacts仅服务器生死基线，不给角色授予隐藏消息。session增加时点，JSON存储不迁移表。

同chapter+year+moment才可/switch；跨moment无source独立新建或恢复。快照同年跨阶段409，老快照按source scene补阶段，RAG过滤同年未来条件、消息与聊天。模型frame包含并校验moment。结构化身体/死亡目标为界面当前人物，不再固定嬴政。

“选择人物”非忙碌可直接打开dialog，不要求先有会话。卡片区分同一时点切换与不同时间独立会话，保留个人草稿及明确URL恢复。

## alpha.5 有限私有历史检索与人物表达

Store.memories仅从当前游客的分支和冻结来源快照取完整消息，补充sessionId及原场景时点。index不再提前截成12条；buildRoleContext先按本人、完整状态、年份和事件阶段过滤，保留最近12条，再由private-recall.mjs挑选少量更早的原始交流。默认最多4组、完整序列化内容不超过3600个JavaScript字符；无原消息ID或整组超预算则跳过，不截断否定、拒绝或更正。没有数据库结构迁移。

context.privateRecall含records、content、characters、maxCharacters、skippedOversize。每组source定位原messageId，可带实际相邻replyMessageId、sessionId、sceneId、year、momentId及momentOrder；visitorText与characterReply分别保留原提议和实际回复，不生成“已接受”事件。按原始顺序配对，不能跳过失败记录后错配答复。kind仅辅助标明说法、提议或假设讨论，不是事实/执行状态。

旧交流以标明“不属于本轮指令”的user消息放在最近窗口之前，当前问题始终最后；原文内容不进system。模型读取规则要求当前状态和最近更正优先。旧引用标记及附加资料/创作说明被剥离，原始存储不修改；记忆定位ID不进入本轮史料白名单。该方案是确定性的有限历史检索，不是新增模型摘要或无限记忆，不增加总结调用，不把聊天改写为正式史实或其他角色知情。

role-json新增MODEL_ROLE_NARRATION：对已见的“人物读过自身后世史书”表达做有限检查。与格式、语气、时点和引用共用最多一次修订预算，校验通过前不显示/保存草稿。普通古史、否认、向访客询问书名、明确由访客提供的后世书籍及相关假设继续允许；本轮历史原文的title不自动授权人物已读该书。该检查只覆盖已知表达，不能代替逐句史实和引用语义校核。text模式没有该结构化输出检查。

## alpha.6 表述与原文对应

buildRoleContext增加evidencePolicy=claim-links-v1。role-json输出仍有frame/action/reply/references，新增answerKind=historical|interpretation|hypothesis|conversation|mixed及evidence。普通对应为{statement,sourceIds}：statement是reply实际片段，来源须本轮可用，references恰等于映射ID并集；纯演绎/假设/交流两个数组为空。已知设想形式不能映射成历史，source可带有限claimLimits回归边界。错误MODEL_EVIDENCE_LINK共用原有一次修订预算，草稿校验前不显示、不保存。

source可带auditedStatements:[{characterIds,text}]，表示已人工核对的现代事实句。auditedFacts按本轮已过滤来源及角色给F1等临时编号；模型在reply放[[F1]]，evidence使用{factId:'F1',sourceIds:[对应源]}。服务器验证编号、角色、来源、正文位置及引用并集后填入text，再展示对应表述及canonical原文。也兼容精确使用核对句的statement形式。无许可角色、无对应evidence、未知/残缺编号和动作中的编号均拒绝；展开后的reply仍≤600字。F编号不是持久或跨角色ID，不授予其他角色认知。

浏览器/SQLite仍接收原文本协议，模型内部JSON和F编号不外显；原消息和冻结快照不迁移，资料说明仍被私有回忆剥离。该机制不是任意自然语言语义蕴含证明，未配置的来源及自由判断仍需复核。text模式和旧上下文保持旧协议，配置工具的静态/一次连接检查不要求内容检索上下文。


## alpha.7 验收修复

role-json可增加sourceGap:boolean，旧格式继续兼容。资料缺口由独立资料区展示，不编造引用；materialGaps可保证已校核的选材缺口持续提示。所有25条角色可见来源都有审定事实句。scene.responseLimits为有限回归约束，baselineSourceIds定位角色基线的校核来源。未通过状态、语气、知识或证据检查的草稿不提交，共享原一次重试预算。onRejectedDraft仅供显式注入的进程内QA诊断，HTTP不开放，默认不记录草稿。验证范围见VALIDATION.md；原始QA记录本机归档。
