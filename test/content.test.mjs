import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRoleContext, retrieve } from '../server/rag.mjs';
const c=JSON.parse(readFileSync(new URL('../content/catalog.json',import.meta.url),'utf8'));

test('real catalog has three checked originals and four genuinely unpublished chapters',()=>{
  assert.equal(c.chapters.length,7);assert.equal(c.chapters.filter(x=>x.status==='published' && x.reviewStatus==='checked').length,3);
  for(const chapter of c.chapters) if(chapter.status==='draft'){assert.equal(chapter.paragraphs.length,0);assert.equal(chapter.sourceIds.length,0);}
  assert.match(c.chapters.find(x=>x.id==='jingke').eraLabel,/战国前传/);
});
test('published originals have resolvable source records and their paragraphs are substantial',()=>{
  for(const chapter of c.chapters.filter(x=>x.status==='published')){
    assert.ok(chapter.paragraphs.join('').length>=500);assert.ok(chapter.sourceIds.length>0);
    for(const id of chapter.sourceIds){const source=c.sources.find(s=>s.id===id);assert.ok(source?.published);assert.ok(source.location && source.excerpt);assert.ok(new URL(source.url).protocol==='https:');}
  }
});
test('actual scene A excludes future aftermath and reader-only secret preparation',()=>{
  const scene=c.scenes.find(s=>s.id==='yingzheng-a');
  const sources=retrieve({question:'荆轲行刺安排 后续攻燕 太子丹劫持谋划',scene,sources:c.sources,limit:6});
  assert.ok(sources.every(s=>s.eventYear<=scene.year && s.roleVisible && s.sceneIds.includes(scene.id)));
  const context=buildRoleContext({scene,question:'荆轲行刺经过',sources:c.sources});
  const ids=context.sources.map(s=>s.id);assert.ok(!ids.includes('jingke-plan'));assert.ok(!ids.includes('jingke-aftermath'));assert.ok(!ids.includes('jingke-year'));
});
test('actual role configurations reflect time-specific titles and compatible Li Si survival',()=>{
  const a=c.scenes.find(s=>s.id==='yingzheng-a'),b=c.scenes.find(s=>s.id==='yingzheng-b'),li=c.scenes.find(s=>s.id==='lisi-b');
  assert.equal(a.identity,'秦王');assert.equal(b.identity,'秦始皇');assert.equal(li.identity,'廷尉');assert.equal(li.year,b.year);assert.notEqual(li.required.yingzheng_alive,true);
  for(const chapter of c.chapters.filter(x=>x.status==='published')) {
    assert.ok(chapter.majorCharacterIds?.length);
    assert.deepEqual(new Set(c.scenes.filter(s=>s.status==='published' && s.chapterId===chapter.id).map(s=>s.characterId)),new Set(chapter.majorCharacterIds));
  }
});

test('published characters have explicit moments and pre-attack roles never retrieve the outcome',()=>{
  for(const scene of c.scenes.filter(s=>s.status==='published')) {
    assert.ok(c.characters.some(person=>person.id===scene.characterId));
    assert.ok(scene.momentId && scene.momentLabel && Number.isFinite(scene.momentOrder));
    assert.ok(scene.avatar && scene.selfAddress);
    if(scene.momentId==='unification') assert.equal(scene.worldFacts.dan_alive,false,'统一时太子丹的史实生死基线不能默认为存活');
  }
  for(const id of ['yingzheng-before','jingke-before','dan-before']) {
    const scene=c.scenes.find(s=>s.id===id);
    const result=retrieve({scene,sources:c.sources,question:'荆轲行刺失败 被杀 夏无且 药囊 拔剑 后续攻燕',limit:6});
    assert.ok(result.every(source=>!['jingke-response','jingke-attack','jingke-outcome','jingke-aftermath','jingke-palace-guards'].includes(source.id)),id);
  }
  const doctor=c.scenes.find(s=>s.id==='xiawuju-a');
  assert.ok(!retrieve({scene:doctor,sources:c.sources,question:'太子丹劫持刺杀安排',limit:6}).some(source=>source.id==='jingke-plan'));
});
test('later periods are metadata only and concurrent eras are grouped as periods',()=>{
  assert.ok(c.periods.filter(p=>p.id!=='qin').every(p=>p.status==='coming_soon'));assert.ok(c.periods.some(p=>p.kind==='parallel_period' && /宋/.test(p.name)));assert.ok(c.periods.some(p=>p.kind==='parallel_period' && /南北朝/.test(p.name)));
});
