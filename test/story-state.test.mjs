import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { resolve,sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp,root } from '../server/index.mjs';
import { getModelConfig,generateReply } from '../server/model.mjs';
import { initialState,adoptCondition,getCharacterStatus } from '../server/world.mjs';

const question='如果嬴政不小心被刺中了，那他在这个时候会说些什么';
const scratch=resolve(root,'../../work/story-state-tests');mkdirSync(scratch,{recursive:true});
async function setup(t,{injectFailure=false}={}) {
  const directory=mkdtempSync(resolve(scratch,'run-')), captured=[];
  let failOnce=injectFailure;
  const app=createApp({dataDir:directory,env:{VISITOR_REQUESTS_PER_MINUTE:'1000',DAILY_MODEL_REQUESTS:'1000',GLOBAL_DAILY_MODEL_REQUESTS:'10000'},modelConfig:{...getModelConfig({}),mockDelayMs:1},generate:async function*(input){captured.push(structuredClone(input.context));if(failOnce){failOnce=false;yield '未完成模拟片段';throw new Error('synthetic transport failure');}yield* generateReply(input);}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await app.close();assert.ok(directory.startsWith(scratch+sep));rmSync(directory,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const bootstrap=await fetch(url+'/api/bootstrap'),cookie=bootstrap.headers.get('set-cookie').split(';')[0],boot=await bootstrap.json();
  const request=async(path,body,signal)=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':boot.csrfToken})},...(body===undefined?{}:{body:JSON.stringify(body)}),...(signal?{signal}:{})});
  const json=async(path,body)=>{const r=await request(path,body);return {status:r.status,body:await r.json()};};
  const fresh=async(sceneId='yingzheng-a',chapterId='jingke')=>{const r=await json('/api/sessions',{sceneId,chapterId});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;};
  const adopt=async(id,text,extra={})=>json(`/api/sessions/${id}/conditions`,{text,type:'custom',operationId:randomUUID(),...extra});
  const view=async(id)=>(await json(`/api/sessions/${id}`)).body;
  const send=async(id,text,idempotency=randomUUID())=>{
    const r=await request(`/api/sessions/${id}/messages`,{text,requestId:idempotency});const raw=await r.text();
    if(r.status!==200)return {status:r.status,error:JSON.parse(raw).error};
    const event=raw.split('\n\n').find(block=>block.startsWith('event: done'));
    if(!event)return {status:r.status,raw};
    const done=JSON.parse(event.split('\ndata: ')[1]);return {status:r.status,reply:done.message.content,session:done.session};
  };
  return {app,captured,json,request,fresh,adopt,view,send};
}

test('actual catalog + HTTP + actual mock reproduces the user workflow and honors adopted critical state',async t=>{
  const x=await setup(t),s=await x.fresh();const adopted=await x.adopt(s.id,'嬴政处于濒死状态',{knownToCurrent:false});
  assert.equal(adopted.body.characterStatus.condition,'critical');assert.equal(adopted.body.characterStatus.alive,true);assert.deepEqual(adopted.body.conditions[0].visibleTo,[]);
  const response=await x.send(s.id,question);assert.equal(response.status,200);assert.match(response.reply,/角色创作/);assert.match(response.reply,/气息|呼吸|伤|虚弱|濒死/);assert.doesNotMatch(response.reply,/请在.*明确采用|若要把某项条件用于/);
  assert.equal(x.captured[0].characterStatus.condition,'critical');assert.equal(x.captured[0].conditions.length,0);assert.equal(response.session.mode,'hypothetical');assert.equal(response.session.conditions.length,1);
});
test('actual mock continues physical state over multiple turns without turning rescue discussion into recovery',async t=>{
  const x=await setup(t),s=await x.fresh();await x.adopt(s.id,'嬴政重伤濒死');
  const first=await x.send(s.id,'你现在感觉如何？');assert.match(first.reply,/角色创作/);
  for(const followup of ['现在还能继续说话吗？','你还撑得住吗？','接着说吧']) {const reply=await x.send(s.id,followup);assert.match(reply.reply,/角色创作/,followup);assert.match(reply.reply,/气息|呼吸|伤|虚弱|濒死/,followup);assert.equal(reply.session.characterStatus.condition,'critical');}
  const before=await x.view(s.id);await x.send(s.id,'如果李斯赶来救你呢？');const after=await x.view(s.id);
  assert.equal(after.characterStatus.condition,'critical');assert.deepEqual(after.conditions,before.conditions);assert.deepEqual(after.events,before.events);assert.deepEqual(after.knowledge,before.knowledge);
});
test('unadopted injury question gets marked creative discussion without world mutation',async t=>{
  const x=await setup(t),s=await x.fresh(),r=await x.send(s.id,question);
  assert.match(r.reply,/角色创作|假设讨论/);assert.equal(r.session.mode,'historical');assert.equal(r.session.characterStatus.condition,'normal');assert.equal(r.session.conditions.length,0);assert.equal(r.session.events.length,0);
});
test('own-body awareness does not leak another person secret in the same author condition',async t=>{
  const x=await setup(t),s=await x.fresh();await x.adopt(s.id,'嬴政重伤濒死；李斯的秘密口令是 PRIVATE_LISI_CRITICAL_887');
  await x.send(s.id,'你现在会说什么？');const context=JSON.stringify(x.captured.at(-1));assert.equal(x.captured.at(-1).characterStatus.condition,'critical');assert.ok(!context.includes('PRIVATE_LISI_CRITICAL_887'));assert.ok(!context.includes('李斯的秘密口令'));assert.equal(x.captured.at(-1).conditions.length,0);
});
test('another character does not inherit the injured persons body state or author secret',async t=>{
  const x=await setup(t),s=await x.fresh('yingzheng-b','unification');await x.adopt(s.id,'嬴政重伤濒死；伤势原因是 AUTHOR_ONLY_SECRET_772');
  const li=(await x.json(`/api/sessions/${s.id}/switch`,{sceneId:'lisi-b'})).body;await x.send(li.id,'你现在感觉如何？');const context=x.captured.at(-1);assert.equal(context.characterStatus.condition,'normal');assert.equal(context.conditions.length,0);assert.ok(!JSON.stringify(context).includes('AUTHOR_ONLY_SECRET_772'));
  await x.send(li.id,'嬴政重伤濒死。');const v=await x.view(li.id);assert.equal(v.knowledge.at(-1).certainty,'unverified');assert.equal(v.knowledge.at(-1).channel,'用户当面告知');assert.equal(v.characterStatus.condition,'normal');
});
test('injury-only question does not become a received factual announcement',async t=>{
  const x=await setup(t),s=await x.fresh('lisi-b','unification');await x.send(s.id,'你知道嬴政是否受伤了吗？');assert.equal((await x.view(s.id)).knowledge.length,0);
});
test('legacy private custom critical condition works without editing or rewriting its saved record',async t=>{
  const x=await setup(t),s=await x.fresh();const session=x.app.store.db.prepare('SELECT * FROM sessions WHERE id=?').get(s.id);const branch=x.app.store.branch(session.branch_id,session.visitor_id);
  const original={id:'legacy-original-887',text:'嬴政处于濒死状态',type:'custom',visibleTo:[],source:'用户明确采用',year:-227,createdAt:'2026-10-26T16:00:00.000Z'};
  branch.state.conditions.push(original);branch.state.mode='hypothetical';x.app.store.transaction(()=>x.app.store.updateState(branch.id,session.visitor_id,branch.state));
  const r=await x.send(s.id,question);assert.equal(r.session.characterStatus.condition,'critical');assert.match(r.reply,/角色创作/);assert.deepEqual(r.session.conditions[0],original);
});
test('critical time gap is rejected until the source explicitly resolves recovery',async t=>{
  const x=await setup(t),s=await x.fresh();await x.adopt(s.id,'嬴政处于濒死状态');
  const blocked=await x.json('/api/sessions',{chapterId:'unification',sceneId:'yingzheng-b',sourceSessionId:s.id});assert.equal(blocked.status,409);assert.match(blocked.body.error.message,/濒死|结果尚未明确/);
  const recovered=await x.adopt(s.id,'嬴政获救后已经恢复',{type:'character_status',characterId:'yingzheng',status:'normal'});assert.equal(recovered.body.characterStatus.condition,'normal');assert.equal(recovered.body.mode,'hypothetical');
  for(const question of ['现在身体怎么样？','接着说吧']) {const reaction=await x.send(s.id,question);assert.match(reaction.reply,/角色创作/);assert.doesNotMatch(reaction.reply,/现有资料未找到依据/);assert.equal(reaction.session.characterStatus.condition,'normal');assert.equal(reaction.session.mode,'hypothetical');}
  const child=await x.json('/api/sessions',{chapterId:'unification',sceneId:'yingzheng-b',sourceSessionId:s.id});assert.equal(child.status,201);assert.equal(child.body.mode,'hypothetical');assert.equal(child.body.characterStatus.condition,'normal');
});
test('new source critical state does not mutate an existing child or historical restart',async t=>{
  const x=await setup(t),s=await x.fresh();const child=(await x.json('/api/sessions',{chapterId:'unification',sceneId:'yingzheng-b',sourceSessionId:s.id})).body;await x.adopt(s.id,'嬴政濒死');
  assert.equal((await x.view(child.id)).characterStatus.condition,'normal');assert.equal((await x.fresh('yingzheng-b','unification')).conditions.length,0);assert.equal((await x.view(s.id)).characterStatus.condition,'critical');
});
test('dead is distinct from critical and cannot be revived with recovery preset',async t=>{
  const x=await setup(t),s=await x.fresh();await x.adopt(s.id,'嬴政已经死亡',{type:'character_dead',characterId:'yingzheng'});
  assert.equal((await x.send(s.id,'你会说什么？')).status,409);assert.equal(x.captured.length,0);
  assert.equal((await x.adopt(s.id,'嬴政已经恢复',{type:'character_status',characterId:'yingzheng',status:'normal'})).status,409);assert.equal((await x.view(s.id)).characterStatus.alive,false);
});
test('a failed generation preserves the adopted state and retry does not duplicate it',async t=>{
  const x=await setup(t,{injectFailure:true}),s=await x.fresh();await x.adopt(s.id,'嬴政濒死');const id=randomUUID();const failed=await x.send(s.id,'你会说什么？',id);assert.match(failed.raw,/event: error/);assert.equal((await x.view(s.id)).characterStatus.condition,'critical');
  const success=await x.send(s.id,'你会说什么？',id);assert.match(success.reply,/角色创作/);assert.equal(success.session.conditions.length,1);assert.equal(success.session.messages.filter(m=>m.role==='user').length,1);
});
test('cancellation does not clear the explicitly adopted body state',async t=>{
  const x=await setup(t),s=await x.fresh();await x.adopt(s.id,'嬴政濒死');const controller=new AbortController();const r=await x.request(`/api/sessions/${s.id}/messages`,{text:question,requestId:randomUUID()},controller.signal);await r.body.getReader().read();controller.abort();await delay(60);
  const view=await x.view(s.id);assert.equal(view.characterStatus.condition,'critical');assert.equal(view.conditions.length,1);assert.equal(view.mode,'hypothetical');
});
test('formal chapter text is unchanged by body state or hypothetical speech',async t=>{
  const x=await setup(t),s=await x.fresh();const before=(await x.json('/api/chapters/jingke')).body.chapter;await x.adopt(s.id,'嬴政被刺中，处于濒死状态');await x.send(s.id,question);const after=(await x.json('/api/chapters/jingke')).body.chapter;assert.deepEqual(after,before);
});
test('body preset idempotency checks status as well as its description',async t=>{
  const x=await setup(t),s=await x.fresh(),operationId=randomUUID();const body={text:'身体状态',type:'character_status',characterId:'yingzheng',status:'critical',operationId};assert.equal((await x.json(`/api/sessions/${s.id}/conditions`,body)).status,200);assert.equal((await x.json(`/api/sessions/${s.id}/conditions`,{...body,status:'normal'})).status,409);
});
test('a different role cannot bypass unresolved unification after an earlier death',async t=>{
  const x=await setup(t),s=await x.fresh();await x.adopt(s.id,'嬴政已经死亡',{type:'character_dead',characterId:'yingzheng'});const r=await x.json('/api/sessions',{chapterId:'unification',sceneId:'lisi-b',sourceSessionId:s.id});assert.equal(r.status,409);assert.match(r.body.error.message,/统一前已经死亡/);
});
test('bounded physical parser distinguishes critical, negated death and actual death',()=>{
  const scene={characterId:'yingzheng',chapterId:'jingke',year:-227,required:{yingzheng_alive:true}};
  for(const text of ['嬴政濒死但尚未死亡','嬴政濒临死亡','嬴政快死了','秦王生命垂危']) {const s=adoptCondition(initialState(scene),scene,{text});assert.equal(getCharacterStatus(s,scene).condition,'critical',text);assert.equal(getCharacterStatus(s,scene).alive,true,text);}
  for(const text of ['嬴政差点被刺死','嬴政尚未死亡','嬴政没有死亡']) assert.equal(getCharacterStatus(adoptCondition(initialState(scene),scene,{text}),scene).alive,true,text);
  const critical=adoptCondition(initialState(scene),scene,{text:'嬴政重伤濒死'});const notDead=adoptCondition(critical,scene,{text:'嬴政没死'});assert.equal(getCharacterStatus(notDead,scene).condition,'critical');
});
test('negative recovery statements neither heal the character nor resolve a critical time gap',async t=>{
  const x=await setup(t),s=await x.fresh();await x.adopt(s.id,'嬴政处于濒死状态');
  for(const text of ['嬴政尚未脱离生命危险','嬴政并没有脱离危险','嬴政并非已经恢复','嬴政还没有完全恢复']) {const r=await x.adopt(s.id,text);assert.equal(r.body.characterStatus.condition,'critical',text);assert.equal(r.body.characterStatus.alive,true,text);}
  const next=await x.json('/api/sessions',{chapterId:'unification',sceneId:'yingzheng-b',sourceSessionId:s.id});assert.equal(next.status,409);
});
test('other peoples death, owned relations and reported news do not alter the current role body',()=>{
  const scene={characterId:'yingzheng',chapterId:'jingke',year:-227,required:{yingzheng_alive:true}};
  for(const text of ['嬴政的侍卫已经死亡','嬴政亲眼看到刺客死亡','荆轲已经死亡','侍卫受伤','李斯的妻子重伤','听说嬴政已经死亡','李斯说嬴政濒死']) {
    const state=adoptCondition(initialState(scene),scene,{text});assert.equal(getCharacterStatus(state,'yingzheng').alive,true,text);assert.equal(getCharacterStatus(state,'yingzheng').condition,'normal',text);assert.equal(getCharacterStatus(state,'lisi').condition,'normal',text);
  }
  assert.equal(getCharacterStatus(adoptCondition(initialState(scene),scene,{text:'濒死状态'}),'yingzheng').condition,'critical');
});
test('escaping mortal danger is injured, not automatically healed',async t=>{
  const x=await setup(t),s=await x.fresh();await x.adopt(s.id,'嬴政重伤濒死');const escaped=await x.adopt(s.id,'嬴政已经脱离生命危险');assert.equal(escaped.body.characterStatus.condition,'injured');assert.equal(escaped.body.mode,'hypothetical');const healed=await x.adopt(s.id,'嬴政已经痊愈');assert.equal(healed.body.characterStatus.condition,'normal');
});
test('a combined physical and unification condition keeps both effects after recovery',async t=>{
  const x=await setup(t),s=await x.fresh();await x.adopt(s.id,'嬴政濒死，统一没有发生');await x.adopt(s.id,'嬴政已经恢复',{type:'character_status',characterId:'yingzheng',status:'normal'});const r=await x.json('/api/sessions',{chapterId:'unification',sceneId:'yingzheng-b',sourceSessionId:s.id});assert.equal(r.status,409);assert.ok(r.body.error.details.some(item=>item.key==='unified'));
});
