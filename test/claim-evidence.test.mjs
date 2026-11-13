import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateClaimEvidence,auditedFacts} from '../server/claim-evidence.mjs';
import {renderRoleReply} from '../server/role-output.mjs';
import {replyCitations} from '../server/references.mjs';
import {selectPrivateRecall} from '../server/private-recall.mjs';
import {buildRoleContext} from '../server/rag.mjs';

// These tests establish inspectable links, canonical excerpt rendering and
// isolation. They do not establish that arbitrary prose follows semantically
// from an excerpt; historical support still requires human source review.
const scene={id:'wangjian-b',characterId:'wangjian',characterName:'王翦',identity:'秦将',year:-221,momentId:'unification',momentOrder:10,knownFacts:[]};
const sources=[
  {id:'guard',excerpt:'王翦至，堅壁而守之，不肯戰。'},
  {id:'pursuit',excerpt:'荊數挑戰而秦不出，乃引而東。翦因舉兵追之，令壯士擊，大破荊軍。'},
  {id:'demand',excerpt:'王翦曰：「大王必不得已用臣，非六十萬人不可。」始皇曰：「為聽將軍計耳。」'},
];
const context={evidencePolicy:'claim-links-v1',characterStatus:{condition:'normal'},sources};
const base={frame:{identity:scene.identity,year:scene.year,condition:'normal',moment:scene.momentId},action:'声音平稳，略作停顿。',reply:'我在楚地坚壁不出，随后追击楚军。为何等待，是我当时的判断。',answerKind:'mixed',references:['guard','pursuit'],evidence:[{statement:'我在楚地坚壁不出',sourceIds:['guard']},{statement:'随后追击楚军',sourceIds:['pursuit']}]};
const value=change=>({...structuredClone(base),...change});
const render=(input=base,ctx=context)=>renderRoleReply(JSON.stringify(input),{scene,context:ctx});
const invalid=input=>assert.throws(()=>validateClaimEvidence(input,context),error=>error.code==='MODEL_EVIDENCE_LINK' && error.retryable===true);

test('hypothesis with an unmapped fact slot receives an actionable repair instead of a silent citation rewrite',()=>{
 assert.throws(()=>validateClaimEvidence(value({answerKind:'hypothesis',reply:'若如此，[[F1]]未必决定后来的一切。',references:[],evidence:[]}),context),error=>error.code==='MODEL_EVIDENCE_LINK' && /不得|不可/u.test(error.repairHint) && /mixed/u.test(error.repairHint));
 assert.deepEqual(validateClaimEvidence(value({answerKind:'hypothesis',reply:'若如此，朕也不认为一次袭击便能决定一切。',references:[],evidence:[]}),context),[]);
});

test('claim links render the actual reply spans with server-owned canonical excerpts and compatible citation markers',()=>{
  const output=render();
  assert.match(output,/对应表述：我在楚地坚壁不出/);
  assert.match(output,/对应表述：随后追击楚军/);
  assert.match(output,/“王翦至，堅壁而守之，不肯戰。”\[资料:guard\]/);
  assert.match(output,/不为心理、推断或假设情节提供事实证明/);
  assert.match(output,/声音平稳/);
  assert.deepEqual(replyCitations(output,sources,'openai-compatible','source-quotes-v1'),['guard','pursuit']);
  assert.doesNotMatch(output,/"answerKind"|"evidence"|"sourceIds"/);
});

test('a claim statement must be nonempty, bounded, single-line and literally present in this reply',()=>{
  for(const statement of ['不是这轮回复中的话','', '   ','我在楚地\n坚壁不出','我在楚地\r坚壁不出','字'.repeat(181)]) {
    const input=value({reply:statement || base.reply,evidence:[{statement,sourceIds:['guard']}],references:['guard']});
    if(statement==='不是这轮回复中的话') input.reply=base.reply;
    invalid(input);
  }
  const boundary='字'.repeat(180);
  assert.doesNotThrow(()=>validateClaimEvidence(value({reply:boundary,evidence:[{statement:boundary,sourceIds:['guard']}],references:['guard']}),context));
});

test('claim objects reject invented quote fields, duplicates and excessive entries',()=>{
  invalid(value({evidence:[{statement:base.evidence[0].statement,sourceIds:['guard'],quote:'模型编造的摘录'}],references:['guard']}));
  invalid(value({evidence:[base.evidence[0],base.evidence[0]],references:['guard']}));
  invalid(value({evidence:Array(6).fill(base.evidence[0]),references:['guard']}));
  for(const item of [null,'史实',[],{sourceIds:['guard']},{statement:base.evidence[0].statement}]) invalid(value({evidence:[item],references:['guard']}));
});

test('source IDs must be current, nonempty and unique within each claim',()=>{
  for(const sourceIds of [[],['unknown'],['guard','guard'],[123],['guard','pursuit','demand','fourth'],'guard']) {
    invalid(value({evidence:[{statement:base.evidence[0].statement,sourceIds}],references:['guard']}));
  }
  assert.throws(()=>render(value({evidence:[{statement:base.evidence[0].statement,sourceIds:['unknown']}],references:['unknown']})),error=>error.code==='MODEL_ROLE_FORMAT');
});

test('references must equal the set of sources used by claim mappings',()=>{
  for(const references of [[],['guard'],['guard','pursuit','demand'],['pursuit']]) invalid(value({references}));
  assert.doesNotThrow(()=>validateClaimEvidence(value({references:['pursuit','guard']}),context));
  assert.doesNotThrow(()=>validateClaimEvidence(value({evidence:[{statement:base.reply,sourceIds:['guard','pursuit']}]}),context));
});

test('pure hypotheses, interpretations and conversation cannot borrow source authority',()=>{
  for(const answerKind of ['hypothesis','interpretation','conversation']) {
    invalid(value({answerKind}));
    invalid(value({answerKind,evidence:[],references:['guard']}));
    const input=value({answerKind,reply:'这是眼下的判断，尚不是已发生的事。',evidence:[],references:[]});
    const output=render(input);
    assert.doesNotMatch(output,/资料说明|\[资料:/);
    assert.match(output,/创作说明/);
  }
});

test('historical and mixed answers require a supported-span mapping under the new policy',()=>{
  for(const answerKind of ['historical','mixed']) invalid(value({answerKind,evidence:[],references:[]}));
  for(const answerKind of ['other',null,undefined]) invalid(value({answerKind}));
  invalid(value({evidence:undefined}));
});

test('mixed replies cite only their past span while the hypothetical continuation stays outside the mapping',()=>{
  const historic='我当时坚壁不出。';
  const reply=historic+'若再遇这样的战局，我会先稳住阵脚。这只是设想。';
  const output=render(value({reply,evidence:[{statement:historic,sourceIds:['guard']}],references:['guard']}));
  const note=output.split('资料说明：')[1];
  assert.match(output,/若再遇/);
  assert.match(note,/对应表述：我当时坚壁不出。/);
  assert.doesNotMatch(note,/对应表述：.*若再遇/);
});

test('known proposed procedures cannot become mapped historical claims',()=>{
  for(const statement of ['若再议接见，先查验地图。','如果再遇来使，先查验地图。','假如再遇来使，先查验地图。','假设加一道查验。','倘若再有变故。','要是另有来使。','我会先查验地图。','我将会先查验地图。','此乃设想，尚未施行。','这只是设想。']) {
    invalid(value({reply:statement,evidence:[{statement,sourceIds:['guard']}],references:['guard']}));
  }
});

test('leading whitespace and Qin self-address do not bypass the known-hypothesis guard',()=>{
  for(const statement of [' 若再议接见，先查验地图。','寡人会先查验地图。','朕会先查验地图。']) {
    invalid(value({reply:statement,evidence:[{statement,sourceIds:['guard']}],references:['guard']}));
  }
});

test('actual ancient military advice is allowed without broadly prohibiting the character 将',()=>{
  const reply='我当时主张非六十万人不可，秦王后来听从了将军的建议。';
  assert.doesNotThrow(()=>render(value({answerKind:'historical',reply,evidence:[{statement:reply,sourceIds:['demand']}],references:['demand']})));
});

test('old context without evidencePolicy keeps its legacy reply format while explicit new metadata is still checked',()=>{
  const legacyContext={characterStatus:context.characterStatus,sources};
  const legacy=value({});delete legacy.answerKind;delete legacy.evidence;
  assert.equal(validateClaimEvidence(legacy,legacyContext),null);
  const output=render(legacy,legacyContext);
  assert.match(output,/“王翦至，堅壁而守之，不肯戰。”\[资料:guard\]/);
  assert.doesNotMatch(output,/对应表述/);
  assert.throws(()=>render(legacy),error=>error.code==='MODEL_EVIDENCE_LINK');
  assert.throws(()=>render(value({answerKind:'hypothesis'}),legacyContext),error=>error.code==='MODEL_EVIDENCE_LINK');
});

test('older private recall and recent dialogue remove claim correspondence notes without mutating stored messages',()=>{
  const rendered=render();
  const make=(id,role,content)=>({id,role,content,status:'complete',characterId:scene.characterId,sessionId:'private-session',sceneId:scene.id,year:scene.year,momentId:scene.momentId,momentOrder:scene.momentOrder});
  const original=[make('early-u','user','请记住：我的来意是了解你当时为何等待。'),make('early-a','assistant',rendered)];
  const history=[...original,...Array.from({length:6},(_,index)=>[make('later-u-'+index,'user','谈第'+index+'处关口。'),make('later-a-'+index,'assistant','这件事尚须商议。')]).flat()];
  const before=structuredClone(history);
  const recall=selectPrivateRecall({scene,question:'还记得我的来意吗？',messages:history});
  assert.equal(recall.records.length,1);
  assert.match(recall.records[0].characterReply,/我在楚地坚壁不出/);
  assert.doesNotMatch(recall.records[0].characterReply,/资料说明|对应表述|不为心理|\[资料:|創|堅壁而守/);
  const current=buildRoleContext({scene,question:'刚才说了什么？',messages:original});
  const assistant=current.messages.find(message=>message.role==='assistant');
  assert.match(assistant.content,/我在楚地坚壁不出/);
  assert.doesNotMatch(assistant.content,/资料说明|对应表述|\[资料:/);
  assert.deepEqual(history,before);
});

const actualSources=JSON.parse(readFileSync(new URL('../content/catalog.json',import.meta.url),'utf8')).sources;
const pursuitSource=actualSources.find(source=>source.id==='unification-chu-pursuit');
const sourceLimitContext={...context,scene,sources:[...sources,pursuitSource]};
const pastPursuit=pursuitSource.auditedStatements.find(item=>item.characterIds.includes(scene.characterId)).text;
const pursuitValue=change=>value({reply:pastPursuit,answerKind:'mixed',references:[pursuitSource.id],evidence:[{statement:pastPursuit,sourceIds:[pursuitSource.id]}],...change});

test('a known unsupported enemy motive is rejected even when hidden outside the evidence span',()=>{
  const unsupported='楚军以为我怯战，于是向东撤去。';
  const input=pursuitValue({reply:pastPursuit+unsupported});
  const hint=pursuitSource.claimLimits.find(limit=>limit.phrases.includes('以为我怯战')).repairHint;
  assert.throws(()=>render(input,sourceLimitContext),error=>error.code==='MODEL_EVIDENCE_LINK' && error.retryable===true && error.repairHint===hint);
  assert.equal(input.evidence[0].statement,pastPursuit,'the overclaim is in the body, not the mapped history');
});

test('explicit uncertainty can stay in role speech but cannot borrow the pursuit excerpt as proof',()=>{
  const inference='我的推测是，楚军可能以为我怯战，但这不是已经核实的原因。';
  const input=pursuitValue({reply:pastPursuit+inference});
  const output=render(input,sourceLimitContext);
  assert.match(output,/我的推测是，楚军可能以为我怯战/);
  assert.ok(output.includes('对应表述：'+pastPursuit));
  assert.doesNotMatch(output.split('资料说明：')[1],/对应表述：.*以为我怯战/);
  const bad=pursuitValue({reply:pastPursuit+inference,evidence:[{statement:inference,sourceIds:[pursuitSource.id]}]});
  assert.throws(()=>render(bad,sourceLimitContext),error=>error.code==='MODEL_EVIDENCE_LINK' && error.repairHint===pursuitSource.claimLimits[0].repairHint);
});

test('a source-local known-overclaim limit leaves other old-history statements and ordinary judgments available',()=>{
  const oldAdvice='我当时主张非六十万人不可，秦王后来听从了将军的建议。';
  assert.doesNotThrow(()=>render(value({answerKind:'historical',reply:oldAdvice,evidence:[{statement:oldAdvice,sourceIds:['demand']}],references:['demand']}),sourceLimitContext));
  const judgment='我认为，稳住阵脚未必是怯懦，是否出战还须看眼下的兵力和士气。';
  assert.doesNotThrow(()=>render(value({answerKind:'interpretation',reply:judgment,evidence:[],references:[]}),sourceLimitContext));
  assert.doesNotThrow(()=>render(value({answerKind:'hypothesis',reply:'若换一个战局，可能有不同的取舍。这只是眼下的推测。',evidence:[],references:[]}),sourceLimitContext));
});

test('a source with audited statements accepts the current character exact wording and rejects additions or paraphrases',()=>{
  assert.doesNotThrow(()=>render(pursuitValue({}),sourceLimitContext));
  for(const statement of [
    pastPursuit+'我知道楚军已无粮。',
    '楚军移向东方后，我随即追击，大获全胜。',
    pastPursuit.replace('。','！'),
  ]) {
    const input=pursuitValue({reply:statement,evidence:[{statement,sourceIds:[pursuitSource.id]}]});
    assert.throws(()=>render(input,sourceLimitContext),error=>error.code==='MODEL_EVIDENCE_LINK' && /auditedStatements/u.test(error.repairHint||''));
  }
});

test('audited text cannot be borrowed from another character or another source support scope',()=>{
  const emperorText=pursuitSource.auditedStatements.find(item=>item.characterIds.includes('yingzheng')).text;
  const wrongRole=pursuitValue({reply:emperorText,evidence:[{statement:emperorText,sourceIds:[pursuitSource.id]}]});
  assert.throws(()=>render(wrongRole,sourceLimitContext),error=>error.code==='MODEL_EVIDENCE_LINK');
  assert.throws(()=>validateClaimEvidence(pursuitValue({}),{...sourceLimitContext,scene:{...scene,characterId:'lisi'}}),error=>error.code==='MODEL_EVIDENCE_LINK');
  const forceSource=actualSources.find(source=>source.id==='unification-chu-force-options');
  const twoSources={...sourceLimitContext,sources:[...sourceLimitContext.sources,forceSource]};
  const wrongSource=pursuitValue({references:[forceSource.id],evidence:[{statement:pastPursuit,sourceIds:[forceSource.id]}]});
  assert.throws(()=>render(wrongSource,twoSources),error=>error.code==='MODEL_EVIDENCE_LINK');
  const overAttributed=pursuitValue({references:[pursuitSource.id,forceSource.id],evidence:[{statement:pastPursuit,sourceIds:[pursuitSource.id,forceSource.id]}]});
  assert.throws(()=>render(overAttributed,twoSources),error=>error.code==='MODEL_EVIDENCE_LINK');
});

test('source audit restrictions preserve old context output and ordinary mappings for sources without that field',()=>{
  const legacyContext={characterStatus:context.characterStatus,scene,sources:[pursuitSource]};
  const legacy=pursuitValue({reply:'楚军东移，我随后发兵追击。'});
  delete legacy.answerKind;delete legacy.evidence;
  assert.equal(validateClaimEvidence(legacy,legacyContext),null);
  const oldOutput=render(legacy,legacyContext);
  assert.ok(oldOutput.includes('“'+pursuitSource.excerpt+'”[资料:'+pursuitSource.id+']'));
  assert.doesNotMatch(oldOutput,/对应表述/);
  // Only sources explicitly carrying auditedStatements require exact phrasing.
  assert.doesNotThrow(()=>render(base,sourceLimitContext));
});

const pursuitFact=auditedFacts(sourceLimitContext.sources,scene.characterId).find(fact=>fact.sourceId===pursuitSource.id);
const factValue=change=>pursuitValue({reply:`[[${pursuitFact.id}]]至于为何等待，我的判断是先稳住阵脚。`,evidence:[{factId:pursuitFact.id,sourceIds:[pursuitSource.id]}],...change});

test('audited fact tokens render canonical role-specific text without placeholders or raw JSON in visible output',()=>{
  const output=render(factValue({}),sourceLimitContext);
  assert.ok(output.includes(pastPursuit));
  assert.ok(output.includes('对应表述：'+pastPursuit));
  assert.ok(output.includes('“'+pursuitSource.excerpt+'”[资料:'+pursuitSource.id+']'));
  assert.match(output,/至于为何等待，我的判断是先稳住阵脚/);
  assert.doesNotMatch(output,/\[\[F\d+\]\]|"frame"|"evidence"|"factId"|"sourceIds"/);
  assert.deepEqual(replyCitations(output,sourceLimitContext.sources,'openai-compatible','source-quotes-v1'),[pursuitSource.id]);
  assert.throws(()=>render(factValue({action:`略一停顿，[[${pursuitFact.id}]]`}),sourceLimitContext),error=>error.code==='MODEL_ROLE_FORMAT');
  assert.doesNotMatch(render(factValue({reply:`[[${pursuitFact.id}]]。这是我的判断。`}),sourceLimitContext),/。。/u);
});

test('unknown or unavailable fact IDs cannot borrow another role facts or absent source material',()=>{
  for(const factId of ['F999','F0','f1',null,123]) {
    const input=factValue({reply:`[[${String(factId)}]]`,evidence:[{factId,sourceIds:[pursuitSource.id]}]});
    assert.throws(()=>validateClaimEvidence(input,sourceLimitContext),error=>error.code==='MODEL_EVIDENCE_LINK');
  }
  assert.throws(()=>validateClaimEvidence(factValue({}),{...sourceLimitContext,sources:[]}),error=>error.code==='MODEL_EVIDENCE_LINK');
  assert.throws(()=>validateClaimEvidence(factValue({}),{...sourceLimitContext,scene:{...scene,characterId:'lisi'}}),error=>error.code==='MODEL_EVIDENCE_LINK');
  const emperorContext={...sourceLimitContext,scene:{...scene,characterId:'yingzheng'}};
  const resolved=validateClaimEvidence(factValue({}),emperorContext);
  const emperorText=pursuitSource.auditedStatements.find(item=>item.characterIds.includes('yingzheng')).text;
  assert.equal(resolved[0].statement,emperorText,'temporary F IDs resolve only against the current role options');
  assert.notEqual(resolved[0].statement,pastPursuit,'a shared local ID does not grant the other role first-person statement');
});

test('every reply fact token needs matching evidence and its exact current source',()=>{
  const token=`[[${pursuitFact.id}]]`;
  const badInputs=[
    factValue({reply:token,answerKind:'conversation',evidence:[],references:[]}),
    factValue({reply:token+'[[F999]]'}),
    factValue({reply:'我只谈眼下的判断。'}),
    factValue({evidence:[{factId:pursuitFact.id,sourceIds:['guard']}],references:['guard']}),
    factValue({evidence:[{factId:pursuitFact.id,sourceIds:[pursuitSource.id,'guard']}],references:[pursuitSource.id,'guard']}),
    factValue({evidence:[{factId:pursuitFact.id,statement:pastPursuit,sourceIds:[pursuitSource.id]}]}),
  ];
  for(const input of badInputs) assert.throws(()=>validateClaimEvidence(input,sourceLimitContext),error=>error.code==='MODEL_EVIDENCE_LINK');
});

test('role reply limit still applies after audited facts are expanded, including the exact 600-character boundary',()=>{
  const token=`[[${pursuitFact.id}]]`;
  const repeats=token.repeat(95);
  assert.ok(Array.from(repeats).length<=600);
  assert.ok(Array.from(pastPursuit.repeat(95)).length>600);
  assert.throws(()=>render(factValue({reply:repeats}),sourceLimitContext),error=>error.code==='MODEL_ROLE_FORMAT' && /展开后/u.test(error.message));
  const padding='字'.repeat(600-Array.from(pastPursuit).length);
  const output=render(factValue({reply:token+padding}),sourceLimitContext);
  const expandedReply=output.split('\n\n')[1];
  assert.equal(Array.from(expandedReply).length,600);
  assert.equal(expandedReply,pastPursuit+padding);
});
