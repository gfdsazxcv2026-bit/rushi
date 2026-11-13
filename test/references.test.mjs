import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replyCitations } from '../server/references.mjs';
import { createApp, root } from '../server/index.mjs';
import { catalog } from './fixtures.mjs';

test('real citations include only actually marked IDs in first-use order', () => {
  const sources = [{id:'one'}, {id:'two'}, {id:'unused'}];
  assert.deepEqual(replyCitations('表述[资料:two]，另一表述[资料： one]，重复[资料:two]', sources), ['two','one']);
  assert.deepEqual(replyCitations('这是一段创作台词，没有引用。', sources), []);
});

test('unknown, empty and multiple IDs cannot borrow a valid reference', () => {
  for (const id of ['guessed', '', 'one,two', 'one\" SECRET_TEST_ONLY']) {
    assert.throws(() => replyCitations(`正文[资料:${id}]`, [{id:'one'}]), error => error.code === 'MODEL_INVALID_CITATION' && !error.message.includes('SECRET_TEST_ONLY'));
  }
});

test('mock references keep the documented retrieved-material convention', () => {
  assert.deepEqual(replyCitations('模拟回复', [{id:'one'}, {id:'one'}, {id:'two'}], 'mock'), ['one','two']);
});

test('real reply commits actual citations, rejects fabricated IDs and retries without duplicate messages', async t => {
  const scratch=resolve(root,'../../work/reference-tests');mkdirSync(scratch,{recursive:true});
  const dataDir=mkdtempSync(resolve(scratch,'run-'));
  let invalid=true;
  const app=createApp({catalog:structuredClone(catalog),dataDir,env:{VISITOR_REQUESTS_PER_MINUTE:'100'},modelConfig:{mode:'openai-compatible',timeoutMs:5000},generate:async function*(){yield invalid?'资料回答[资料:invented]':'资料回答\n\n资料说明：\n“合成资料荆轲行刺经过”[资料:s-a]';}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await app.close();assert.ok(resolve(dataDir).startsWith(scratch+sep));rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const bootResponse=await fetch(base+'/api/bootstrap');
  const cookie=bootResponse.headers.get('set-cookie').split(';')[0];
  const boot=await bootResponse.json();
  const headers={'Cookie':cookie,'X-CSRF-Token':boot.csrfToken,'Content-Type':'application/json'};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  const session=await (await post('/api/sessions',{chapterId:'jingke',sceneId:'yingzheng-a'})).json();
  const operation={text:'荆轲行刺经过',requestId:randomUUID()};
  const failed=await (await post(`/api/sessions/${session.id}/messages`,operation)).text();
  assert.match(failed,/MODEL_INVALID_CITATION/);
  let saved=await (await fetch(base+`/api/sessions/${session.id}`,{headers})).json();
  assert.equal(saved.messages.filter(m=>m.role==='assistant').length,0);
  assert.equal(saved.knowledge.length,0);
  invalid=false;
  const good=await (await post(`/api/sessions/${session.id}/messages`,operation)).text();
  assert.match(good,/event: done/);
  saved=await (await fetch(base+`/api/sessions/${session.id}`,{headers})).json();
  assert.equal(saved.messages.length,2);
  assert.deepEqual(saved.messages.find(m=>m.role==='assistant').citations,['s-a']);
});

test('quote-only policy rejects fictional citation claims even when the ID exists',()=>{
  const sources=[{id:'one',excerpt:'秦王環柱而走。是時侍醫夏無且以其所奉藥囊提荊軻也。'}];
  assert.deepEqual(replyCitations('寡人记得环柱。\n\n资料说明：\n“秦王環柱而走。”[资料:one]',sources,'openai-compatible','source-quotes-v1'),['one']);
  for(const content of ['匕首折断于柱旁[资料:one]','资料说明：\n“匕首折断于柱旁。”[资料:one]','资料说明：\n“秦王環柱而走。匕首折断。”[资料:one]']) assert.throws(()=>replyCitations(content,sources,'openai-compatible','source-quotes-v1'),e=>e.code==='MODEL_CITATION_UNSUPPORTED');
});

test('a single citation repair resets the draft and commits only the corrected answer',async t=>{
  const scratch=resolve(root,'../../work/reference-tests');mkdirSync(scratch,{recursive:true});
  const dataDir=mkdtempSync(resolve(scratch,'repair-'));let calls=0;
  const app=createApp({catalog:structuredClone(catalog),dataDir,env:{VISITOR_REQUESTS_PER_MINUTE:'100'},modelConfig:{mode:'openai-compatible',timeoutMs:5000,maxRetries:1},generate:async function*({context}){calls++;if(calls===1)yield '未核对的草稿[资料:invented]';else {assert.match(context.system,/引用修订/);yield '现有资料未找到依据，无法列出完整名单。';}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await app.close();assert.ok(resolve(dataDir).startsWith(scratch+sep));rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`,r=await fetch(base+'/api/bootstrap'),boot=await r.json();
  const headers={'Cookie':r.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':boot.csrfToken,'Content-Type':'application/json'};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  const s=await(await post('/api/sessions',{chapterId:'jingke',sceneId:'yingzheng-a'})).json();
  const stream=await(await post(`/api/sessions/${s.id}/messages`,{text:'荆轲行刺经过有哪些依据？',requestId:randomUUID()})).text();
  assert.match(stream,/event: reset/);assert.match(stream,/event: done/);assert.doesNotMatch(stream,/event: error/);assert.equal(calls,2);
  const saved=await(await fetch(base+`/api/sessions/${s.id}`,{headers})).json();assert.equal(saved.messages.length,2);assert.match(saved.messages[1].content,/现有资料未找到依据/);assert.doesNotMatch(saved.messages[1].content,/草稿|invented/);
});

test('an exhausted shared retry budget cannot add a hidden citation attempt',async t=>{
  const scratch=resolve(root,'../../work/reference-tests');mkdirSync(scratch,{recursive:true});
  const dataDir=mkdtempSync(resolve(scratch,'budget-'));let calls=0;
  const app=createApp({catalog:structuredClone(catalog),dataDir,modelConfig:{mode:'openai-compatible',timeoutMs:5000,maxRetries:1},generate:async function*({retryBudget}){calls++;retryBudget.remaining=0;yield '错误引用[资料:invented]';}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await app.close();assert.ok(resolve(dataDir).startsWith(scratch+sep));rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`,r=await fetch(base+'/api/bootstrap'),boot=await r.json();
  const headers={'Cookie':r.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':boot.csrfToken,'Content-Type':'application/json'};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  const s=await(await post('/api/sessions',{chapterId:'jingke',sceneId:'yingzheng-a'})).json();
  const stream=await(await post(`/api/sessions/${s.id}/messages`,{text:'荆轲行刺经过',requestId:randomUUID()})).text();
  assert.match(stream,/MODEL_INVALID_CITATION/);assert.doesNotMatch(stream,/event: reset/);assert.equal(calls,1);
});
