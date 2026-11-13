import { createApp, root } from '../server/index.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const scratch = resolve(root, 'data/qa-state/recovery-ui-private');
mkdirSync(scratch, { recursive: true });
const dataDir = mkdtempSync(resolve(scratch, 'run-'));
const metrics = { realProviderCalls: 0, fakeGeneratorAttempts: [], dataDir };
const counts = new Map();
function save() { writeFileSync(resolve(dataDir, 'metrics.json'), JSON.stringify(metrics)); }
const app = createApp({ dataDir,
  env: { VISITOR_REQUESTS_PER_MINUTE: '100', DAILY_MODEL_REQUESTS: '1000', GLOBAL_DAILY_MODEL_REQUESTS: '10000' },
  modelConfig: { mode: 'mock', timeoutMs: 900, maxRetries: 0 },
  generate: async function* ({ question, signal }) {
    const marker = question.match(/UI_(?:FAIL|STOP|TIMEOUT|DUP)_ONCE/)?.[0] || 'unexpected';
    const attempt = (counts.get(marker) || 0) + 1; counts.set(marker, attempt);
    metrics.fakeGeneratorAttempts.push({ marker, attempt }); save();
    if (marker === 'UI_FAIL_ONCE' && attempt === 1) { yield '模拟未完成片段，不能保存为完整答复。'; await delay(150, null, { signal }); throw new Error('deterministic fake provider failure'); }
    if (marker === 'UI_STOP_ONCE' && attempt === 1) { yield '模拟正在生成的片段。'; await delay(5000, null, { signal }); }
    if (marker === 'UI_TIMEOUT_ONCE' && attempt === 1) { await delay(5000, null, { signal }); }
    if (marker === 'UI_DUP_ONCE') { yield '模拟较慢的回答。'; await delay(450, null, { signal }); }
    yield `【假提供商界面验收】${marker} 的完整合成答复；不用于人物语义验收。`;
  },
});
await new Promise(done => app.server.listen(0, '127.0.0.1', done));
save();
process.stdout.write(JSON.stringify({ baseUrl: `http://127.0.0.1:${app.server.address().port}`, metricsPath: resolve(dataDir, 'metrics.json') }) + '\n');
process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
process.on('SIGINT', async () => { await app.close(); process.exit(0); });
