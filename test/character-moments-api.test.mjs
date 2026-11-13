import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp,root} from '../server/index.mjs';
import {buildRoleContext} from '../server/rag.mjs';
const catalog=JSON.parse(readFileSync(new URL('../content/catalog.json',import.meta.url),'utf8'));

async function setup(t) {
  const scratch=resolve(root,'../../work/character-moments-api');mkdirSync(scratch,{recursive:true});
  const dataDir=mkdtempSync(resolve(scratch,'run-'));const contexts=[];
  let app;
  async function open(){app=createApp({dataDir,catalog:structuredClone(catalog),env:{VISITOR_REQUESTS_PER_MINUTE:'100'},modelConfig:{mode:'mock',timeoutMs:5000},generate:async function*({scene,context}){contexts.push({scene,context});yield `【模拟接口测试】${scene.characterName}收到这轮交流。`;}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));}
  await open();
  const base=()=>`http://127.0.0.1:${app.server.address().port}`;
  function client(){let cookie,csrf;return {async boot(){const r=await fetch(base()+'/api/bootstrap');cookie=r.headers.get('set-cookie').split(';')[0];const v=await r.json();csrf=v.csrfToken;return v;},async request(path,input){const r=await fetch(base()+path,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,...(input===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,body:r.headers.get('content-type')?.includes('text/event-stream')?await r.text():await r.json()};}};}
  const a=client();await a.boot();
  t.after(async()=>{await app.close();assert.ok(resolve(dataDir).startsWith(scratch+sep));rmSync(dataDir,{recursive:true,force:true});});
  const fresh=async(sceneId)=>{const chapterId=catalog.scenes.find(s=>s.id===sceneId).chapterId;const r=await a.request('/api/sessions',{sceneId,chapterId});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;};
  const send=(session,text)=>a.request(`/api/sessions/${session.id}/messages`,{text,requestId:randomUUID()});
  return {a,fresh,send,contexts,client,get app(){return app;},restart:async()=>{await app.close();await open();}};
}

test('same-year before and after cannot share a live branch or inherited snapshot, including legacy states',async t=>{
  const h=await setup(t),after=await h.fresh('yingzheng-a');
  await h.send(after,'私聊：行刺之后的暗号是长风。');
  let r=await h.a.request(`/api/sessions/${after.id}/switch`,{sceneId:'jingke-before'});assert.equal(r.status,409);assert.equal(r.body.error.code,'TIME_CONFLICT');
  const row=h.app.store.branch(after.branchId,h.app.store.db.prepare('SELECT visitor_id FROM sessions WHERE id=?').get(after.id).visitor_id);
  delete row.state.momentId;delete row.state.momentOrder;
  h.app.store.db.prepare('UPDATE branches SET state=? WHERE id=?').run(JSON.stringify(row.state),after.branchId);
  r=await h.a.request('/api/sessions',{chapterId:'jingke',sceneId:'jingke-before',sourceSessionId:after.id});assert.equal(r.status,409);assert.equal(r.body.error.code,'TIME_CONFLICT');
  const before=await h.fresh('jingke-before');assert.notEqual(before.branchId,after.branchId);assert.equal(before.characterStatus.alive,true);assert.deepEqual(before.messages,[]);assert.deepEqual(before.conditions,[]);
  await h.send(before,'我会遇到什么？');assert.doesNotMatch(JSON.stringify(h.contexts.at(-1).context.messages),/长风/);
});

test('major characters at the same moment share adopted context while keeping private conversations apart',async t=>{
  const h=await setup(t),jing=await h.fresh('jingke-before');await h.send(jing,'这是荆轲的私聊暗号，只有我们知道。');
  const switched=await h.a.request(`/api/sessions/${jing.id}/switch`,{sceneId:'dan-before'});assert.equal(switched.status,200);assert.equal(switched.body.branchId,jing.branchId);assert.deepEqual(switched.body.messages,[]);
  await h.send(switched.body,'你知道我和荆轲私下说过什么吗？');assert.doesNotMatch(JSON.stringify(h.contexts.at(-1).context.messages),/这是荆轲的私聊暗号/);
  const back=await h.a.request(`/api/sessions/${switched.body.id}/switch`,{sceneId:'jingke-before'});assert.equal(back.body.id,jing.id);assert.equal(back.body.messages.length,2);
  const other=h.client();await other.boot();assert.equal((await other.request(`/api/sessions/${jing.id}`)).status,404);
});

test('doctor bodily settings affect the doctor, death stays guarded and new-character critical states block time jumps',async t=>{
  const h=await setup(t),king=await h.fresh('yingzheng-a');const doctor=(await h.a.request(`/api/sessions/${king.id}/switch`,{sceneId:'xiawuju-a'})).body;
  let r=await h.a.request(`/api/sessions/${doctor.id}/conditions`,{type:'character_status',characterId:'xiawuju',status:'critical',text:'夏无且身受重伤、处于濒死状态，但尚未死亡。',operationId:randomUUID()});
  assert.equal(r.status,200);assert.equal(r.body.characterStatus.condition,'critical');
  assert.equal((await h.a.request(`/api/sessions/${king.id}`)).body.characterStatus.condition,'normal');
  r=await h.a.request('/api/sessions',{chapterId:'unification',sceneId:'yingzheng-b',sourceSessionId:doctor.id});assert.equal(r.status,409);assert.match(r.body.error.message,/濒死/);
  r=await h.a.request(`/api/sessions/${doctor.id}/conditions`,{type:'character_dead',characterId:'xiawuju',text:'夏无且已经死亡。',operationId:randomUUID()});assert.equal(r.status,200);
  assert.equal((await h.send(doctor,'继续说')).status,409);
  r=await h.a.request(`/api/sessions/${doctor.id}/conditions`,{type:'character_status',characterId:'xiawuju',status:'normal',text:'夏无且恢复身体。',operationId:randomUUID()});assert.equal(r.status,409);
  await h.restart();assert.equal((await h.a.request(`/api/sessions/${doctor.id}`)).body.characterStatus.alive,false);
});

test('model context filters later phases in the same year from facts, claims and private history',()=>{
  const scene=catalog.scenes.find(s=>s.id==='jingke-before');
  const later={year:-227,momentId:'jingke-after',momentOrder:20};
  const context=buildRoleContext({scene,question:'眼前有什么选择？',conditions:[{...later,text:'FUTURE_CONDITION',visibleTo:['jingke']}],events:[{...later,text:'FUTURE_EVENT',visibleTo:['jingke']}],knowledge:[{...later,text:'FUTURE_CLAIM',characterId:'jingke'}],messages:[{...later,role:'assistant',characterId:'jingke',content:'FUTURE_PRIVATE_HISTORY'}],sources:catalog.sources});
  assert.doesNotMatch(JSON.stringify(context),/FUTURE_/);
});
