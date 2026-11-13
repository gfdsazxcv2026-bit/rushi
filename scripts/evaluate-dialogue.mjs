import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { characterIds } from '../server/characters.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultSuitePath = resolve(projectRoot, 'eval/dialogue-cases.json');
const ACTIONS = new Set(['open', 'adopt', 'chat', 'switch', 'continue', 'inspect', 'denyAccess', 'cancelChat', 'failureProbe']);
const REAL_MODE = 'openai-compatible';
const MAX_CALLS = 60;

export class EvaluationError extends Error {
  constructor(code, message) { super(message); this.name = 'EvaluationError'; this.code = code; }
}
const fail = (code, message) => { throw new EvaluationError(code, message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value, fallback, max) => {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) fail('INVALID_OPTION', `数值选项必须为 1～${max} 的整数。`);
  return number;
};
const redact = value => String(value ?? '').replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[REDACTED]').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/((?:MODEL_)?API[_ -]?KEY|ACCESS_TOKEN|SESSION_SECRET)\s*[:=]\s*[^\s,;"']+/gi, '$1=[REDACTED]');
const safeError = error => error instanceof EvaluationError ? { code: error.code, message: error.message } : { code: 'RUNNER_ERROR', message: '评测请求或执行失败；未记录原始异常或请求头。' };
const at = (value, path) => String(path).split('.').reduce((part, key) => part?.[key], value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stamp = () => new Date().toISOString();

export function stepCallLimit(step) {
  return step.action === 'failureProbe' ? 2 : ['chat', 'cancelChat'].includes(step.action) ? 1 : 0;
}

export function validateSuite(suite) {
  const errors = [];
  if (!plain(suite) || suite.version !== 1 || typeof suite.title !== 'string' || !Array.isArray(suite.cases) || !suite.cases.length) return ['需要 version=1、title 和非空 cases 数组。'];
  const unknown = (value, allowed, label) => { if (plain(value) && Object.keys(value).some(key => !allowed.includes(key))) errors.push(`${label} 含未支持的字段，避免忽略拼写错误。`); };
  unknown(suite, ['$schema', 'version', 'title', 'priorityCaseIds', 'cases'], '验收定义');
  if (suite.cases.length > 30) errors.push('最多允许30个用例。');
  const ids = new Set();
  for (const item of suite.cases) {
    if (!plain(item)) { errors.push('每个用例必须为对象。'); continue; }
    unknown(item, ['id', 'title', 'tags', 'notes', 'manualReview', 'steps'], '用例');
    const id = item?.id;
    if (!/^D\d{2}$/.test(id || '') || ids.has(id)) errors.push(`用例 ID 无效或重复：${id}`);
    ids.add(id);
    if (typeof item.title !== 'string' || !item.title.trim() || !Array.isArray(item.manualReview) || item.manualReview.some(text => typeof text !== 'string' || !text.trim())) errors.push(`${id} 缺少标题或人工复核标准。`);
    if (!Array.isArray(item.steps) || !item.steps.length) { errors.push(`${id} 缺少 steps。`); continue; }
    const aliases = new Set();
    for (const step of item.steps) {
      if (!plain(step) || !ACTIONS.has(step.action)) { errors.push(`${id} 的 action 无效。`); continue; }
      unknown(step, ['action', 'as', 'on', 'from', 'visitor', 'chapterId', 'sceneId', 'text', 'request', 'condition', 'expect', 'operation'], `${id} 步骤`);
      if (['open', 'continue'].includes(step.action) && (typeof step.sceneId !== 'string' || typeof step.chapterId !== 'string')) errors.push(`${id} 创建场景缺少 sceneId/chapterId。`);
      if (['chat', 'cancelChat', 'failureProbe'].includes(step.action) && (typeof step.text !== 'string' || !step.text.trim() || step.text.length > 2000)) errors.push(`${id} 的对话输入须为 1～2000 字。`);
      if (step.action !== 'open' && !aliases.has(step.on || step.from)) errors.push(`${id} 使用了尚未创建的会话别名。`);
      if (['open', 'switch', 'continue'].includes(step.action)) {
        if (!/^[a-z][a-z0-9_-]{0,30}$/.test(step.as || '') || aliases.has(step.as)) errors.push(`${id} 会话别名缺少、无效或重复。`);
        aliases.add(step.as);
      }
      if (step.action === 'adopt' && (!plain(step.condition) || typeof step.condition.text !== 'string' || !step.condition.text.trim())) errors.push(`${id} 设定操作缺少 condition.text。`);
      if (step.expect !== undefined && !plain(step.expect)) errors.push(`${id} 的 expect 必须为对象。`);
      unknown(step.expect, ['status', 'errorCode', 'session', 'unchanged', 'citationsMin', 'absentText'], `${id} expect`);
      if (step.expect?.session !== undefined && !plain(step.expect.session)) errors.push(`${id} 的 expect.session 必须为路径到预期值的对象。`);
      if (step.expect?.status !== undefined && (!Number.isInteger(step.expect.status) || step.expect.status < 100 || step.expect.status > 599)) errors.push(`${id} 的预期HTTP状态无效。`);
      if (step.expect?.citationsMin !== undefined && (!Number.isInteger(step.expect.citationsMin) || step.expect.citationsMin < 0 || step.expect.citationsMin > 12)) errors.push(`${id} 的预期引用数量无效。`);
      if (step.expect?.absentText !== undefined && (!Array.isArray(step.expect.absentText) || step.expect.absentText.some(text => typeof text !== 'string' || !text.length))) errors.push(`${id} 的隔离标记无效。`);
      if (step.expect?.unchanged !== undefined && (!Array.isArray(step.expect.unchanged) || step.expect.unchanged.some(key => !['conditions', 'events', 'knowledge', 'characterStatus', 'mode'].includes(key)))) errors.push(`${id} 的 unchanged 字段无效。`);
      if (step.action === 'denyAccess' && !['read', 'adopt', 'inherit'].includes(step.operation)) errors.push(`${id} denyAccess 的 operation 无效。`);
      if (step.action === 'denyAccess' && (!step.visitor || step.visitor === 'main')) errors.push(`${id} 越权测试须明确使用第二个游客。`);
      if (step.action === 'adopt' && plain(step.condition)) {
        unknown(step.condition, ['text', 'type', 'characterId', 'status', 'knownToCurrent'], `${id} condition`);
        if (step.condition.text?.length > 500) errors.push(`${id} 剧情条件超过500字。`);
        if (step.condition.type !== undefined && !['custom', 'character_status', 'character_dead', 'not_unified'].includes(step.condition.type)) errors.push(`${id} 条件类型无效。`);
        if (['character_status', 'character_dead'].includes(step.condition.type) && !characterIds.includes(step.condition.characterId)) errors.push(`${id} 条件缺少有效人物。`);
        if (step.condition.type === 'character_status' && !['normal', 'injured', 'critical'].includes(step.condition.status)) errors.push(`${id} 身体状态无效。`);
        if (step.condition.knownToCurrent !== undefined && typeof step.condition.knownToCurrent !== 'boolean') errors.push(`${id} 知情标记须为布尔值。`);
      }
    }
    if (item.steps.reduce((sum, step) => sum + stepCallLimit(step), 0) > 3) errors.push(`${id} 最多允许 3 次对话提交（含取消、重试）。`);
  }
  if (suite.priorityCaseIds !== undefined && (!Array.isArray(suite.priorityCaseIds) || new Set(suite.priorityCaseIds).size !== suite.priorityCaseIds.length || suite.priorityCaseIds.some(id => !ids.has(id)))) errors.push('priorityCaseIds须为不重复的已有用例ID。');
  return errors;
}

export function normalizeOptions(options = {}) {
  let base;
  try { base = new URL(options.baseUrl || 'http://127.0.0.1:4317'); } catch { fail('INVALID_URL', '服务网址无效。'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') fail('INVALID_URL', '服务网址须为不含凭据、路径、查询参数或片段的 HTTP(S) 源站。');
  return {
    live: options.live === true,
    baseUrl: base.origin,
    caseIds: options.caseIds ?? null,
    maxCalls: positive(options.maxCalls, 8, MAX_CALLS),
    maxCases: positive(options.maxCases, 3, 30),
    timeoutMs: positive(options.timeoutMs, 90000, 180000),
    modelLabel: typeof options.modelLabel === 'string' ? redact(options.modelLabel).slice(0, 120) : null,
  };
}

export function buildPlan(suite, options = {}) {
  const errors = validateSuite(suite);
  if (errors.length) fail('INVALID_SUITE', errors.join('\n'));
  const config = normalizeOptions(options);
  const wanted = config.caseIds ? new Set(config.caseIds) : null;
  if (wanted && [...wanted].some(id => !suite.cases.some(item => item.id === id))) fail('UNKNOWN_CASE', '请求的用例 ID 不存在。');
  let calls = 0, cases = 0;
  const priority = config.caseIds || suite.priorityCaseIds || [];
  const rank = id => priority.includes(id) ? priority.indexOf(id) : priority.length;
  const selected = suite.cases.filter(item => !wanted || wanted.has(item.id)).sort((a, b) => rank(a.id) - rank(b.id)).map(item => {
    const worstCaseChatSubmissions = item.steps.reduce((sum, step) => sum + stepCallLimit(step), 0);
    const eligible = cases < config.maxCases && calls + worstCaseChatSubmissions <= config.maxCalls;
    if (eligible) { cases++; calls += worstCaseChatSubmissions; }
    return { id: item.id, title: item.title, worstCaseChatSubmissions, eligible, status: eligible ? 'planned' : 'not_run_budget', manualReviewCount: item.manualReview.length };
  });
  return { config, selected, plannedCases: cases, worstCaseChatSubmissions: calls, providerAttemptUpperBound: calls * 2, budgetMeaning: '计数为聊天 HTTP 提交上限；供应商可能由服务器有限重试。金额与 token 未计量，应另由服务器配置限制。' };
}

function check(result, name, passed, evidence) {
  result.automaticChecks.push({ name, status: passed ? 'passed' : 'failed', ...(evidence === undefined ? {} : { evidence }) });
}
function expected(result, step, value, before) {
  const expect = step.expect || {};
  for (const [path, wanted] of Object.entries(expect.session || {})) check(result, `状态 ${path}`, equal(at(value, path), wanted), { expected: wanted, actual: at(value, path) ?? null });
  for (const field of expect.unchanged || []) check(result, `操作未改变 ${field}`, equal(before?.[field], value?.[field]));
}
function summarizeSession(view) {
  return view && { id: view.id, branchId: view.branchId, chapterId: view.chapterId, sceneId: view.sceneId, characterId: view.characterId, identity: view.identity, mode: view.mode, sourceSessionId: view.sourceSessionId ?? null, sourceSnapshotId: view.sourceSnapshotId ?? null, characterStatus: view.characterStatus, conditionsCount: view.conditions?.length ?? 0, eventsCount: view.events?.length ?? 0, knowledgeCount: view.knowledge?.length ?? 0, messagesCount: view.messages?.length ?? 0 };
}

class VisitorClient {
  constructor(base, fetchImpl, timeoutMs) { this.base = base; this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.cookie = ''; this.csrf = ''; }
  async request(path, body, signal) {
    const headers = { ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf }) };
    return this.fetch(`${this.base}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs) });
  }
  async json(path, body) {
    const response = await this.request(path, body);
    let value;
    try { value = await response.json(); } catch { fail('INVALID_RESPONSE', '服务未返回有效 JSON。'); }
    return { status: response.status, value };
  }
  async initialize() {
    const response = await this.request('/api/bootstrap');
    const cookie = response.headers.get('set-cookie');
    const body = await response.json();
    if (response.status !== 200 || !cookie || !body.csrfToken) fail('VISITOR_INIT', '无法创建新的匿名评测身份。');
    if (body.mode !== REAL_MODE) fail('LIVE_MODE_REQUIRED', '服务不是明确的真实模型模式；拒绝把模拟回复记为真实评测。');
    if (body.modelConfigured === false) fail('MODEL_NOT_CONFIGURED', '服务明确报告真实模型配置不完整，停止评测。');
    if (Array.isArray(body.sessions) && body.sessions.length) fail('VISITOR_NOT_EMPTY', '新匿名身份含有既有会话，停止评测。');
    this.cookie = cookie.split(';')[0]; this.csrf = body.csrfToken;
    return body;
  }
}

async function readChat(client, session, text, requestId, { cancel = false } = {}) {
  const controller = new AbortController();
  const response = await client.request(`/api/sessions/${encodeURIComponent(session.id)}/messages`, { text, requestId }, controller.signal);
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    let body = {}; try { body = await response.json(); } catch { /* never retain raw provider or HTTP content */ }
    return { httpStatus: response.status, complete: false, error: { code: String(body.error?.code || 'HTTP_ERROR'), message: redact(body.error?.message || '服务未完成请求。').slice(0, 400), retryable: body.error?.retryable === true }, text: '', events: [] };
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', output = '', done, error, meta, cancelled = false;
  const events = [];
  try {
    while (true) {
      const part = await reader.read();
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const kind = block.match(/^event:\s*(.+)$/m)?.[1];
        const raw = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!kind || !raw) continue;
        let value; try { value = JSON.parse(raw); } catch { fail('INVALID_SSE', '应用流事件无法解析。'); }
        events.push(kind);
        if (kind === 'meta') { meta = { mode: value.mode, replayed: value.replayed === true }; if (value.mode !== REAL_MODE) fail('STREAM_MODE_MISMATCH', '实际流响应不是此前核验的真实模式。'); }
        if (kind === 'reset') output = '';
        if (kind === 'delta') {
          output += String(value.text ?? '');
          if (output.length > 24000) fail('OUTPUT_LIMIT', '评测输出超过本地保存限制，已停止读取。');
          if (cancel && output.length) { cancelled = true; controller.abort(); break; }
        }
        if (kind === 'done') done = value;
        if (kind === 'error') error = { code: String(value.code || 'GENERATION_ERROR'), message: redact(value.message).slice(0, 400), retryable: value.retryable === true };
      }
      if (cancelled || part.done) break;
    }
  } catch (cause) {
    if (!cancelled) error = { ...(cause instanceof EvaluationError ? safeError(cause) : { code: 'TRANSPORT_INTERRUPTED', message: '读取流时连接中断；已保留收到的输出。' }), retryable: !(cause instanceof EvaluationError) };
  } finally { try { await reader.cancel(); } catch { /* aborted body */ } reader.releaseLock(); }
  if (!cancelled && !done && !error) error = { code: 'INCOMPLETE_STREAM', message: '未收到完整 done 事件；不计为完成回复。', retryable: true };
  if (done && (!meta || meta.mode !== REAL_MODE)) error = { code: 'STREAM_MODE_MISMATCH', message: '完整回复缺少可核验的真实模式标记。', retryable: false };
  return { httpStatus: response.status, complete: Boolean(done && !error && !cancelled), cancelled, text: redact(output), meta, error, events, done };
}

async function captureSources(client, ids) {
  const records = [];
  for (const id of [...new Set(ids || [])].slice(0, 12)) {
    let response;
    try { response = await client.json(`/api/sources/${encodeURIComponent(id)}`); }
    catch (error) { records.push({ requestedId: id, status: null, error: safeError(error) }); continue; }
    const source = response.value?.source;
    records.push({ requestedId: id, status: response.status, ...(source ? { source: Object.fromEntries(['id', 'title', 'author', 'location', 'excerpt', 'url', 'published', 'eventYear', 'sceneIds', 'chapterIds'].filter(key => source[key] !== undefined).map(key => [key, typeof source[key] === 'string' ? redact(source[key]) : source[key]])) } : {}) });
  }
  return records;
}

async function executeCase(item, options, runtime) {
  const result = { id: item.id, title: item.title, startedAt: stamp(), execution: 'live_http', automaticChecks: [], turns: [], operations: [], manualReview: item.manualReview.map((criterion, index) => ({ id: `${item.id}-M${index + 1}`, criterion, status: 'pending', reviewer: null, reviewedAt: null, notes: '' })), semanticVerdict: item.manualReview.length ? 'pending_manual_review' : 'not_applicable', status: 'running' };
  const clients = new Map(), sessions = new Map(), requests = new Map();
  const marker = `EVAL_${item.id}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const interpolate = text => String(text).replaceAll('{{marker}}', marker);
  const clientFor = async alias => {
    if (!clients.has(alias)) { const client = new VisitorClient(options.baseUrl, runtime.fetchImpl, options.timeoutMs); await client.initialize(); clients.set(alias, client); }
    return clients.get(alias);
  };
  const view = async (client, session) => {
    const response = await client.json(`/api/sessions/${encodeURIComponent(session.id)}`);
    if (response.status !== 200) fail('SESSION_READ', '无法读取本轮新建的评测会话。');
    return response.value;
  };
  const submit = async (step, client, current, requestId, cancel = false) => {
    if (runtime.chatSubmissions >= options.maxCalls) fail('CALL_BUDGET', '已达到本轮对话提交上限。');
    runtime.chatSubmissions++;
    const startedAt = stamp();
    let response;
    try { response = await readChat(client, current, interpolate(step.text), requestId, { cancel }); }
    catch (error) { response = { httpStatus: null, complete: false, text: '', error: { ...safeError(error), retryable: true }, events: [] }; }
    const sources = response.done?.message?.citations ? await captureSources(client, response.done.message.citations) : [];
    const citations = response.done?.message?.citations || [];
    const markers = [...response.text.matchAll(/\[资料:([^\]\s]+)\]/g)].map(match => match[1]);
    result.turns.push({ action: step.action, startedAt, finishedAt: stamp(), sceneId: current.sceneId, characterId: current.characterId, modelMode: response.meta?.mode || null, input: interpolate(step.text), output: response.text, complete: response.complete, cancelled: response.cancelled === true, httpStatus: response.httpStatus, requestId, ...(response.error ? { error: response.error } : {}), citations, citationMarkers: markers, sources, sessionAfter: summarizeSession(response.done?.session) });
    if (response.complete) {
      check(result, '完整回复非空', Boolean(response.text.trim()));
      check(result, '回复模式保持真实', response.meta?.mode === REAL_MODE);
      check(result, '保存的回复与流式显示一致', redact(response.done?.message?.content) === response.text);
      check(result, '引用 ID 均可追溯到公开资料', sources.length === new Set(citations).size && sources.every(record => record.status === 200 && record.source?.id === record.requestedId && record.source?.published === true));
      check(result, '实际引用标记与保存的引用 ID 一致', equal([...new Set(markers)].sort(), [...new Set(citations)].sort()));
      if (step.expect?.citationsMin !== undefined) check(result, '本轮含要求的资料引用', citations.length >= step.expect.citationsMin, { minimum: step.expect.citationsMin, actual: citations.length });
      if (step.expect?.absentText) for (const secret of step.expect.absentText) check(result, '回复未出现本轮隔离标记', !response.text.includes(interpolate(secret)));
    }
    return response;
  };
  try {
    for (const step of item.steps) {
      const record = sessions.get(step.on || step.from);
      const client = await clientFor(step.visitor || record?.visitor || 'main');
      if (step.action === 'open' || step.action === 'continue' || step.action === 'switch') {
        const path = step.action === 'switch' ? `/api/sessions/${encodeURIComponent(record.value.id)}/switch` : '/api/sessions';
        const body = step.action === 'switch' ? { sceneId: step.sceneId } : { chapterId: step.chapterId, sceneId: step.sceneId, ...(step.action === 'continue' ? { sourceSessionId: record.value.id } : {}) };
        const response = await client.json(path, body);
        const desired = step.expect?.status ?? (step.action === 'switch' ? 200 : 201);
        check(result, `${step.action} HTTP 状态`, response.status === desired, { expected: desired, actual: response.status });
        result.operations.push({ action: step.action, at: stamp(), httpStatus: response.status, sceneId: step.sceneId, ...(response.value.error ? { error: { code: response.value.error.code, message: redact(response.value.error.message) } } : { session: summarizeSession(response.value) }) });
        if (step.expect?.errorCode) check(result, '场景冲突类型', response.value.error?.code === step.expect.errorCode);
        if (response.status < 300) { sessions.set(step.as, { visitor: step.visitor || record?.visitor || 'main', value: response.value }); expected(result, step, response.value); }
        else if (response.status !== desired) break;
        continue;
      }
      if (step.action === 'denyAccess') {
        const path = step.operation === 'read' ? `/api/sessions/${encodeURIComponent(record.value.id)}` : step.operation === 'adopt' ? `/api/sessions/${encodeURIComponent(record.value.id)}/conditions` : '/api/sessions';
        const body = step.operation === 'read' ? undefined : step.operation === 'adopt' ? { text: '评测越权写入应被拒绝', operationId: randomUUID() } : { chapterId: 'unification', sceneId: 'yingzheng-b', sourceSessionId: record.value.id };
        const response = await client.json(path, body);
        check(result, `跨游客 ${step.operation} 被拒绝`, response.status === 404, { actual: response.status });
        result.operations.push({ action: step.action, operation: step.operation, at: stamp(), httpStatus: response.status });
        continue;
      }
      const before = await view(client, record.value);
      if (step.action === 'inspect') { record.value = before; expected(result, step, before); result.operations.push({ action: 'inspect', at: stamp(), session: summarizeSession(before) }); continue; }
      if (step.action === 'adopt') {
        const body = { ...step.condition, text: interpolate(step.condition.text), operationId: randomUUID() };
        const response = await client.json(`/api/sessions/${encodeURIComponent(record.value.id)}/conditions`, body);
        check(result, '明确采用设定的 HTTP 状态', response.status === (step.expect?.status ?? 200), { actual: response.status });
        result.operations.push({ action: 'adopt', at: stamp(), input: body.text, type: body.type ?? 'custom', status: body.status ?? null, knownToCurrent: body.knownToCurrent === true, httpStatus: response.status, session: summarizeSession(response.value) });
        if (response.status < 300) { record.value = response.value; expected(result, step, response.value, before); }
        continue;
      }
      const key = step.request || randomUUID();
      if (!requests.has(key)) requests.set(key, randomUUID());
      const requestId = requests.get(key);
      let response = await submit(step, client, record.value, requestId, step.action === 'cancelChat');
      if (step.action === 'cancelChat') {
        let after;
        for (let attempt = 0; attempt < 12; attempt++) {
          await delay(100); after = await view(client, record.value);
          if (!after.messages?.some(message => message.role === 'user' && message.content === interpolate(step.text) && message.status === 'pending')) break;
        }
        const requestMessages = after.messages?.filter(message => message.role === 'user' && message.content === interpolate(step.text)) || [];
        if (requestMessages.some(message => message.status === 'complete')) { result.unexercised = '取消前服务已完成，未验证取消中的事务路径。'; }
        else { check(result, '观察到真实模式流式片段后取消', response.cancelled === true && response.meta?.mode === REAL_MODE); expected(result, step, after, before); }
        record.value = after; continue;
      }
      if (step.action === 'failureProbe') {
        if (response.complete) result.unexercised = '未观察到自然提供商失败，不将失败恢复路径记为通过。';
        else {
          const failed = await view(client, record.value);
          expected(result, step, failed, before);
          check(result, '失败时保留本轮输入', failed.messages?.some(message => message.role === 'user' && message.content === interpolate(step.text)) === true);
          if (response.error?.retryable) response = await submit(step, client, record.value, requestId);
          if (!response.complete) result.unexercised = '观察到失败，但供应商仍未恢复；失败状态证据已保存，恢复未验证。';
        }
      } else check(result, '对话 HTTP 状态', response.httpStatus === (step.expect?.status ?? 200), { actual: response.httpStatus });
      if (!response.complete && (step.expect?.status ?? 200) < 300 && step.action !== 'failureProbe') check(result, '收到完整应用 done 事件', false, response.error?.code ?? 'incomplete');
      if (step.expect?.errorCode) check(result, '错误类型匹配', response.error?.code === step.expect.errorCode);
      record.value = response.done?.session || await view(client, record.value);
      if (step.action !== 'failureProbe') expected(result, step, record.value, before);
      if (response.complete && step.request) check(result, '同操作仅保留一条用户输入', record.value.messages?.filter(message => message.role === 'user' && message.content === interpolate(step.text)).length === 1);
    }
  } catch (error) { result.error = safeError(error); check(result, '用例执行未发生异常', false, result.error.code); }
  result.finishedAt = stamp();
  result.status = result.automaticChecks.some(entry => entry.status === 'failed') ? 'automatic_failed' : result.unexercised ? 'not_exercised' : item.manualReview.length ? 'awaiting_manual_review' : 'automatic_passed';
  return result;
}

export async function runEvaluation(suite, options = {}, { fetchImpl = globalThis.fetch } = {}) {
  const plan = buildPlan(suite, options), config = plan.config;
  const report = { formatVersion: 1, suiteTitle: suite.title, suiteSha256: createHash('sha256').update(JSON.stringify(suite)).digest('hex'), startedAt: stamp(), timezone: 'Asia/Shanghai', execution: config.live ? 'live_http' : 'plan_only', realModelSemanticVerdict: config.live ? 'pending_manual_review' : 'not_run', warning: '自动检查只判断协议、状态和可追溯性；人工语义标准逐项复核后才可下结论。模式字段来自被测服务，不是模型供应商身份的独立证明。', plan, cases: [], chatSubmissions: 0, providerAttemptUpperBound: 0 };
  if (!config.live) { report.finishedAt = stamp(); return report; }
  const health = await fetchImpl(`${config.baseUrl}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs) });
  const status = await health.json();
  if (!health.ok || status.mode !== REAL_MODE) fail('LIVE_MODE_REQUIRED', '只有显式 --live 且服务处于 openai-compatible 模式才执行对话；当前没有发起对话调用。');
  if (status.modelConfigured === false) fail('MODEL_NOT_CONFIGURED', '服务明确报告真实模型配置不完整；没有发起对话调用。');
  report.service = { mode: status.mode, modelConfigured: status.modelConfigured ?? null, model: typeof status.model === 'string' ? redact(status.model).slice(0, 120) : null, operatorModelLabel: config.modelLabel, providerIdentityIndependentlyVerified: false };
  const runtime = { fetchImpl, chatSubmissions: 0 };
  for (const selected of plan.selected) {
    if (!selected.eligible) { report.cases.push({ id: selected.id, title: selected.title, status: 'not_run_budget', semanticVerdict: 'not_run' }); continue; }
    const item = suite.cases.find(entry => entry.id === selected.id);
    report.cases.push(await executeCase(item, config, runtime));
  }
  report.chatSubmissions = runtime.chatSubmissions;
  report.providerAttemptUpperBound = runtime.chatSubmissions * 2;
  report.finishedAt = stamp();
  report.summary = { automaticFailedCases: report.cases.filter(item => item.status === 'automatic_failed').length, awaitingManualReview: report.cases.filter(item => item.status === 'awaiting_manual_review').length, automaticOnlyPassed: report.cases.filter(item => item.status === 'automatic_passed').length, notExercised: report.cases.filter(item => item.status === 'not_exercised').length, notRunBudget: report.cases.filter(item => item.status === 'not_run_budget').length, semanticPassed: 0 };
  return report;
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--live') { options.live = true; continue; }
    if (['--plan', '--dry-run'].includes(token)) { if (options.live) fail('INVALID_OPTION', '--live 与 --plan/--dry-run 不能同时使用。'); options.live = false; options.planExplicit = true; continue; }
    if (token === '--help') { options.help = true; continue; }
    const key = { '--base-url': 'baseUrl', '--suite': 'suitePath', '--output': 'outputPath', '--max-calls': 'maxCalls', '--max-cases': 'maxCases', '--timeout-ms': 'timeoutMs', '--model-label': 'modelLabel', '--cases': 'caseIds' }[token];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('INVALID_OPTION', '未知选项或缺少参数，请使用 --help。');
    const value = argv[++index];
    options[key] = key === 'caseIds' ? value === 'all' ? null : value.split(',').map(id => id.trim()).filter(Boolean) : value;
  }
  if (options.live && options.planExplicit) fail('INVALID_OPTION', '--live 与 --plan/--dry-run 不能同时使用。');
  return options;
}

export const usage = `入史 Demo 2 对话验收（默认仅计划，不访问服务）
  node scripts/evaluate-dialogue.mjs
  node scripts/evaluate-dialogue.mjs --plan --cases D08,D09,D11
  node scripts/evaluate-dialogue.mjs --live --cases D08,D09,D11 --max-cases 3 --max-calls 8 --model-label 实际模型名称

--base-url http://127.0.0.1:4317  --suite eval/dialogue-cases.json
--output eval/results/指定文件.json  --timeout-ms 90000
默认优先D08/D09/D11，最多3例、8次聊天HTTP提交，最多允许60次。服务器可能重试，金额/token未计量。
每例使用新匿名游客；不导入用户身份。不保存cookie、CSRF或密钥。
--live只核验服务真实模式，实际输出仍须人工逐项复核；不会自动宣称语义通过。
取消只能在捕获流片段后尝试；自然失败未出现时，失败恢复标为未验证。
`;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { process.stdout.write(usage); return; }
  const suite = JSON.parse(await readFile(resolve(options.suitePath || defaultSuitePath), 'utf8'));
  const report = await runEvaluation(suite, options);
  const output = resolve(options.outputPath || resolve(projectRoot, 'eval/results', `${stamp().replaceAll(':', '-')}-${options.live ? 'live' : 'plan'}.json`));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ execution: report.execution, report: output, plannedCases: report.plan.plannedCases, chatSubmissions: report.chatSubmissions, semanticVerdict: report.realModelSemanticVerdict, ...(report.summary ? { summary: report.summary } : {}) }, null, 2) + '\n');
  if (report.summary?.automaticFailedCases) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(JSON.stringify(safeError(error)) + '\n'); process.exitCode = 1; });
