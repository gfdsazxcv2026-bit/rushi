import test from 'node:test';
import assert from 'node:assert/strict';
import {renderRoleReply} from '../server/role-output.mjs';
import {validateRoleConsistency} from '../server/role-consistency.mjs';
import {replyCitations} from '../server/references.mjs';

// Synthetic local fixtures. These tests exercise boundaries and do not call a model.
const scene={id:'yingzheng-a',characterId:'yingzheng',identity:'秦王',year:-227,momentId:'jingke-after',required:{unified:false}};
const source={id:'actual-attack-fixture',excerpt:'秦王發圖，圖窮而匕首見。'};
const context={scene,question:'方才发生了什么？具体细节能确认吗？',characterStatus:{condition:'normal',alive:true},sources:[source],conditions:[],events:[],knowledge:[],messages:[],evidencePolicy:'claim-links-v1'};
const role={frame:{identity:'秦王',year:-227,moment:'jingke-after',condition:'normal'},action:'声音稍缓。',reply:'方才地图展开，匕首显露。其他细节不能确认。',references:[source.id],answerKind:'mixed',evidence:[{statement:'方才地图展开，匕首显露。',sourceIds:[source.id]}]};
const render=(value=role,ctx=context)=>renderRoleReply(JSON.stringify(value),{scene:ctx.scene,context:ctx});
const check=(reply,extra={},action='')=>validateRoleConsistency({reply,action},{...context,...extra});
const failsKnowledge=fn=>assert.throws(fn,error=>error.code==='MODEL_ROLE_KNOWLEDGE');

test('sourceGap plus historical evidence appears only in independent source notes with real references',()=>{
  const output=render({...role,sourceGap:true});
  const [body,notes]=output.split('\n\n资料说明：\n');
  assert.equal(body,'声音稍缓。\n\n方才地图展开，匕首显露。其他细节不能确认。');
  assert.doesNotMatch(body,/当前选材|资料未找到/);
  assert.match(notes,/现有资料未找到所问具体细节的依据；这仅说明当前选材的范围。/);
  assert.match(notes,/“秦王發圖，圖窮而匕首見。”\[资料:actual-attack-fixture\]/);
  assert.deepEqual(replyCitations(output,context.sources,'openai-compatible','source-quotes-v1'),[source.id]);
  assert.equal((output.match(/\[资料:/gu)||[]).length,1);
});

test('sourceGap without evidence still opens source notes and creates no citation ID',()=>{
  const output=render({...role,reply:'这个细节我不能确认。',references:[],answerKind:'conversation',evidence:[],sourceGap:true});
  assert.match(output,/这个细节我不能确认。\n\n资料说明：\n现有资料未找到所问具体细节的依据/);
  assert.doesNotMatch(output,/\[资料:|对应表述|“秦王發圖/);
  assert.deepEqual(replyCitations(output,context.sources,'openai-compatible','source-quotes-v1'),[]);
});

test('sourceGap false and absent preserve current and legacy output compatibility',()=>{
  assert.equal(render({...role,sourceGap:false}),render(role));
  const legacyContext={...context};delete legacyContext.evidencePolicy;
  const legacy={...role};delete legacy.answerKind;delete legacy.evidence;
  const output=render(legacy,legacyContext);
  assert.match(output,/\[资料:actual-attack-fixture\]/);
  assert.doesNotMatch(output,/当前选材的范围/);
});

test('sourceGap rejects strings, numeric flags and null instead of treating them as truthy',()=>{
  for(const sourceGap of ['true','false',1,null,[]]) assert.throws(()=>render({...role,sourceGap}),error=>error.code==='MODEL_ROLE_FORMAT');
});

test('an unpublished or fabricated source ID cannot be smuggled in using sourceGap',()=>{
  assert.throws(()=>render({...role,references:['missing-fixture'],sourceGap:true}),error=>error.code==='MODEL_ROLE_FORMAT');
});

test('pre-unification king cannot claim a unified present or call Crown Prince Dan king',()=>{
  for(const reply of ['天下初定，寡人当稳住局势。','六国余孽未除。','燕王丹必定不甘心。']) failsKnowledge(()=>check(reply));
});

test('unknown Yan planning cannot be asserted as personally confirmed by Qin king',()=>{
  for(const reply of ['太子丹遣荆轲持匕首刺寡人，此事已确凿。','燕丹主使了这次刺杀。']) failsKnowledge(()=>check(reply));
});

test('explicitly adopted and visible new unified condition can override the historical baseline',()=>{
  assert.doesNotThrow(()=>check('如今天下初定，寡人要安定四方。',{conditions:[{text:'六国已经统一，此事已经公开，秦王已经获知。',source:'当前明确采用'}]}));
});

test('an adopted condition stating unification is unfinished must not unlock a unified present',()=>{
  failsKnowledge(()=>check('天下初定。',{conditions:[{text:'统一尚未完成，当前仍为战国诸侯并立。',source:'当前明确采用'}]}));
});

test('explicitly verified and visible disclosure can grant Qin king knowledge of the Yan planner',()=>{
  assert.doesNotThrow(()=>check('太子丹主使荆轲行刺，此事寡人已经获知。',{knowledge:[{text:'已经核实并向秦王出示证据：太子丹主使荆轲行刺。',characterId:'yingzheng',certainty:'已确认',channel:'明确告知'}]}));
});

test('pure future hypotheses and historical ethical judgment remain allowed',()=>{
  for(const reply of ['若将来天下初定，寡人会先安顿地方。','如果太子丹主使此事，寡人会先求证。','荆轲以行刺谋改变战局，此举的政治代价值得讨论。']) assert.doesNotThrow(()=>check(reply));
});

test('ordinary transferred and explicitly uncertain planner information is not treated as confirmation',()=>{
  for(const reply of ['你说太子丹遣荆轲来，这仍待核实。','有人转告，太子丹主使此事，真假还待查证。','太子丹是否主使，眼下还不清楚。']) assert.doesNotThrow(()=>check(reply));
});

test('unprovided exact age is rejected and age explicitly supported by current material remains allowed',()=>{
  failsKnowledge(()=>check('寡人今年二十三岁。'));
  assert.doesNotThrow(()=>check('寡人今年三十三岁。',{sources:[{id:'king-age-fixture',excerpt:'秦王今年三十三岁。'}]}));
});

test('another person age or a different sourced age cannot justify a made-up current king age',()=>{
  for(const sources of [[{id:'other-age-fixture',excerpt:'秦舞阳十三岁曾杀人。'}],[{id:'different-king-age-fixture',excerpt:'秦王今年三十三岁。'}]]) failsKnowledge(()=>check('寡人今年二十三岁。',{sources}));
});

test('default visitor is not crowned by ordinary questions, while an explicit royal role is respected',()=>{
  const doctor={...context,scene:{...scene,characterId:'xiawuju',identity:'侍医'}};
  assert.throws(()=>validateRoleConsistency({action:'',reply:'回禀大王，我方才以药囊解围。'},doctor),error=>error.code==='MODEL_ROLE_TONE');
  assert.doesNotThrow(()=>validateRoleConsistency({action:'',reply:'回禀大王，我方才以药囊解围。'},{...doctor,question:'这段假设把我当作秦王，我问你方才经过。'}));
  assert.doesNotThrow(()=>validateRoleConsistency({action:'',reply:'我方才以药囊解围，大王随后脱险。'},doctor));
});
