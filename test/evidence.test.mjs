import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceGap } from '../server/evidence.mjs';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { resolve,sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp,root } from '../server/index.mjs';
import { catalog } from './fixtures.mjs';

test('an incomplete corpus cannot imply a complete name roster or universal absence',()=>{
  const result=evidenceGap('宫门外所有侍卫分别叫什么？',[]);
  assert.equal(result.kind,'complete-roster');
  assert.match(result.text,/现有资料未找到/);assert.match(result.text,/不代表断言所有史书/);
  assert.equal(evidenceGap('这段原文中出现的所有名字有哪些？',[]),null);
  assert.equal(evidenceGap('夏无且做了什么？',[]),null);
  assert.equal(evidenceGap('完整名单的名字是什么？',[{evidenceCoverage:['complete_roster']}]),null);
});

test('evidence-only response is explicit, saved once and replayed without a model request',async t=>{
  const scratch=resolve(root,'../../work/reference-tests');mkdirSync(scratch,{recursive:true});
  const dataDir=mkdtempSync(resolve(scratch,'evidence-'));let calls=0;
  const app=createApp({catalog:structuredClone(catalog),dataDir,modelConfig:{mode:'openai-compatible',timeoutMs:5000},generate:async function*(){calls++;yield '不应调用';}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await app.close();assert.ok(resolve(dataDir).startsWith(scratch+sep));rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`,bootResponse=await fetch(base+'/api/bootstrap'),boot=await bootResponse.json();
  const headers={'Cookie':bootResponse.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':boot.csrfToken,'Content-Type':'application/json'};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  const s=await(await post('/api/sessions',{chapterId:'jingke',sceneId:'yingzheng-a'})).json();
  const operation={text:'宫门外所有侍卫分别叫什么？',requestId:randomUUID()};
  for(let i=0;i<2;i++){
    const stream=await(await post(`/api/sessions/${s.id}/messages`,operation)).text();
    assert.match(stream,/"responseKind":"evidence-gap"/);assert.match(stream,/event: done/);assert.doesNotMatch(stream,/event: error/);
    if(i)assert.match(stream,/"replayed":true/);
  }
  const saved=await(await fetch(base+`/api/sessions/${s.id}`,{headers})).json();
  assert.equal(calls,0);assert.equal(saved.messages.length,2);assert.deepEqual(saved.messages[1].citations,[]);
  assert.match(saved.messages[1].content,/【资料核对】/);
});
