import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getModelConfig, getModelStatus, generateReply } from '../server/model.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = [
  '入史模型检查：默认只检查本项目配置，不发送网络请求。',
  'node scripts/check-model.mjs',
  'node scripts/check-model.mjs --live   明确发送一次可能收费的小请求，不自动重试。',
  'node scripts/check-model.mjs --help',
  '退出码：0=静态配置完整或显式探测通过；2=真实配置不可用；3=探测失败；64=参数错误；130=已取消。',
  '静态通过不代表连接成功；探测通过不代表人物、史料或剧情质量已经验收。',
].join('\n');

/** Returns only safe metadata; intentionally never returns provider text. */
export async function runModelCheck({ argv = [], env = process.env, signal, generate = generateReply } = {}) {
  if (argv.includes('--help')) return { exitCode: 0, result: { check: 'help', networkRequested: false, message: help } };
  if (argv.some(arg => arg !== '--live')) return { exitCode: 64, result: { check: 'configuration', networkRequested: false, code: 'CLI_USAGE', message: '仅支持 --live 或 --help；凭据只能通过服务器环境或本项目 .env 配置。' } };
  let config;
  try { config = getModelConfig(env); }
  catch (error) { return { exitCode: 2, result: { check: 'configuration', networkRequested: false, liveVerified: false, code: 'MODEL_CONFIG', message: error?.code === 'MODEL_CONFIG' ? error.message : '模型配置无效，请检查服务器配置字段；未发送网络请求。' } }; }
  const status = getModelStatus(config);
  const base = { check: argv.includes('--live') ? 'live' : 'configuration', networkRequested: false, liveVerified: false, status };
  if (!status.readyForLive) return { exitCode: 2, result: base };
  if (!argv.includes('--live')) return { exitCode: 0, result: base };
  if (signal?.aborted) return { exitCode: 130, result: { ...base, code: 'GENERATION_CANCELLED', message: '探测已取消，未发送网络请求。' } };
  const probeConfig = { ...config, maxTokens: Math.min(config.maxTokens, 256), timeoutMs: Math.min(config.timeoutMs, 15000), maxRetries: 0 };
  const question = '请仅回答：入史连接正常。';
  const context = { system: '这是一次中文文本流连接检查，请简短回答，不调用工具。', messages: [{ role: 'user', content: question }] };
  const started = Date.now();
  const attempted = { ...base, networkRequested: true, requestLimit: 1, tokenBudget: probeConfig.maxTokens, timeoutMs: probeConfig.timeoutMs };
  try {
    let responseChars = 0;
    for await (const text of generate({ scene: {}, context, question, signal, config: probeConfig })) responseChars += text.length;
    if (!responseChars) throw new Error('EMPTY');
    return { exitCode: 0, result: { ...attempted, liveVerified: true, code: 'MODEL_PROBE_PASSED', responseChars, durationMs: Date.now() - started, message: '一次文本流请求已完成；未输出模型原文。人物与剧情表现仍需另行验收。' } };
  } catch (error) {
    // Even an unexpected provider/library error is mapped to known constants;
    // neither error.message nor the raw endpoint is printed by this tool.
    const cancelled = signal?.aborted || error?.code === 'GENERATION_CANCELLED';
    const knownCodes = new Set(['MODEL_QUOTA', 'MODEL_AUTH', 'MODEL_TIMEOUT', 'MODEL_RATE_LIMIT', 'MODEL_REQUEST_REJECTED', 'MODEL_REDIRECT', 'MODEL_HTTP_ERROR', 'MODEL_STREAM_INVALID', 'MODEL_STREAM_INCOMPLETE', 'MODEL_OUTPUT_INCOMPLETE', 'MODEL_OUTPUT_LIMIT', 'MODEL_EMPTY_RESPONSE', 'MODEL_UNSUPPORTED_OUTPUT', 'MODEL_PROVIDER_ERROR', 'MODEL_UNAVAILABLE']);
    const code = cancelled ? 'GENERATION_CANCELLED' : knownCodes.has(error?.code) ? error.code : 'MODEL_PROBE_FAILED';
    const guidance = {
      MODEL_QUOTA: '模型服务额度不足，请检查该模型的可用额度或余额，输入配置已保留。',
      MODEL_AUTH: '模型服务拒绝认证，请在本地检查密钥及提供商或模型权限。',
      MODEL_REQUEST_REJECTED: '请求参数不兼容，请核对模型名称、令牌参数和指令角色；不会自动换参数试调用。',
      MODEL_TIMEOUT: '探测超时，不能据此判断密钥错误；可以检查网络后明确重试。',
      MODEL_RATE_LIMIT: '模型服务限制了请求，请确认额度或稍后明确重试。',
      MODEL_REDIRECT: '服务地址发生重定向，请确认填写的是正确 API 根地址。',
      MODEL_OUTPUT_INCOMPLETE: '服务已响应但输出被截断，尚未获得完整文本；不会自动提高预算。',
      MODEL_STREAM_INCOMPLETE: '文本流提前中断，尚未完成连接验收。',
      MODEL_UNSUPPORTED_OUTPUT: '服务返回了当前文本接口未支持的内容，请检查模型配置。',
    };
    const message = cancelled ? '本次探测已停止，不会自动重试。' : `${guidance[code] || '本次探测未完成，请根据错误代码检查配置或稍后明确重试。'}未输出供应商原始错误，本次不自动重试。`;
    return { exitCode: cancelled ? 130 : 3, result: { ...attempted, code, message, durationMs: Date.now() - started } };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--help')) {
    try { const file = resolve(root, '.env'); if (existsSync(file)) process.loadEnvFile(file); }
    catch { console.log(JSON.stringify({ check: 'configuration', networkRequested: false, liveVerified: false, code: 'MODEL_ENV_FILE', message: '无法读取本项目 .env；未发送网络请求。' }, null, 2)); process.exitCode = 2; return; }
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  try {
    const { exitCode, result } = await runModelCheck({ argv, signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = exitCode;
  } finally { process.off('SIGINT', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
