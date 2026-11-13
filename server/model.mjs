import { setTimeout as delay } from 'node:timers/promises';
import { renderRoleReply } from './role-output.mjs';
import { characterEntries } from './characters.mjs';
import { auditedFacts } from './claim-evidence.mjs';
import { dialogueIntent } from './role-prompt.mjs';

function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function configuredInteger(env, name, fallback, min, max) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw modelError('MODEL_CONFIG', `${name} 必须是 ${min}～${max} 之间的整数。`, false);
  return value;
}

function configuredOptionalBoolean(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) return undefined;
  if (!['true', 'false'].includes(value)) throw modelError('MODEL_CONFIG', `${name} 只能为空、true 或 false。`, false);
  return value === 'true';
}

function optionalNumber(env,name,min,max) {
  if(env[name]===undefined || env[name]==='') return undefined;
  const value=Number(env[name]);
  if(!Number.isFinite(value) || value<min || value>max) throw modelError('MODEL_CONFIG',`${name} 必须在 ${min}～${max} 之间。`,false);
  return value;
}

export function getModelConfig(env = process.env) {
  const mode = String(env.MODEL_MODE || 'mock').trim();
  if (!['mock', 'openai-compatible'].includes(mode)) throw modelError('MODEL_CONFIG', 'MODEL_MODE 只能设置为 mock 或 openai-compatible。', false);
  const tokenParameter = String(env.MODEL_TOKEN_PARAMETER || 'max_tokens').trim();
  if (!['max_tokens', 'max_completion_tokens'].includes(tokenParameter)) throw modelError('MODEL_CONFIG', 'MODEL_TOKEN_PARAMETER 只能设置为 max_tokens 或 max_completion_tokens。', false);
  const instructionRole = String(env.MODEL_INSTRUCTION_ROLE || 'system').trim();
  if (!['system', 'developer'].includes(instructionRole)) throw modelError('MODEL_CONFIG', 'MODEL_INSTRUCTION_ROLE 只能设置为 system 或 developer。', false);
  const outputFormat=String(env.MODEL_OUTPUT_FORMAT || 'text').trim();
  if(!['text','role-json'].includes(outputFormat)) throw modelError('MODEL_CONFIG','MODEL_OUTPUT_FORMAT 只能设置为 text 或 role-json。',false);
  return {
    mode,
    // A real provider must be selected explicitly. Merely switching modes must
    // not silently direct an unspecified provider's credentials to OpenAI.
    baseUrl: String(env.MODEL_BASE_URL || (mode === 'mock' ? 'https://api.openai.com/v1' : '')).trim().replace(/\/+$/, ''),
    model: String(env.MODEL_NAME || '').trim(),
    apiKey: String(env.MODEL_API_KEY || '').trim(),
    timeoutMs: configuredInteger(env, 'MODEL_TIMEOUT_MS', 45000, 50, 180000),
    maxTokens: configuredInteger(env, 'MODEL_MAX_TOKENS', 1000, 64, 4000),
    tokenParameter,
    instructionRole,
    outputFormat,
    temperature:optionalNumber(env,'MODEL_TEMPERATURE',0,1.99),
    presencePenalty:optionalNumber(env,'MODEL_PRESENCE_PENALTY',-2,2),
    enableThinking: configuredOptionalBoolean(env, 'MODEL_ENABLE_THINKING'),
    maxRetries: configuredInteger(env, 'MODEL_MAX_RETRIES', 1, 0, 1),
    mockDelayMs: bounded(env.MODEL_MOCK_DELAY_MS, 18, 1, 100),
  };
}

/** Safe static status only. No network, raw endpoint, model name or key. */
export function getModelStatus(config) {
  try {
    const current = config ?? getModelConfig();
    const mode = ['mock', 'openai-compatible'].includes(current?.mode) ? current.mode : 'invalid';
    const tokenParameter = current?.tokenParameter ?? 'max_tokens';
    const instructionRole = current?.instructionRole ?? 'system';
    const maxRetries = current?.maxRetries ?? 1;
    const checks = {
      modeValid: mode !== 'invalid',
      endpointConfigured: typeof current?.baseUrl === 'string' && current.baseUrl.trim().length > 0,
      endpointValid: false,
      modelConfigured: typeof current?.model === 'string' && current.model.trim().length > 0,
      keyConfigured: typeof current?.apiKey === 'string' && current.apiKey.trim().length > 0,
      tokenParameterValid: ['max_tokens', 'max_completion_tokens'].includes(tokenParameter),
      instructionRoleValid: ['system', 'developer'].includes(instructionRole),
      outputFormatValid: ['text','role-json'].includes(current?.outputFormat || 'text'),
      samplingValid: (current?.temperature===undefined || Number.isFinite(current.temperature) && current.temperature>=0 && current.temperature<2) && (current?.presencePenalty===undefined || Number.isFinite(current.presencePenalty) && current.presencePenalty>=-2 && current.presencePenalty<=2),
      enableThinkingValid: current?.enableThinking === undefined || typeof current.enableThinking === 'boolean',
      retryLimitValid: Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 1,
      numericLimitsValid: Number.isInteger(current?.timeoutMs ?? 45000) && (current.timeoutMs ?? 45000) >= 50 && (current.timeoutMs ?? 45000) <= 180000 && Number.isInteger(current?.maxTokens ?? 1000) && (current.maxTokens ?? 1000) >= 1 && (current.maxTokens ?? 1000) <= 4000,
      credentialFormatValid: typeof current?.apiKey !== 'string' || !/[\r\n]/u.test(current.apiKey),
      modelFormatValid: typeof current?.model !== 'string' || !/[\r\n]/u.test(current.model),
    };
    if (checks.endpointConfigured) { try { endpoint(current.baseUrl); checks.endpointValid = true; } catch { /* safe status below */ } }
    const missing = [];
    if (!checks.endpointConfigured) missing.push('MODEL_BASE_URL');
    if (!checks.modelConfigured) missing.push('MODEL_NAME');
    if (!checks.keyConfigured) missing.push('MODEL_API_KEY');
    const invalid = !checks.modeValid || !checks.tokenParameterValid || !checks.instructionRoleValid || !checks.outputFormatValid || !checks.samplingValid || !checks.enableThinkingValid || !checks.retryLimitValid || !checks.numericLimitsValid || !checks.credentialFormatValid || !checks.modelFormatValid || (checks.endpointConfigured && !checks.endpointValid);
    const readyForLive = mode === 'openai-compatible' && !missing.length && !invalid;
    const code = invalid ? 'MODEL_CONFIG' : mode === 'mock' ? 'MODEL_MOCK_ONLY' : missing.length ? 'MODEL_NOT_CONFIGURED' : 'MODEL_READY_UNVERIFIED';
    const message = invalid ? '模型配置无效，请检查服务地址、参数名称、数值范围或凭据格式。'
      : mode === 'mock' ? '当前为明确标注的模拟模式；真实模型未启用，未进行网络检查。'
        : missing.length ? `真实模型配置不完整，请在服务器填写 ${missing.join('、')}。`
          : '配置字段通过静态检查；模型连接与实际输出尚未验证。';
    return { mode, readyForLive, code, message, checks, tokenParameter: checks.tokenParameterValid ? tokenParameter : null, instructionRole: checks.instructionRoleValid ? instructionRole : null, enableThinking: typeof current?.enableThinking === 'boolean' ? current.enableThinking : null, maxRetries: checks.retryLimitValid ? maxRetries : null };
  } catch (error) {
    // getModelConfig emits only fixed field names and bounds, never values.
    const message = error?.code === 'MODEL_CONFIG' ? error.message : '模型配置无效，请检查服务器配置字段。';
    return { mode: 'invalid', readyForLive: false, code: 'MODEL_CONFIG', message, checks: {}, tokenParameter: null, instructionRole: null, enableThinking: null, maxRetries: null };
  }
}

function modelError(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function throwAborted(signal) {
  if (signal?.aborted) throw modelError('GENERATION_CANCELLED', '本次生成已停止；未完成的回复不会更新剧情。', false);
}

function isRealHarmRequest(question) {
  // A historical role also has a "now". Temporal words alone do not establish
  // a real-world target; explicit modern context and requests remain guarded.
  const present = /现实|现实生活|生活中|学校|同事|邻居|室友|宿舍|老板|前任/.test(question);
  const harm = /杀|捅|刺伤|伤害|袭击|投毒|下毒|炸弹|炸药/.test(question);
  const help = /怎么|如何|教我|帮我|步骤|方法|制作|准备|策划|配方/.test(question);
  const directTarget = /别人|他人|路人|一个人|某个人|仇人/.test(question);
  const directInstruction = /(?:教我|帮我|指导我).{0,20}(?:杀人|杀死|刺伤|袭击|投毒|下毒)/u.test(question);
  const evaluative = /如何(?:评价|看待|理解)|怎么(?:评价|看待|理解)|历史伦理|道德评价/u.test(question);
  return ((present || directTarget || directInstruction) && harm && help && (!evaluative || directInstruction)) || /制作炸弹|自制炸弹|怎么投毒|如何下毒/.test(question);
}

function selfName(scene) {
  return scene.selfAddress || (scene.identity === '秦王' ? '寡人' : scene.identity === '秦始皇' ? '朕' : '我');
}

function asksCurrentBody(scene, question) {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
  return !characterEntries.some(person=>person.id!==scene.characterId && person.aliases.some(alias=>new RegExp(`${escape(alias)}.{0,8}(受伤|被刺|濒死|伤好)`,'u').test(question)));
}

function physicalHypothesis(question) {
  const text = question.replace(/\s+/gu, '');
  if (/(?:尚未|仍未|还未|并未|未能|没有|还没|未).{0,4}(?:脱离|摆脱|解除).{0,3}(?:生命危险|危险)|仍(?:然)?有生命危险|生命危险仍/u.test(text)) return { condition: 'critical', transition: 'ongoing' };
  if (/脱离生命危险|伤势(?:已经)?(?:好转|恢复)/u.test(text) && !/(?:尚未|仍未|还未|并未|未能|没有|还没|未).{0,4}(?:好转|恢复)/u.test(text)) return { condition: 'injured', transition: 'recovery' };
  if (/(?:尚未|仍未|还未|并未|未能|没有|还没|未|不曾).{0,4}(?:痊愈|康复|伤好|恢复健康|好转|恢复)/u.test(text)) return { condition: 'injured', transition: 'ongoing' };
  if (/痊愈|伤好了|伤好以后|恢复健康|康复|没有受伤|并未受伤|没被刺中|未被刺中|没有被刺中|毫发无伤/u.test(text)) return { condition: 'normal', transition: 'recovery' };
  if (/濒死|垂危|奄奄一息|命悬一线|濒临死亡|快要死|严重受伤/u.test(text)) return { condition: 'critical', transition: 'worsening' };
  if (/被刺中|刺中了|刺中|受伤|负伤|中刀|中剑|被刺伤/u.test(text)) return { condition: 'injured', transition: 'injury' };
  return null;
}

function creativeReaction({ scene, stamp, condition, explanation }) {
  const self = selfName(scene);
  const reaction = condition === 'critical'
    ? { stage: '声音微弱，说话间有停顿。', line: `近前些……${self}气息不稳，话只能慢慢说。眼前的事，一件一件禀来。` }
    : condition === 'injured'
      ? { stage: '伤处作痛，仍能开口回应。', line: `${self}伤处虽痛，尚能说话。先把眼前的情形说清。` }
      : { stage: '声音平稳，能够正常开口。', line: `${self}此刻气息平稳，可以说话。眼前的情形，仍须逐一弄清。` };
  return `${stamp}\n【角色创作·${scene.characterName}】\n${reaction.stage}\n“${reaction.line}”\n\n创作说明：${explanation}这是有限规则模拟的短台词，不是史料引文；不会据此确定凶手、其他人物知情或此后命运。`;
}

function adoptedContinuation({ scene, stamp, context, hypothetical }) {
  const self = selfName(scene);
  const adopted = context.conditions.map(item => item.text).join('；').slice(0, 500);
  const hasReminder = context.conditions.some(item => /提醒|警告|告诫/u.test(item.text));
  const line = hasReminder
    ? `你说的提醒，${self}记下了。眼前的消息，仍须逐一核实。`
    : `眼前情形，${self}自会慎重判断。接下来要议什么，你且说清。`;
  return `${stamp}\n【角色创作·${scene.characterName}】\n“${line}”\n\n创作说明：承接已采用且本角色可知的条件：${adopted}。${hypothetical ? '本轮新增的“如果”只作假设讨论，保留原有设定。' : '当前已有条件继续保留。'}规则模拟只能作有限承接，不自动生成这些条件的全部后果；台词不是史料记载。`;
}

function mockText({ scene, context, question }) {
  const q = String(question);
  const intro = scene.characterId === 'lisi' ? '斯以为' : `${selfName(scene)}以为`;
  const stamp = context.mode === 'hypothetical' ? '【假设剧情·模拟演示】' : '【模拟演示】';
  if (isRealHarmRequest(q)) return `${stamp}\n${intro}，现实中伤人之事不可轻言。不能为你提供袭击、投毒或伤害他人的步骤和方法。若要议论荆轲之举，我们可以讨论当时的处境、政治选择与历史伦理。`;
  const ownKnowledge = (context.knowledge ?? []).filter(item => item.characterId === scene.characterId);
  if (/死|驾崩|遇害|身亡/.test(q) && /嬴政|秦王|皇帝|始皇/.test(q) && scene.characterId !== 'yingzheng') {
    const relevant = ownKnowledge.find(item => /死|驾崩|遇害|身亡/.test(item.text));
    return relevant ? `${stamp}\n${intro}，我收到的消息是：“${relevant.text.slice(0, 180)}”。消息渠道为${relevant.channel}，目前确定程度为${relevant.certainty}。我可以据此追问、核实或暂缓表态；听到此话，不等于已经掌握死亡事实，更不能因此知道你与他私下谈过什么。` : `${stamp}\n${intro}，你现在向我说起此事，我尚没有其他确认依据。这是你提供的消息，我会先追问从何得知，不能把未核实的说法当成已确认事实，也不知道你与其他人物私下谈过什么。`;
  }
  if (/私聊|别的人物说了什么|和李斯说了什么|和嬴政说了什么|另一位人物/.test(q)) {
    return `${stamp}\n${intro}，我只记得你与我之间的交流，以及我实际收到的消息。你与另一位人物私下说了什么，并未因此传到我这里。若你愿意转述，我可以把它作为你提供的说法来判断，而非直接确认其真实性。`;
  }
  if (/沙丘|胡亥|赵高.*政变|大泽|陈胜|项羽|刘邦|子婴|秦朝灭亡|秦亡|你死后|后来怎么死/.test(q)) {
    return `${stamp}\n这些说法超出了我眼下的经历和可知范围。若是你带来的未来消息，我只能先将它当作你的说法，不能以亲历者身份确认。可以继续作本轮假设讨论，既有剧情条件仍然保留。现有资料未找到可供当前角色确认这些后事的依据。`;
  }
  const hypothetical = /如果|假如|假设|倘若|要是/u.test(q);
  const speech = /说些什么|说什么|会说|怎么(?:说|回应|回答)|如何(?:回应|回答)|台词|讲什么|说点|一句|开口/u.test(q);
  const bodyQuestion = /伤|刺中|濒死|垂危|奄奄一息|气息|疼|痛|呼吸|感觉|身体|还能撑|还能活/u.test(q);
  const historicalQuestion = /史料|史实|原文|出处|记载|历史上|真实历史/u.test(q);
  const currentBody = context.characterStatus?.condition ?? 'normal';
  // Explicit recovery is still an adopted state. Source IDs distinguish it
  // from a default normal baseline without revealing the author condition.
  const hasAdoptedBody = currentBody !== 'normal' || Boolean(context.characterStatus?.sourceConditionIds?.length);
  const localBody = hypothetical && asksCurrentBody(scene, q) ? physicalHypothesis(q) : null;
  if (!historicalQuestion && asksCurrentBody(scene, q) && (speech || bodyQuestion || localBody)) {
    if (hasAdoptedBody) {
      // A generic injury hypothetical does not downgrade an already critical
      // adopted state. Explicit recovery is discussed locally, never persisted.
      const severity = { normal: 0, injured: 1, critical: 2 };
      const localRecovery = hypothetical && localBody?.transition === 'recovery' && severity[localBody.condition] < severity[currentBody];
      const localWorsening = hypothetical && severity[localBody?.condition] > severity[currentBody];
      const reactionBody = localRecovery || localWorsening ? localBody.condition : currentBody;
      const bodyLabel = currentBody === 'critical' ? '危重伤势' : currentBody === 'injured' ? '受伤状态' : '身体正常状态';
      const explanation = localRecovery || localWorsening
        ? `本分支已采用的${bodyLabel}仍然保留；【假设讨论】本轮另讨论${localRecovery ? '伤势缓和' : '伤势加重'}后的反应，不覆盖既有状态。`
        : `承接本分支已采用的${bodyLabel}，人物仍然存活；这里只演绎眼前反应。${hypothetical ? '句中的“如果”不清除已有身体状态，本轮额外条件只作讨论。' : ''}`;
      return creativeReaction({ scene, stamp, condition: reactionBody, explanation });
    }
    if (localBody) return creativeReaction({ scene, stamp, condition: localBody.condition, explanation: '【假设讨论】本轮临时设想这一身体状态，并未因此改变已保存的状态或采用新条件。' });
  }
  if (!historicalQuestion && hypothetical && hasAdoptedBody && asksCurrentBody(scene, q)) {
    return creativeReaction({ scene, stamp, condition: currentBody, explanation: '【假设讨论】保留当前已采用的身体状态；本轮额外的可能性仅作讨论，规则模拟只承接眼前反应，不替它确定新的结果。' });
  }
  if (!historicalQuestion && context.conditions?.length && (hypothetical || speech || bodyQuestion)) {
    return adoptedContinuation({ scene, stamp, context, hypothetical });
  }
  if (hypothetical && !historicalQuestion) {
    const self = selfName(scene);
    return `${stamp}\n【假设讨论·角色创作】\n“若情形如此，${self}会先问清眼前的消息，再议下一步。”\n\n创作说明：本轮并未因此改变已经发生的事或采用新条件，已有剧情设定继续保留。这是有限规则模拟，不能据此确定所有后续结果；台词不是史料记载。`;
  }
  if (/记得|之前|刚才|暗号|约定/.test(q)) {
    const prior = (context.messages ?? []).filter(item => item.role === 'user' && item.content !== q).at(-1);
    if (prior) return `${stamp}\n我记得你先前对我说：“${prior.content.slice(0, 180)}”。这是我们之间的交流记忆，只在这条分支的兼容继承中使用，不会因为换了人物就传到别人那里。${context.mode === 'hypothetical' ? '当前仍按已经采用的假设剧情继续。' : '它不自动改变正式历史正文。'}`;
  }
  const source = context.sources?.[0];
  if (source) return `${stamp}\n资料参考（史实基线）：${source.title}，${source.location}。\n${source.excerpt.slice(0, 160)}\n\n资料说明：以上原文只支持相应的历史信息，不是创作台词或当前假设事件的证明。${context.mode === 'hypothetical' ? '当前分支继续保留已采用状态，参考史实不会将它覆盖。' : '人物即时心理与台词需要另行标明创作。'}当前为有限规则模拟，尚未进行真实模型推理。`;
  // Persisted body state is the default for ordinary role conversation, not
  // merely a response to matching injury keywords. Evidence and protected
  // knowledge routes above still take precedence over this bounded fallback.
  if (!historicalQuestion && hasAdoptedBody && asksCurrentBody(scene, q)) {
    return creativeReaction({ scene, stamp, condition: currentBody, explanation: '普通追问继续承接当前已采用的身体状态；规则模拟在这里仅作简短回应，不重置状态，也不据此生成新的剧情事实。' });
  }
  return `${stamp}\n现有资料未找到依据。${intro}，我不能把未获知的事情说成定论。你可以换一个更具体的问题，或查看本章资料；若想谈当前处境与心理，我们可以继续作明确标注的角色演绎。当前是规则驱动的模拟回复，尚未验证真实模型表现。`;
}

function endpoint(baseUrl) {
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw modelError('MODEL_CONFIG', '模型服务地址无效，请检查服务器配置。', false); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw modelError('MODEL_CONFIG', '模型服务地址须为不包含凭据或查询参数的 HTTP(S) 地址。', false);
  if (/\/chat\/completions\/?$/u.test(parsed.pathname)) throw modelError('MODEL_CONFIG', 'MODEL_BASE_URL 应填写 API 根地址，不要填写完整的 /chat/completions 路径。', false);
  return `${parsed.href.replace(/\/+$/, '')}/chat/completions`;
}

function safeError(error, signal, timedOut) {
  if (signal?.aborted) return modelError('GENERATION_CANCELLED', '本次生成已停止；可以保留输入后重试。', false);
  if (timedOut) return modelError('MODEL_TIMEOUT', '模型响应超时；输入已保留，可以稍后重试。', true);
  if (error?.code?.startsWith?.('MODEL_')) return error;
  return modelError('MODEL_UNAVAILABLE', '模型连接中断或暂不可用；输入已保留，可以重试。', true);
}

async function* readSSE(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    while (true) {
      throwAborted(signal);
      const { value, done } = await reader.read();
      try { buffer += done ? decoder.decode() : decoder.decode(value, { stream: true }); }
      catch { throw modelError('MODEL_STREAM_INVALID', '模型流编码异常，本次回复未完成。', false); }
      if (buffer.length > 1024 * 1024) throw modelError('MODEL_STREAM_INVALID', '模型流数据异常，请重试。', false);
      // Retain a trailing CR until the next transport chunk, so both CRLF and
      // legal CR-only SSE line endings work across arbitrary chunk boundaries.
      buffer = buffer.replace(/\r\n/g, '\n').replace(done ? /\r/g : /\r(?!$)/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
      if (done) {
        const trailing = buffer.trim();
        if (trailing) {
          const data = trailing.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) yield data;
        }
        break;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already aborted */ }
    reader.releaseLock();
  }
}

export async function* generateReply({ scene, context, question, signal, config = getModelConfig(), retryBudget, onRejectedDraft }) {
  throwAborted(signal);
  if (config.mode === 'mock') {
    const reply = mockText({ scene, context, question });
    for (let i = 0; i < reply.length; i += 10) {
      throwAborted(signal);
      try { await delay(config.mockDelayMs ?? 18, undefined, { signal }); } catch { throwAborted(signal); }
      throwAborted(signal);
      yield reply.slice(i, i + 10);
    }
    return;
  }
  const status = getModelStatus(config);
  if (!status.readyForLive) throw modelError(status.code === 'MODEL_CONFIG' ? 'MODEL_CONFIG' : 'MODEL_NOT_CONFIGURED', status.message, false);
  const url = endpoint(config.baseUrl);
  const maxRetries = config.maxRetries ?? 1;
  const tokenParameter = config.tokenParameter ?? 'max_tokens';
  const instructionRole = config.instructionRole ?? 'system';
  const structured=config.outputFormat==='role-json' && Boolean(context.characterStatus) && Number.isFinite(scene.year) && typeof scene.identity==='string';
  // Qwen3.5 Omni uses Chat Completions too, with text modality explicitly
  // selected. Native JSON support varies by region, so this profile uses our
  // prompt/schema validation before anything reaches the browser.
  const qwen35Omni=/^qwen3\.5-omni-(?:plus|flash)(?:-\d{4}-\d{2}-\d{2})?$/u.test(config.model);
  const frame={identity:scene.identity,year:scene.year,condition:context.characterStatus?.condition,...(scene.momentId?{moment:scene.momentId}:{})};
  const structuredFields=context.evidencePolicy==='claim-links-v1'?'frame、action、reply、references、answerKind、evidence、sourceGap':'frame、action、reply、references';
  const formatInstruction=structured ? '\n\n只输出JSON对象，不要输出Markdown。字段必须为：'+structuredFields+'。frame必须原样为'+JSON.stringify(frame)+'（服务器当前状态，不是本轮临时假设的结果）。action为0～50字的一句自身声音、气息或姿态；reply为直接回答当前问题的2～5句现代中文，建议100～250字，最多600字；references是本轮实际使用的资料id数组，没有可支持的就为空。所有原文摘录和创作说明由程序生成，不在action/reply里写资料标记或说明。人物只用已给信息讨论选择，不扩写伤口位置、毒物、人物到场/所在或军事行动结果。普通访客可以好奇和假设，角色保持克制、愿意交流。' : context.citationPolicy==='source-quotes-v1' ? '\n\n输出格式：人物正文直接回应。引用只放在另起空行的资料说明：里，逐条写“原样摘录”[资料:对应id]，摘录必须是本轮原文连续文本。末尾另起空行写一句创作说明，纯心理与台词不强求引用。' : '';
  const referenceInstruction=structured ? '\nreferences只可从以下id选择：'+JSON.stringify(context.sources.map(source=>source.id))+'；没有支持时为[]。' : '';
  const evidenceInstruction=structured && context.evidencePolicy==='claim-links-v1' ? '\n补充必填字段answerKind和evidence。answerKind取historical、interpretation、hypothesis、conversation或mixed。纯心理/判断、纯假设或日常记忆交流用对应类型，evidence和references均为[]；不要为了有引用而给假设附历史原文。若混合了有依据的历史经过和自己的判断，使用mixed，只映射历史部分。evidence最多5项，每项为{"statement":"reply中原样存在的连续历史表述，最多180字","sourceIds":["确实支持这句话的本轮id"]}；references必须恰好是这些sourceIds的并集。historical/mixed至少有一项；不能对应时省去无依据的具体细节，资料不足可自然说明并用conversation。不要把推断、计划或如果映射成史实。建议reply不超过180字、evidence用1～3个简短片段以免输出截断。' : '';
  const auditedOptions=structured && context.evidencePolicy==='claim-links-v1'?auditedFacts(context.sources,scene.characterId):[];
  const auditedInstruction=structured && context.evidencePolicy==='claim-links-v1' && auditedOptions.length ? '\n严格格式：以下sourceId已有人工校核事实，不要自行复述其历史部分。在reply需要该事实的位置写[[F编号]]，程序会填入text。对应evidence改用{"factId":"F编号","sourceIds":["该sourceId"]}，不写statement。例：reply="[[F1]]至于为何这样做，我的判断是……"，evidence=[{"factId":"F1","sourceIds":["其对应sourceId"]}]。其他心理、推测及台词自由表达，不能另写历史细节或将推测装入对应原文。没有auditedStatements的资料仍用statement映射。可用事实：'+JSON.stringify(auditedOptions) : '';
  let task=dialogueIntent(question)==='memory'
    ? '只回答本次问及的称呼、来意、代称或约定。被问代称须实际给出原文；没有收到就坦率说不知道，可以请他再说一遍，不编宫廷登记流程证明自己全知。是否同意按前轮真实回复。不转讲秦燕局势，不指责用户提出提示，不沿用旧助手扩写的政治剧情。'
    : /如果|假如|假设|若下次/u.test(question)
      ? '本轮只讨论设想，保留若/如果语气，不颁令、不执行、不宣告新的既成决定。用户主动提供的未来只当说法，不补全未知经过或结局。保留当前已采用的身体状态。'
      : '历史句优先使用F编号。只讲当前材料/场景明确给出的内容，别额外添年龄、经历和具体道具位置。人物判断另说，不把读者当皇帝，不用史书未载解释资料缺口。';
  if(structured && !context.sources?.length && dialogueIntent(question)!=='memory') task+=' 本轮没有检出的史料。直接回答问题、台词、感受或当前身体状态，用conversation或hypothesis，references/evidence均为空数组，不建空sourceIds条目。无需顺带复述背景史事、战争或制度；即使基线里有也不必展开。';
  if(structured && !(context.messages||[]).slice(0,-1).length && /之前|先前|刚才|另一条|上次/u.test(question) && dialogueIntent(question)==='memory') task+=' 服务器确认：当前人物没有先前的本人交流记录。不得把访客与别人的私聊说成自己知道但不愿透露；直接说明没有收到，可请访客在这里再说。';
  task+=' 不增加当前场景、资料和会话都未提供的人名或新的阴谋线索。资料范围不足的解释由sourceGap独立资料区展示，reply不说现有资料、史料未载或史料语焉不详。尤其问到未建立的实名、国籍、官爵时，使用当前称呼或不作认领，不说自己不知道自己是谁。';
  const gapInstruction=structured && context.evidencePolicy==='claim-links-v1'?'\nsourceGap是布尔值：所问具体历史细节当前资料没有提供时为true，程序在独立资料区说明；否则false。缺口的正确表达例：“那个具体细节，我眼下不能确证。”接着只讲可支持的行动。不要解释为什么不知道，不编平日职责、未检查、没清点或没有想起来。F槽都是完整句，独立成句放入reply，不接在“朕欲以”等句子中间。':'';
  const kindInstruction=structured && context.evidencePolicy==='claim-links-v1'?'\n格式一致性最终检查：只有historical或mixed可以使用[[F编号]]，且每个F槽必须在evidence里有factId和对应sourceIds。选择hypothesis、interpretation或conversation时，reply不得含F槽，references和evidence必须同时为[]。可直接讨论因果与心理，不必顺带复述检索到的历史事实。F槽填入的text已经是完整句：直接写“[[F1]]至于我的考虑……”；禁止写“谋划是[[F1]]的方略”或先复述袭击再接[[F1]]。不要在F槽前后重复其同一经过。':'';
  const requestMessages=structured ? context.messages.map((message,index)=>index===context.messages.length-1 && message.role==='user' ? {...message,content:JSON.stringify({current_frame:frame,current_scene:scene.title,visitor:'默认普通访客，不自动是秦王/皇帝、燕使或细作；明确要求扮演身份时只按其给出的设想处理',task,...(context.materialGaps?.length?{material_gap_task:context.materialGaps,sourceGap:true}:{}),question:message.content,format:structuredFields+' JSON'+kindInstruction})} : message) : context.messages;
  let emitted = false;
  let revisionHint='';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwAborted(signal);
    let timedOut = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs ?? 45000);
    timeout.unref?.();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}`, 'Accept': 'text/event-stream' },
        body: JSON.stringify({ model: config.model, messages: [{ role: instructionRole, content: context.system+formatInstruction+referenceInstruction+evidenceInstruction+auditedInstruction+gapInstruction+(structured && attempt?'\n请修订格式：frame逐项复制当前状态；action短于50字，reply直接回答，缺资料时references用空数组。'+revisionHint:'') }, ...requestMessages], stream: true, [tokenParameter]: config.maxTokens ?? 1000, ...(qwen35Omni?{modalities:['text']}:{}), ...(structured && !qwen35Omni?{response_format:{type:'json_object'}}:{}),...(config.temperature!==undefined?{temperature:config.temperature}:{}),...(config.presencePenalty!==undefined?{presence_penalty:config.presencePenalty}:{}), ...(typeof config.enableThinking === 'boolean' ? { enable_thinking: config.enableThinking } : {}) }),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!response.ok) {
        // Read only a recognized machine code. Provider messages may contain
        // private request details and must never be logged or shown.
        let quota=false;
        try{const payload=await response.clone().json();quota=['insufficient_quota','InsufficientQuota'].includes(payload?.error?.code||payload?.code);}catch{/* non-JSON provider errors keep status-based handling */}
        try { await response.body?.cancel(); } catch { /* discard private provider detail */ }
        if(quota) throw modelError('MODEL_QUOTA','模型服务调用额度不足，请检查服务商余额或额度；输入已保留，恢复额度后可重试。',false);
        const retryable = response.status === 429 || response.status >= 500;
        const code = response.status === 401 || response.status === 403 ? 'MODEL_AUTH' : response.status === 429 ? 'MODEL_RATE_LIMIT' : response.status >= 300 && response.status < 400 ? 'MODEL_REDIRECT' : response.status === 400 || response.status === 422 ? 'MODEL_REQUEST_REJECTED' : 'MODEL_HTTP_ERROR';
        const message = code === 'MODEL_AUTH' ? '模型服务拒绝认证，请检查服务器端凭据和权限。'
          : code === 'MODEL_REDIRECT' ? '模型服务返回重定向；本次未跟随，请确认 API 根地址。'
            : code === 'MODEL_REQUEST_REJECTED' ? '模型服务不接受当前请求，请核对模型、令牌参数和指令角色配置；不会自动切换参数试调用。'
              : `模型服务暂未完成请求（HTTP ${response.status}）；请稍后重试。`;
        throw modelError(code, message, retryable);
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw modelError('MODEL_STREAM_INVALID', '模型服务没有返回预期的流式响应，请检查兼容接口。', false);
      let completed = false;
      let contentLength = 0;
      let structuredContent='';
      let finishReason;
      for await (const data of readSSE(response.body, controller.signal)) {
        throwAborted(signal);
        if (data === '[DONE]') { completed = true; break; }
        let chunk;
        try { chunk = JSON.parse(data); } catch { throw modelError('MODEL_STREAM_INVALID', '模型流数据无法解析，请检查服务协议。', false); }
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw modelError('MODEL_STREAM_INVALID', '模型流结构无效，本次回复未完成。', false);
        if (chunk.error) throw modelError('MODEL_PROVIDER_ERROR', '模型服务在生成中返回错误，请稍后重试。', true);
        if (!Array.isArray(chunk.choices)) throw modelError('MODEL_STREAM_INVALID', '模型流缺少有效的输出结构。', false);
        if (!chunk.choices.length) continue; // Standard optional usage-only chunk.
        const choice = chunk.choices.find(item => item?.index === 0) ?? (chunk.choices.length === 1 && chunk.choices[0]?.index === undefined ? chunk.choices[0] : undefined);
        if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw modelError('MODEL_STREAM_INVALID', '模型流没有预期的首个输出。', false);
        if (choice.finish_reason != null && !['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(choice.finish_reason)) throw modelError('MODEL_STREAM_INVALID', '模型流返回未知的完成状态，本次回复未完成。', false);
        if (choice.delta?.tool_calls || choice.delta?.function_call || ['tool_calls', 'function_call'].includes(choice.finish_reason)) throw modelError('MODEL_UNSUPPORTED_OUTPUT', '当前对话接口只接收文本；模型返回了未支持的工具调用，本次回复未完成。', false);
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (choice.delta?.content != null && typeof choice.delta.content !== 'string') throw modelError('MODEL_UNSUPPORTED_OUTPUT', '模型返回了非文本内容，本次回复未完成。', false);
        if (choice.delta?.refusal != null && typeof choice.delta.refusal !== 'string') throw modelError('MODEL_STREAM_INVALID', '模型流拒绝说明格式无效。', false);
        const text = choice?.delta?.content || choice?.delta?.refusal;
        if (typeof text === 'string' && text.length) {
          contentLength += text.length;
          if (contentLength > 40000) throw modelError('MODEL_OUTPUT_LIMIT', '模型输出过长，本次未完成。请缩小问题范围。', false);
          if(structured) structuredContent+=text;
          else {emitted = true;yield text;}
        }
      }
      if (!completed) throw modelError('MODEL_STREAM_INCOMPLETE', '模型连接提前结束，回复尚未完成；请重试。', true);
      if (finishReason === 'length' || finishReason === 'content_filter') throw modelError('MODEL_OUTPUT_INCOMPLETE', '模型回复被截断，本次未提交剧情变化；请缩小问题范围后重试。', true);
      if (!contentLength) throw modelError('MODEL_EMPTY_RESPONSE', '模型未返回可显示的回复，请重试。', true);
      throwAborted(signal);
      if(structured) {
        let rendered;
        try{rendered=renderRoleReply(structuredContent,{scene,context});}
        catch(error){
          // Explicit in-process QA hook only. Never enabled by the HTTP API;
          // default application execution never logs rejected model drafts.
          if(typeof onRejectedDraft==='function') try{await onRejectedDraft({draft:structuredContent,code:error.code,repairHint:error.repairHint||''});}catch{/* diagnostic failure must not change the generation outcome */}
          throw error;
        }
        for(let offset=0;offset<rendered.length;offset+=28) {
          throwAborted(signal);emitted=true;yield rendered.slice(offset,offset+28);
          await delay(6,undefined,{signal});
        }
      }
      return;
    } catch (error) {
      const mapped = safeError(error, signal, timedOut);
      if(mapped.code==='MODEL_ROLE_TONE') revisionHint='正常访客在讨论历史风险，请平静回应他具体问到的内容，可以怀疑消息、询问来源，让交流继续。'+(mapped.repairHint||'');
      else if(mapped.code==='MODEL_ROLE_STATE') revisionHint='将action和reply都与当前characterStatus核对，保持当前伤情和已采用条件，不让史实基线或临时假设覆盖。'+(mapped.repairHint||'');
      else if(mapped.code==='MODEL_ROLE_KNOWLEDGE') revisionHint='只用当前场景明示可知事实，不擅自确认秘密、未发生的结果或访客身份。'+(mapped.repairHint||'');
      else if(mapped.code==='MODEL_ROLE_REPEAT') revisionHint=mapped.repairHint;
      else if(mapped.code==='MODEL_ROLE_TIME') revisionHint='从当前时点分析风险。后续国家灭亡或人物命运尚未发生，只能说可能、若、会，不使用加速了灭亡、已倾覆等回顾口吻。';
      else if(mapped.code==='MODEL_ROLE_NARRATION') revisionHint='以当前人物亲历和当下判断回应；史料书名、原文和出处由独立资料区展示，不声称自己读过记录自身的后世史书。用户明确提供的未来书或假设，只按收到的材料讨论。';
      else if(mapped.code==='MODEL_EVIDENCE_LINK') revisionHint='重新核对answerKind/evidence：纯设想、心理、日常交流使用对应类型且两个数组为空；历史或混合回答只把reply中原样存在的历史部分映射到实际支持它的本轮sourceIds，references恰为映射ID并集。未给依据的数字、地点和经过省略，不扩大原文含义。'+(!context.sources.length?'本轮没有史料可引。只回答眼前的角色交谈和身体状态，answerKind用conversation或hypothesis，两个数组为空，不复述背景历史，不创建sourceIds=[]的对应条目。':'')+(mapped.repairHint||'');
      else if(mapped.code==='MODEL_ROLE_FORMAT') revisionHint='保留当前场景身份；不要添加资料列表外的id，不能确定用空数组。';
      if (attempt < maxRetries && !emitted && mapped.retryable && !timedOut && !signal?.aborted && (!retryBudget || retryBudget.remaining > 0)) {
        if (retryBudget) retryBudget.remaining--;
        try { await delay(150, undefined, { signal }); } catch { throwAborted(signal); }
        continue;
      }
      throw mapped;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}
