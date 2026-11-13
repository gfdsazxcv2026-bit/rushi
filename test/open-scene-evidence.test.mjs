import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSuite, buildPlan } from '../scripts/evaluate-dialogue.mjs';
import { retrieve, buildRoleContext } from '../server/rag.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const catalog = read('../content/catalog.json');
const suite = read('../eval/open-scene-cases.json');
const wang = catalog.scenes.find(scene => scene.id === 'wangjian-b');
const questionFor = id => suite.cases.find(item => item.id === id).steps.find(step => step.action === 'chat').text;
const sourceFor = id => catalog.sources.find(source => source.id === id);
const additionalIds = ['unification-chu-force-options', 'unification-chu-frequency-return', 'unification-chu-rest'];

test('open-scene matrix remains executable by the existing runner and budgets the first eight groups at eight posts', () => {
  assert.deepEqual(validateSuite(suite), []);
  assert.equal(suite.cases.length, 22);
  const priority = Array.from({ length: 8 }, (_, index) => `D${String(index + 1).padStart(2, '0')}`);
  assert.deepEqual(suite.priorityCaseIds, priority);
  const plan = buildPlan(suite, { caseIds: priority, maxCases: 8, maxCalls: 8 });
  assert.equal(plan.config.live, false);
  assert.equal(plan.plannedCases, 8);
  assert.equal(plan.worstCaseChatSubmissions, 8);
  assert.ok(plan.selected.every(item => item.eligible && item.worstCaseChatSubmissions === 1));
});

test('the original eight scenes retain identity and time/knowledge checkpoints in their priority reviews', () => {
  const temporalChecks = [
    /当前未统一/u, /统一初期/u, /当前为廷尉|不能提前/u, /地图尚未展开/u,
    /地图尚未展开|不回顾.*死亡/u, /不能直接看到咸阳|不能.*确认任务成败/u,
    /亲历/u, /统一初期/u,
  ];
  const covered = [];
  for (let index = 0; index < 8; index++) {
    const item = suite.cases.find(entry => entry.id === `D${String(index + 1).padStart(2, '0')}`);
    const opening = item.steps.find(step => step.action === 'open');
    const scene = catalog.scenes.find(entry => entry.id === opening.sceneId);
    assert.equal(scene?.status, 'published', item.id);
    assert.equal(opening.chapterId, scene.chapterId, item.id);
    assert.equal(opening.expect.session.identity, scene.identity, item.id);
    assert.ok(item.manualReview.length >= 2, item.id);
    const checkpoints = item.manualReview.join('\n');
    assert.ok(checkpoints.includes(scene.identity), `${item.id}: reviewers must check the actual identity`);
    assert.match(checkpoints, temporalChecks[index], `${item.id}: reviewers must check this scene's time or known boundary`);
    covered.push(scene.id);
  }
  assert.equal(new Set(covered).size, 8);
  for(const id of covered) assert.ok(catalog.scenes.some(scene=>scene.id===id && scene.status==='published'));
  // These assertions preserve review coverage, not a semantic model verdict.
});

test('natural D10 retrieves both force proposals and the actual visit to 頻陽 from excerpt text', () => {
  for (const question of ['李信究竟请了多少兵？秦王后来在哪里见你？', questionFor('D10')]) {
    const context = buildRoleContext({ scene: wang, question, sources: catalog.sources });
    const force = context.sources.find(source => source.id === 'unification-chu-force-options');
    const visit = context.sources.find(source => source.id === 'unification-chu-frequency-return');
    assert.ok(force, `${question}: the actual Li Xin force proposal must be retrieved`);
    assert.ok(visit, `${question}: the actual return/visit passage must be retrieved`);
    assert.match(force.excerpt, /李信曰：「不過用二十萬人/u);
    assert.match(force.excerpt, /王翦曰：「非六十萬人不可/u);
    assert.match(visit.excerpt, /自馳如頻陽/u);
    assert.match(visit.excerpt, /見謝王翦/u);
    assert.equal(force.excerpt, sourceFor(force.id).excerpt);
    assert.equal(visit.excerpt, sourceFor(visit.id).excerpt);
    assert.ok(context.sources.length <= 4);
    // A location naming 頻陽 is insufficient: the passage above must say it.
  }
});

test('natural D08 supplies campaign, pursuit and rest excerpts with their material limits in the model prompt', () => {
  const context = buildRoleContext({ scene: wang, question: questionFor('D08'), sources: catalog.sources });
  const expected = ['unification-chu-campaign', 'unification-chu-pursuit', 'unification-chu-rest'];
  for (const id of expected) assert.ok(context.sources.some(source => source.id === id), `${id}: waiting needs the connected events, not merely a related title`);
  assert.ok(context.sources.length <= 4);
  assert.match(context.sources.find(source => source.id === 'unification-chu-rest').excerpt, /親與士卒同食/u);
  const prefix = '本轮可引用原文：';
  const sourceBlock = context.system.split('\n\n').find(part => part.startsWith(prefix));
  assert.ok(sourceBlock, 'model must actually receive the selected material');
  const supplied = JSON.parse(sourceBlock.slice(prefix.length));
  for (const id of expected) {
    const item = supplied.find(source => source.id === id);
    assert.ok(item, id);
    assert.equal(item.excerpt, sourceFor(id).excerpt);
    assert.equal(item.readingNotes, sourceFor(id).readingNotes, `${id}: preserve editorial boundaries in context`);
  }
  assert.match(supplied.find(source => source.id === 'unification-chu-pursuit').readingNotes, /没有说明楚军东移是因为以为王翦怯战/u);
  assert.match(supplied.find(source => source.id === 'unification-chu-rest').readingNotes, /不支持每日巡视|不支持.*楚军具体断粮/u);
});

test('three supplementary Chu passages remain restricted to compatible emperor and Wang Jian scenes', () => {
  for (const id of additionalIds) {
    const source = sourceFor(id);
    assert.ok(source?.published && source.roleVisible, id);
    assert.deepEqual(new Set(source.sceneIds), new Set(['yingzheng-b', 'wangjian-b', ...(id==='unification-chu-force-options'?['lixin-defeat']:[])]), id);
    assert.deepEqual(source.chapterIds, ['unification'], id);
    assert.ok(source.eventYear <= wang.year, id);
  }
  const question = '李信究竟请了多少兵？秦王后来在哪里见你？频阳 二十万 六十万 休整 同食 养精蓄锐';
  for (const scene of catalog.scenes.filter(item => item.status === 'published' && !['yingzheng-b', 'wangjian-b','lixin-defeat'].includes(item.id))) {
    const found = retrieve({ scene, question, sources: catalog.sources, limit: 6 });
    assert.ok(found.every(source => !additionalIds.includes(source.id)), `${scene.id}: Li Si, earlier Qin kings and witnesses gain no new authorization`);
  }
});

test('source links do not bypass the date boundary even for an otherwise compatible role', () => {
  const beforeConquest = { ...wang, year: -227 };
  const found = retrieve({ scene: beforeConquest, question: '征楚等待 频阳 二十万 同食 休整', sources: catalog.sources, limit: 6 });
  assert.ok(found.every(source => !additionalIds.includes(source.id)));
  assert.ok(found.every(source => source.eventYear <= beforeConquest.year));
});

test('the original editorial draft remains archived separately from the reviewed third-chapter release', () => {
  const draft = read('../content/drafts/bolangsha.json');
  assert.equal(draft.draftOnly, true);
  assert.equal(draft.chapter.id, 'bolangsha');
  assert.equal(draft.chapter.status, 'draft');
  assert.equal(draft.chapter.reviewStatus, 'pending');
  assert.ok(draft.chapter.paragraphs.join('').length >= 500, 'real editorial draft exists separately');
  const runtimeChapter = catalog.chapters.find(chapter => chapter.id === draft.chapter.id);
  assert.equal(runtimeChapter.status, 'published');
  assert.equal(runtimeChapter.reviewStatus, 'checked');
  assert.equal(runtimeChapter.version, '1.1.0');
  assert.equal(draft.sceneDraft.status, 'draft');
  const runtimeScenes = catalog.scenes.filter(scene => scene.chapterId === runtimeChapter.id);
  assert.ok(runtimeScenes.length > 0);
  assert.ok(runtimeScenes.every(scene => scene.status === 'published'));
  const draftSourceIds = new Set(draft.sources.map(source => source.id));
  assert.ok(catalog.sources.every(source => !draftSourceIds.has(source.id)), 'draft excerpts are not imported into the published source registry');
  for (const scene of runtimeScenes) assert.ok(retrieve({ scene, question: '博浪沙 张良 铁椎 副车 天下大索', sources: [...catalog.sources, ...draft.sources] }).every(source => !draftSourceIds.has(source.id)));
});
