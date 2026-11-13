import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hasRetrospectiveOutcome} from '../server/perspective.mjs';
import {renderRoleReply} from '../server/role-output.mjs';
const catalog=JSON.parse(readFileSync(new URL('../content/catalog.json',import.meta.url),'utf8'));
const scene=catalog.scenes.find(s=>s.id==='yingzheng-a');
const context={characterStatus:{condition:'normal'},sources:[],conditions:[],events:[]};
test('the actual ethics reply cannot turn a later outcome into something already completed',()=>{
  const reply='王翦大军压境，燕国再无回旋余地。这种政治上的短视与鲁莽，非但不能救燕，反而加速了其灭亡。';
  assert.equal(hasRetrospectiveOutcome(reply,scene,context),true);
  assert.throws(()=>renderRoleReply(JSON.stringify({frame:{identity:scene.identity,year:scene.year,condition:'normal',moment:scene.momentId},action:'目光微沉。',reply,references:[]}),{scene,context}),e=>e.code==='MODEL_ROLE_TIME');
});
test('forecasts, historical past, negation and explicitly adopted alternative outcomes remain possible',()=>{
  for(const reply of ['此举可能加速燕国灭亡。','寡人担忧燕国会倾覆。','燕国尚未灭亡，眼下仍可议。','周室衰微，诸侯相争。','燕国若再行险，寡人将命军进击。'])assert.equal(hasRetrospectiveOutcome(reply,scene,context),false,reply);
  assert.equal(hasRetrospectiveOutcome('燕国已经灭亡。',scene,{...context,conditions:[{text:'本分支明确采用燕国已灭亡。'}]}),false);
  assert.equal(hasRetrospectiveOutcome('燕国已经灭亡。',{...scene,year:-221},context),false);
});
