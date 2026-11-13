import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {characterIds} from '../server/characters.mjs';
import {retrieve} from '../server/rag.mjs';
import {initialState,getCharacterStatus,adoptCondition} from '../server/world.mjs';
import {validateSuite} from '../scripts/evaluate-dialogue.mjs';
import {validateRoleConsistency} from '../server/role-consistency.mjs';
const read=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const c=read('../content/catalog.json'),audit=read('../content/reviews/major-characters-2026-10-30.json');
const scene=id=>c.scenes.find(s=>s.id===id);
test('each released chapter has a reviewed, completely selectable major-character roster',()=>{
 for(const chapter of c.chapters.filter(x=>x.status==='published')){
  const ids=chapter.majorCharacterIds;
  assert.ok(ids.length>=4);assert.equal(ids.length,new Set(ids).size);
  assert.deepEqual(ids,audit.chapterCharacters[chapter.id]);
  for(const id of ids)assert.ok(c.scenes.some(s=>s.chapterId===chapter.id&&s.characterId===id&&s.status==='published'),`${chapter.id}:${id}`);
 }
 assert.equal(characterIds.length,15);assert.equal(c.scenes.filter(s=>s.status==='published').length,18);
});
test('all nine new scenes have a live role-specific original excerpt and audited facts',()=>{
 for(const id of audit.newSceneIds){
  const s=scene(id);const sources=c.sources.filter(x=>x.published&&x.roleVisible&&x.sceneIds.includes(id));
  assert.ok(sources.length>0,id);assert.ok(sources.every(x=>x.location&&x.excerpt.length>=6&&x.auditedStatements.some(a=>a.characterIds.includes(s.characterId))),id);
  assert.ok(getCharacterStatus(initialState(s),s).alive,id);
 }
});
test('Fan is alive before his decision and is not silently revived in later chapters',()=>{
 const s=scene('fanyuqi-private');assert.equal(getCharacterStatus(initialState(s),s).alive,true);
 for(const later of c.scenes.filter(x=>x.id!==s.id))assert.equal(getCharacterStatus(initialState(later),{...later,characterId:'fanyuqi'}).alive,false,later.id);
 const later=scene('yingzheng-a');assert.throws(()=>adoptCondition(initialState(later),later,{type:'character_status',characterId:'fanyuqi',status:'normal',text:'樊於期恢复。'}),e=>e.code==='SCENE_CONFLICT');
});
test('new early roles never retrieve the death, conquest or attack outcomes in their own phase',()=>{
 const forbidden={
  'fanyuqi-private':['jingke-fanyuqi-death','jingke-outcome'],
  'qinwuyang-before':['jingke-outcome','jingke-attack','jingke-aftermath'],
  'lixin-defeat':['unification-chu-pursuit','unification-title','unification-complete'],
  'qiwangjian-before':['unification-complete','unification-title'],
  'canghaijun-plan':['bolangsha-liuhou-attack','zhangliang-hide','bolangsha-carriage'],
  'bolangshi-before':['bolangsha-liuhou-attack','zhangliang-hide','bolangsha-carriage']
 };
 for(const [id,ids] of Object.entries(forbidden))assert.ok(retrieve({scene:scene(id),question:'行刺失败 死亡 副车 下邳 沙丘 平楚 称皇帝 齐国投降',sources:c.sources,limit:6}).every(s=>!ids.includes(s.id)),id);
 assert.ok(scene('canghaijun-plan').timeLabel.includes('不详'));
 assert.equal(scene('canghaijun-plan').required.unified,undefined);
 assert.equal(scene('canghaijun-plan').yearIsNavigationAnchor,true);
 assert.equal(scene('lixin-defeat').chronologyPrecision,'disputed');
});
test('new character conditions are executable by the shared evaluator without hardcoded two-person limits',()=>{
 const suite=read('../eval/major-character-cases.json');assert.deepEqual(validateSuite(suite),[]);
 assert.deepEqual(new Set(suite.cases.slice(0,9).map(item=>item.steps[0].sceneId)),new Set(audit.newSceneIds));
});

test('an uncertain royal identity is neither affirmed nor disproved by sparse source material',()=>{
 const ctx={scene:scene('canghaijun-plan'),characterStatus:{condition:'normal'},sources:[],conditions:[],events:[],knowledge:[],messages:[]};
 for(const reply of ['我既非海东国王，也不必多说。','我并非海东国王。','我不是海东国王。'])assert.throws(()=>validateRoleConsistency({action:'',reply},ctx),e=>e.code==='MODEL_ROLE_KNOWLEDGE');
 for(const reply of ['称我沧海君便好，单凭称谓不作王号认领。','若你假设我是海东国王，我们可以沿此讨论。'])assert.doesNotThrow(()=>validateRoleConsistency({action:'',reply},ctx));
});

test('Li Xin can speculate on the defeat but cannot turn unsupported enemy motives into confirmed causes',()=>{
 const ctx={scene:scene('lixin-defeat'),characterStatus:{condition:'normal'},sources:[],conditions:[],events:[],knowledge:[],messages:[]};
 assert.throws(()=>validateRoleConsistency({action:'',reply:'我的判断是楚人守土的决心强烈，项燕隐忍待机，在我军疲惫回撤时发动一击。'},ctx),e=>e.code==='MODEL_ROLE_KNOWLEDGE');
 assert.doesNotThrow(()=>validateRoleConsistency({action:'',reply:'我可能低估了对方，若楚军有意等待我军疲惫，便更不该轻进。这是推测。'},ctx));
 assert.throws(()=>validateRoleConsistency({action:'',reply:'如今我已经败归咸阳。'},ctx),e=>e.code==='MODEL_ROLE_KNOWLEDGE');
});

test('a missing date cannot be described as all historical sources having left no record',()=>{
 assert.throws(()=>validateRoleConsistency({action:'',reply:'史料并未留下确切的日子。'},{scene:scene('canghaijun-plan'),characterStatus:{condition:'normal'},sources:[],conditions:[],events:[],knowledge:[],messages:[]}),e=>e.code==='MODEL_ROLE_KNOWLEDGE');
});
