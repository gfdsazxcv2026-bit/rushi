import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {createApp,root} from '../server/index.mjs';
import {buildRoleContext,retrieve} from '../server/rag.mjs';
import {validateSuite} from '../scripts/evaluate-dialogue.mjs';
const read=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const catalog=read('../content/catalog.json');
const scene=catalog.scenes.find(s=>s.id==='yingzheng-c');

test('third chapter has paragraph-level fact mapping and actual original-text locations',()=>{
 const review=read('../content/reviews/bolangsha.json');
 const chapter=catalog.chapters.find(c=>c.id==='bolangsha');
 assert.equal(review.chapter.version,chapter.version);assert.equal(review.checkedAt,'2026-10-30');
 assert.deepEqual(review.chapter.paragraphs,chapter.paragraphs);
 assert.ok(review.bodyHanCharacters>=500 && review.bodyHanCharacters<=800);
 for(const claim of review.claims){
  assert.ok(claim.statement && claim.treatment && claim.sourceIds.length);
  for(const number of claim.paragraphs)assert.ok(chapter.paragraphs[number-1]);
  for(const id of claim.sourceIds){const s=catalog.sources.find(s=>s.id===id);assert.ok(s?.published && s.location && s.excerpt && s.excerptCheckedAt==='2026-10-30');}
 }
 assert.ok(chapter.supplements.some(s=>s.title.includes('合读')));
 assert.ok(chapter.supplements.some(s=>s.title.includes('细节')));
});

test('C retrieval excludes named plotters and same-year future itinerary, even when directly requested',()=>{
 const allowed=['unification-title','bolangsha-qin-tour28','bolangsha-qin-search','bolangsha-carriage'];
 for(const question of ['张良在下邳，沧海君派力士，你都知道吗？','搜捕十日后抓到了谁？','之罘刻石 琅邪 归途 沙丘 秦亡','刚才发生什么？如何脱险？']){
  const result=retrieve({scene,question,sources:catalog.sources,limit:6});
  assert.ok(result.every(s=>allowed.includes(s.id)));
  assert.doesNotMatch(result.map(s=>s.excerpt).join(''),/張良|下邳|倉海君|之罘|瑯邪|沙丘/);
 }
 const context=buildRoleContext({scene,question:'刚才博浪沙遇袭的经过，搜捕有什么结果？',sources:catalog.sources});
 assert.ok(context.sources.some(s=>s.id==='bolangsha-qin-search'));
 assert.ok(context.sources.some(s=>s.id==='bolangsha-carriage'));
 assert.equal(scene.identity,'秦始皇');assert.equal(scene.selfAddress,'朕');
 assert.match(scene.knownFacts.join(''),/期限尚未过去/);
});

test('reader-only C excerpts cannot leak into earlier roles or their same-year search results',()=>{
 for(const earlier of catalog.scenes.filter(s=>s.year<-218)){
  assert.ok(!retrieve({scene:earlier,question:'博浪沙 张良 副车 搜捕',sources:catalog.sources,limit:6}).some(s=>s.id.startsWith('bolangsha-')));
 }
 for(const s of catalog.sources.filter(s=>s.sceneIds.includes('yingzheng-c'))){assert.ok(s.auditedStatements?.some(a=>a.characterIds.includes('yingzheng')));}
});

test('C acceptance uses the shared bounded runner with explicit semantic checkpoints',()=>{
 const suite=read('../eval/bolangsha-cases.json');assert.deepEqual(validateSuite(suite),[]);
 assert.ok(suite.cases.length>=5);
 for(const c of suite.cases)assert.ok(c.manualReview.length>=2);
});

test('real catalog API exposes the third chapter, still denies chapter four, and separates visitor sessions',async t=>{
 const scratch=resolve(root,'../../work/bolangsha-api');mkdirSync(scratch,{recursive:true});const dataDir=mkdtempSync(resolve(scratch,'run-'));
 const app=createApp({catalog:structuredClone(catalog),dataDir,modelConfig:{mode:'mock',timeoutMs:5000}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await app.close();assert.ok(dataDir.startsWith(scratch+sep));rmSync(dataDir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}`,bootResponse=await fetch(base+'/api/bootstrap'),boot=await bootResponse.json();
 const headers={Cookie:bootResponse.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':boot.csrfToken,'Content-Type':'application/json'};
 assert.ok(boot.scenes.some(s=>s.id==='yingzheng-c'));
 const chapter=await(await fetch(base+'/api/chapters/bolangsha')).json();assert.equal(chapter.chapter.paragraphs.length,7);
 assert.equal((await fetch(base+'/api/chapters/shaqiu')).status,404);
 const session=await(await fetch(base+'/api/sessions',{method:'POST',headers,body:JSON.stringify({chapterId:'bolangsha',sceneId:scene.id})})).json();
 assert.equal(session.identity,'秦始皇');assert.deepEqual(session.messages,[]);
 assert.equal((await fetch(base+'/api/sessions/'+session.id)).status,404);
 assert.equal((await fetch(base+'/api/sessions/'+session.id,{headers})).status,200);
});
