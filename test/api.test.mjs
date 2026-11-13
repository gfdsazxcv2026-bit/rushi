import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, root } from '../server/index.mjs';
import { catalog } from './fixtures.mjs';

const scratch=resolve(root,'../../work/api-tests');mkdirSync(scratch,{recursive:true});
function client(url) {
  let cookie='', csrf='';
  return {
    async init() {const r=await fetch(url+'/api/bootstrap',{headers:cookie?{Cookie:cookie}:{}});cookie=r.headers.get('set-cookie')?.split(';')[0] || cookie;const b=await r.json();csrf=b.csrfToken;return b;},
    async request(path,body,extra={}) {return fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf}),...extra.headers},...(body===undefined?{}:{body:JSON.stringify(body)}),...(extra.signal?{signal:extra.signal}:{})});},
    async json(path,body) {const r=await this.request(path,body);return {status:r.status,body:await r.json()};},
    get cookie(){return cookie;},get csrf(){return csrf;}
  };
}
async function setup(t, options={}) {
  const dataDir=options.dataDir || mkdtempSync(resolve(scratch,'run-'));
  const app=createApp({catalog:structuredClone(catalog),dataDir,env:{VISITOR_REQUESTS_PER_MINUTE:'100',DAILY_MODEL_REQUESTS:'1000',GLOBAL_DAILY_MODEL_REQUESTS:'10000'},modelConfig:{mode:'mock',timeoutMs:5000},generate:async function*(){yield '合成回复，仅验证接口。';},...options});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${app.server.address().port}`;
  let closed=false;
  const close=async()=>{if(!closed){closed=true;await app.close();}};
  t.after(async()=>{await close();if(!options.keepData){assert.ok(resolve(dataDir).startsWith(scratch+sep),'temporary cleanup stays in work/api-tests');rmSync(dataDir,{recursive:true,force:true});}});
  const a=client(url);await a.init();return {app,url,a,dataDir,close};
}
async function fresh(a,sceneId='yingzheng-a',chapterId='jingke') {const r=await a.json('/api/sessions',{chapterId,sceneId});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}
async function send(a,id,text,requestId=randomUUID()) {const r=await a.request(`/api/sessions/${id}/messages`,{text,requestId});return {status:r.status,text:await r.text(),requestId};}

test('bootstrap only exposes metadata and published scene configs',async t=>{
  const {a}=await setup(t);const b=await a.init();
  assert.equal(b.mode,'mock');assert.equal(b.chapters.length,3);assert.ok(!JSON.stringify(b).includes('DRAFT_SECRET'));assert.ok(!JSON.stringify(b).includes('HIDDEN_SCENE_SECRET'));assert.ok(!('persona' in b.scenes[0]));
});
test('draft reading, source and chat endpoints cannot be bypassed',async t=>{
  const {a}=await setup(t);
  for(const path of ['/api/chapters/bolangsha','/api/sources/s-hidden','/api/sources/s-misconfigured','/api/sources?chapterId=bolangsha'])assert.equal((await a.json(path)).status,404,path);
  assert.equal((await a.json('/api/sessions',{chapterId:'bolangsha',sceneId:'hidden-c'})).status,404);
});
test('POST requires CSRF and rejects cross origin requests',async t=>{
  const {a}=await setup(t);
  assert.equal((await a.request('/api/sessions',{}, {headers:{'X-CSRF-Token':''}})).status,403);
  assert.equal((await a.request('/api/sessions',{}, {headers:{Origin:'https://evil.invalid'}})).status,403);
});
test('two visitors cannot read, alter, switch or inherit each other sessions',async t=>{
  const {a,url}=await setup(t);const session=await fresh(a);const b=client(url);await b.init();
  assert.equal((await b.json(`/api/sessions/${session.id}`)).status,404);
  assert.equal((await b.json(`/api/sessions/${session.id}/conditions`,{text:'篡改',operationId:randomUUID()})).status,404);
  assert.equal((await b.json(`/api/sessions/${session.id}/switch`,{sceneId:'lisi-b'})).status,404);
  assert.equal((await b.json('/api/sessions',{chapterId:'unification',sceneId:'yingzheng-b',sourceSessionId:session.id})).status,404);
});
test('normal hypothetical question does not adopt a condition',async t=>{
  const {a}=await setup(t);const s=await fresh(a);const r=await send(a,s.id,'如果我提醒秦王，会怎样？');assert.equal(r.status,200);assert.match(r.text,/event: done/);
  const v=(await a.json(`/api/sessions/${s.id}`)).body;assert.equal(v.mode,'historical');assert.equal(v.conditions.length,0);assert.equal(v.events.length,0);
});
test('explicit condition is sticky, idempotent and not world knowledge by default',async t=>{
  const {a}=await setup(t);const s=await fresh(a);const input={text:'这条剧情中我佩戴红色腰带',type:'custom',operationId:randomUUID()};
  const x=await a.json(`/api/sessions/${s.id}/conditions`,input);const y=await a.json(`/api/sessions/${s.id}/conditions`,input);
  assert.equal(x.body.mode,'hypothetical');assert.equal(y.body.conditions.length,1);assert.equal(y.body.knowledge.length,0);
  assert.equal((await a.json(`/api/sessions/${s.id}/conditions`,{...input,text:'不同条件'})).status,409);
});
test('continuation inherits own memory but snapshot is immutable after source edits',async t=>{
  const {a,app}=await setup(t);const s=await fresh(a);await send(a,s.id,'我的暗号是秋水。');
  await a.json(`/api/sessions/${s.id}/conditions`,{text:'我佩戴红色腰带',type:'custom',knownToCurrent:true,operationId:randomUUID()});
  const child=await a.json('/api/sessions',{chapterId:'unification',sceneId:'yingzheng-b',sourceSessionId:s.id});assert.equal(child.status,201);assert.equal(child.body.mode,'hypothetical');assert.equal(child.body.conditions.length,1);assert.ok(child.body.sourceSnapshotId);
  await a.json(`/api/sessions/${s.id}/conditions`,{text:'后来又改为蓝色腰带',type:'custom',operationId:randomUUID()});
  const unchanged=(await a.json(`/api/sessions/${child.body.id}`)).body;assert.equal(unchanged.conditions.length,1);
  const branch=app.store.branch(child.body.branchId,app.store.db.prepare('SELECT visitor_id FROM sessions WHERE id=?').get(child.body.id).visitor_id);assert.match(JSON.stringify(branch.inherited.yingzheng),/秋水/);
  const restarted=await fresh(a,'yingzheng-b','unification');assert.equal(restarted.mode,'historical');assert.equal(restarted.conditions.length,0);
});
test('future snapshot cannot be inherited by earlier chapter',async t=>{
  const {a}=await setup(t);const s=await fresh(a,'yingzheng-b','unification');assert.equal((await a.json('/api/sessions',{chapterId:'jingke',sceneId:'yingzheng-a',sourceSessionId:s.id})).status,409);
});

test('snapshot names stay tied to their frozen conversation and exclude other roles',async t=>{
  const {a}=await setup(t);const s=await fresh(a,'yingzheng-b','unification');
  assert.equal(s.snapshots[0].label,'与嬴政开始对话');
  const adopted=(await a.json(`/api/sessions/${s.id}/conditions`,{text:'嬴政处于濒死状态',type:'character_status',characterId:'yingzheng',status:'critical',operationId:randomUUID()})).body;
  const conditionSnapshot=adopted.snapshots[0];assert.equal(conditionSnapshot.label,'设定：嬴政处于濒死状态');
  await send(a,s.id,'你此刻最想留下什么话？');
  const first=(await a.json(`/api/sessions/${s.id}`)).body.snapshots[0];assert.equal(first.label,'你此刻最想留下什么话？');
  await send(a,s.id,'刚才的交代里最应该先做什么？');
  const later=(await a.json(`/api/sessions/${s.id}`)).body.snapshots;
  assert.equal(later.find(item=>item.id===first.id).label,first.label);
  assert.equal(later.find(item=>item.id===first.id).createdAt,first.createdAt);
  assert.equal(later.find(item=>item.id===conditionSnapshot.id).label,conditionSnapshot.label);
  assert.equal(later[0].label,'刚才的交代里最应该先做什么？');
  const li=(await a.json(`/api/sessions/${s.id}/switch`,{sceneId:'lisi-b'})).body;
  assert.ok(!JSON.stringify(li.snapshots).includes('最想留下什么话'));
  const longQuestion='现在我想请你谈一谈'+ '😀'.repeat(25);
  await send(a,li.id,longQuestion);
  const label=(await a.json(`/api/sessions/${li.id}`)).body.snapshots[0].label;
  assert.equal(Array.from(label).length,25);assert.ok(label.endsWith('…'));assert.ok(!label.includes('\ufffd'));
});
test('death prevents dead role reply but compatible other role remains ignorant',async t=>{
  const contexts=[];const {a}=await setup(t,{generate:async function*({context}){contexts.push(context);yield '合成回应';}});const s=await fresh(a,'yingzheng-b','unification');
  await a.json(`/api/sessions/${s.id}/conditions`,{text:'嬴政已经死亡，但消息未公开',type:'character_dead',characterId:'yingzheng',operationId:randomUUID()});
  assert.equal((await send(a,s.id,'你还好吗')).status,409);
  const li=await a.json(`/api/sessions/${s.id}/switch`,{sceneId:'lisi-b'});assert.equal(li.status,200);assert.equal(li.body.branchId,s.branchId);assert.equal(li.body.knowledge.length,0);
  await send(a,li.body.id,'你知道宫中有什么消息吗？');assert.ok(!JSON.stringify(contexts[0]).includes('消息未公开'));assert.equal(contexts[0].conditions.length,0);
});
test('not-unified premise blocks imperial next scene',async t=>{
  const {a}=await setup(t);const s=await fresh(a);await a.json(`/api/sessions/${s.id}/conditions`,{text:'这段剧情中统一没有发生',type:'not_unified',operationId:randomUUID()});
  const r=await a.json('/api/sessions',{chapterId:'unification',sceneId:'yingzheng-b',sourceSessionId:s.id});assert.equal(r.status,409);assert.equal(r.body.error.code,'SCENE_CONFLICT');
});
test('switch shares world but not private chats; user claims are not world edits',async t=>{
  const seen=[];const {a}=await setup(t,{generate:async function*({context}){seen.push(JSON.stringify(context));yield '合成回应';}});const s=await fresh(a,'yingzheng-b','unification');await send(a,s.id,'PRIVATE_QIN_TOKEN_281');
  const li=(await a.json(`/api/sessions/${s.id}/switch`,{sceneId:'lisi-b'})).body;await send(a,li.id,'嬴政已经死了');
  assert.ok(!seen[1].includes('PRIVATE_QIN_TOKEN_281'));
  const liView=(await a.json(`/api/sessions/${li.id}`)).body;assert.equal(liView.mode,'historical');assert.equal(liView.conditions.length,0);assert.equal(liView.knowledge[0].certainty,'unverified');
  const qin=await a.json(`/api/sessions/${li.id}/switch`,{sceneId:'yingzheng-b'});assert.equal(qin.body.id,s.id);assert.equal(qin.body.knowledge.length,0);
});
test('actual outgoing role context excludes draft sources and other persona history',async t=>{
  let captured;const {a}=await setup(t,{generate:async function*({context}){captured=context;yield '合成回应';}});const s=await fresh(a);await send(a,s.id,'荆轲行刺经过');
  const actual=JSON.stringify(captured);assert.ok(!actual.includes('UNCHECKED_CHAPTER_SOURCE'));assert.ok(!actual.includes('DRAFT_SOURCE_SECRET'));assert.ok(!actual.includes('合成资料统一与郡县'));
});
test('identical request id produces one user and one assistant, then replay',async t=>{
  let calls=0;const {a}=await setup(t,{generate:async function*(){calls++;yield '完整回复';}});const s=await fresh(a), id=randomUUID();await send(a,s.id,'同一问题',id);const replay=await send(a,s.id,'同一问题',id);
  assert.match(replay.text,/replayed/);assert.equal(calls,1);assert.equal((await a.json(`/api/sessions/${s.id}`)).body.messages.length,2);assert.equal((await send(a,s.id,'另一个问题',id)).status,409);
});
test('provider failure preserves input, commits no knowledge, retry uses one user message',async t=>{
  let calls=0;const {a}=await setup(t,{generate:async function*(){calls++;if(calls===1){yield '未完成';throw new Error('synthetic failure');}yield '完整回复';}});const s=await fresh(a);const id=randomUUID();const failed=await send(a,s.id,'嬴政已经死了',id);assert.match(failed.text,/event: error/);
  let v=(await a.json(`/api/sessions/${s.id}`)).body;assert.equal(v.knowledge.length,0);assert.equal(v.messages.length,1);assert.equal(v.messages[0].status,'failed');
  await send(a,s.id,'嬴政已经死了',id);v=(await a.json(`/api/sessions/${s.id}`)).body;assert.equal(v.messages.length,2);assert.equal(v.knowledge.length,1);
});
test('abort cancels generation and releases lock without committing knowledge',async t=>{
  let begun;const started=new Promise(r=>begun=r);const {a}=await setup(t,{generate:async function*({signal}){begun();yield '未完成';await delay(1500,null,{signal});yield '应被取消';}});const s=await fresh(a);const controller=new AbortController();const response=await a.request(`/api/sessions/${s.id}/messages`,{text:'嬴政已经死了',requestId:randomUUID()},{signal:controller.signal});await started;const reader=response.body.getReader();await reader.read();controller.abort();await delay(100);
  const v=(await a.json(`/api/sessions/${s.id}`)).body;assert.equal(v.knowledge.length,0);assert.equal(v.messages.length,1);assert.equal(v.messages[0].status,'cancelled');
  assert.equal((await a.json(`/api/sessions/${s.id}/conditions`,{text:'取消后仍可操作',operationId:randomUUID()})).status,200);
});
test('busy branch rejects concurrent mutation and scene switching',async t=>{
  const {a}=await setup(t,{generate:async function*(){yield '开始';await delay(100);yield '结束';}});const s=await fresh(a,'yingzheng-b','unification');const response=await a.request(`/api/sessions/${s.id}/messages`,{text:'测试并发',requestId:randomUUID()});
  assert.equal((await a.json(`/api/sessions/${s.id}/switch`,{sceneId:'lisi-b'})).status,409);assert.equal((await a.json(`/api/sessions/${s.id}/conditions`,{text:'并发改动',operationId:randomUUID()})).status,409);await response.text();
});
test('input, per visitor daily quota and throttle are enforced',async t=>{
  const {a}=await setup(t,{env:{MAX_INPUT_CHARS:'20',DAILY_MODEL_REQUESTS:'1',GLOBAL_DAILY_MODEL_REQUESTS:'20',VISITOR_REQUESTS_PER_MINUTE:'20'}});const s=await fresh(a);assert.equal((await send(a,s.id,'字'.repeat(21))).status,400);await send(a,s.id,'第一个');assert.equal((await send(a,s.id,'第二个')).status,429);
});
test('progress and visitor ownership survive real app restart',async t=>{
  const first=await setup(t,{keepData:true});const s=await fresh(first.a);await send(first.a,s.id,'持久化测试');await first.a.json('/api/progress',{chapterId:'jingke',ratio:0.42,scrollTop:529,scrollExtent:2204,openSections:['source-jingke-entry'],view:'chat',draft:'未发送的输入'});const cookie=first.a.cookie;await first.close();
  const second=await setup(t,{dataDir:first.dataDir});const response=await fetch(second.url+'/api/bootstrap',{headers:{Cookie:cookie}});const b=await response.json();assert.equal(b.sessions[0].id,s.id);assert.equal(b.progress.jingke.ratio,0.42);assert.equal(b.progress.jingke.draft,'未发送的输入');
  const detail=await fetch(second.url+`/api/sessions/${s.id}`,{headers:{Cookie:cookie}});assert.equal((await detail.json()).messages.length,2);
  assert.equal(b.progress.jingke.scrollTop,529);assert.equal(b.progress.jingke.scrollExtent,2204);assert.deepEqual(b.progress.jingke.openSections,['source-jingke-entry']);
});

test('invalid extended reading positions cannot overwrite saved progress',async t=>{
  const {a}=await setup(t);const valid={chapterId:'jingke',ratio:0.42,view:'read',draft:'保留'};
  assert.equal((await a.json('/api/progress',valid)).status,200);
  for(const extra of [{scrollTop:-1},{scrollExtent:'100'},{openSections:'source-entry'},{openSections:['<script>']},{openSections:Array(61).fill('source-entry')}]) assert.equal((await a.json('/api/progress',{...valid,...extra})).status,400);
  assert.deepEqual((await a.init()).progress.jingke.draft,'保留');
});
test('static routes cannot expose credentials, SQLite or server code',async t=>{
  const {url}=await setup(t);for(const path of ['/.env','/data/session-secret','/data/rushi.sqlite','/server/index.mjs','/content/catalog.json','/%2e%2e/server/index.mjs'])assert.equal((await fetch(url+path)).status,404,path);
});
test('analytics validates ownership and separates coming-soon interest',async t=>{
  const {a,app}=await setup(t);assert.equal((await a.json('/api/events',{type:'coming_soon_interest',value:'han'})).status,200);assert.equal((await a.json('/api/events',{type:'fake_completion'})).status,400);assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM analytics WHERE type='coming_soon_interest'").get().n,1);
});
test('embedded hypothetical discussion is not recorded as a received fact',async t=>{
  const {a}=await setup(t);const s=await fresh(a);await send(a,s.id,'我想问，如果嬴政死了会怎样？');const v=(await a.json(`/api/sessions/${s.id}`)).body;assert.equal(v.knowledge.length,0);assert.equal(v.conditions.length,0);
});
test('explicit free-text death is normalized to structured role conflict',async t=>{
  const {a}=await setup(t);const s=await fresh(a);await a.json(`/api/sessions/${s.id}/conditions`,{text:'荆轲行刺成功，嬴政被刺死',type:'custom',operationId:randomUUID()});const r=await send(a,s.id,'继续聊天');assert.equal(r.status,409);
});
test('snapshot attribution cannot substitute another character conversation',async t=>{
  const {a}=await setup(t);const s=await fresh(a,'yingzheng-b','unification');const li=(await a.json(`/api/sessions/${s.id}/switch`,{sceneId:'lisi-b'})).body;const r=await a.json('/api/sessions',{chapterId:'unification',sceneId:'yingzheng-b',sourceSessionId:s.id,sourceSnapshotId:li.snapshots[0].id});assert.equal(r.status,404);
});
test('per minute throttle and whole site daily budget are distinct controls',async t=>{
  const {a,url}=await setup(t,{env:{VISITOR_REQUESTS_PER_MINUTE:'1',DAILY_MODEL_REQUESTS:'10',GLOBAL_DAILY_MODEL_REQUESTS:'1'}});const s=await fresh(a);await send(a,s.id,'一次请求');const throttled=await a.json(`/api/sessions/${s.id}/messages`,{text:'再次请求',requestId:randomUUID()});assert.equal(throttled.body.error.code,'RATE_LIMIT');const b=client(url);await b.init();const sb=await fresh(b);const global=await b.json(`/api/sessions/${sb.id}/messages`,{text:'第二游客',requestId:randomUUID()});assert.equal(global.body.error.code,'DAILY_LIMIT');
});
test('non-object JSON is rejected as a client format error',async t=>{
  const {a}=await setup(t);for(const input of [null,[],42,'wrong'])assert.equal((await a.json('/api/sessions',input)).status,400);
});
test('initial pending-write failure releases branch lock',async t=>{
  const {a,app}=await setup(t);const s=await fresh(a);const original=app.store.transaction.bind(app.store);let once=true;app.store.transaction=fn=>{if(once){once=false;throw new Error('synthetic storage failure');}return original(fn);};assert.equal((await send(a,s.id,'第一次失败')).status,500);assert.match((await send(a,s.id,'重试成功')).text,/event: done/);
});
test('unaware third person does not negate an explicitly adopted death',async t=>{
  const {a}=await setup(t);const s=await fresh(a);await a.json(`/api/sessions/${s.id}/conditions`,{text:'嬴政已经死亡，李斯并未获知',type:'custom',operationId:randomUUID()});assert.equal((await send(a,s.id,'还能说话吗')).status,409);
});
