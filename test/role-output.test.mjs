import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRoleReply } from '../server/role-output.mjs';
import { replyCitations } from '../server/references.mjs';

const scene={identity:'秦王',year:-227};
const context={characterStatus:{condition:'critical'},sources:[{id:'real',excerpt:'秦王發圖，圖窮而匕首見。'}]};
const response={frame:{identity:'秦王',year:-227,condition:'critical'},action:'声音微弱，停顿片刻。',reply:'先把眼前的情况说清。寡人还有事要交代。',references:['real']};

test('structured role output renders canonical quotes without model-authored excerpts',()=>{
  const content=renderRoleReply(JSON.stringify(response),{scene,context});
  assert.match(content,/声音微弱/);assert.match(content,/“秦王發圖，圖窮而匕首見。”\[资料:real\]/);
  assert.doesNotMatch(content,/"frame"|"references"/);
  assert.deepEqual(replyCitations(content,context.sources,'openai-compatible','source-quotes-v1'),['real']);
});

test('wrong identity, year or current bodily state cannot pass a role envelope',()=>{
  for(const changed of [{identity:'秦始皇'},{year:-221},{condition:'normal'}]) assert.throws(()=>renderRoleReply(JSON.stringify({...response,frame:{...response.frame,...changed}}),{scene,context}),e=>e.code==='MODEL_ROLE_FORMAT');
});

test('two phases within the same year must also match the current role frame',()=>{
  const timedScene={...scene,momentId:'jingke-before'};
  const value={...response,frame:{...response.frame,moment:'jingke-after'}};
  assert.throws(()=>renderRoleReply(JSON.stringify(value),{scene:timedScene,context}),e=>e.code==='MODEL_ROLE_FORMAT');
  assert.doesNotThrow(()=>renderRoleReply(JSON.stringify({...value,frame:{...value.frame,moment:'jingke-before'}}),{scene:timedScene,context}));
});

test('no evidence can be answered naturally without fabricated references',()=>{
  const content=renderRoleReply(JSON.stringify({...response,action:'',reply:'现有资料未找到依据，无法列出这些姓名。',references:[]}),{scene,context});
  assert.match(content,/现有资料未找到依据/);assert.deepEqual(replyCitations(content,context.sources,'openai-compatible','source-quotes-v1'),[]);
});

test('unknown sources, injected inline references and oversized role output are rejected',()=>{
  for(const changed of [{references:['invented']},{reply:'无依据[资料:real]'},{action:'字'.repeat(81)},{reply:'字'.repeat(601)},{references:'real'}]) assert.throws(()=>renderRoleReply(JSON.stringify({...response,...changed}),{scene,context}),e=>e.code==='MODEL_ROLE_FORMAT');
});

test('normal visitors can explore risks without being dismissed while historical judgment remains allowed',()=>{
  const normal={...context,question:'如果将来继承出现争执，你现在怎么看？'};
  for(const reply of ['此言大逆不道，但寡人记下。','此言大逆，暂且听之。','若有人敢妄言凶器，寡人必斩其首。','退下！','收起这些无用的假设。']) assert.throws(()=>renderRoleReply(JSON.stringify({...response,reply}),{scene,context:normal}),e=>e.code==='MODEL_ROLE_TONE');
  for(const reply of ['不必退下，寡人愿意听。','荆轲之举大逆不道，然而你可以问其中的缘由。','寡人还未决定继承人；若有争执，须先查清缘由。']) assert.doesNotThrow(()=>renderRoleReply(JSON.stringify({...response,reply}),{scene,context:normal}));
});

test('explicit retrospective perspective is rejected without blocking ordinary plans or supplied future information',()=>{
  assert.throws(()=>renderRoleReply(JSON.stringify({...response,reply:'制度未如后世般定型。'}),{scene,context}),e=>e.code==='MODEL_ROLE_FORMAT');
  for(const reply of ['若有后世，愿少些战乱。','寡人想统一各国法令，尚须商议。']) assert.doesNotThrow(()=>renderRoleReply(JSON.stringify({...response,reply}),{scene,context}));
});
