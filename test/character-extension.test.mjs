import test from 'node:test';
import assert from 'node:assert/strict';
import { characterIds, characterEntries, characterMeta, aliases } from '../server/characters.mjs';
import { momentOf, isFromFuture } from '../server/scene-time.mjs';
import { initialState, getCharacterStatus, assertScene, adoptCondition, extractPhysicalFacts, recordUserClaim } from '../server/world.mjs';

const before={id:'jingke-before-test',chapterId:'jingke',characterId:'jingke',year:-227,momentId:'jingke-before',momentOrder:10,worldFacts:{jingke_alive:true,unified:false}};
const after={id:'yingzheng-after-test',chapterId:'jingke',characterId:'yingzheng',year:-227,momentId:'jingke-after',momentOrder:20,worldFacts:{jingke_alive:false,unified:false}};
const doctor={...after,id:'doctor-after-test',characterId:'xiawuju'};
const unified={id:'unified-test',chapterId:'unification',characterId:'yingzheng',year:-221,momentId:'unification',momentOrder:10,worldFacts:{jingke_alive:false,unified:true},required:{unified:true}};
const body=(characterId,status,text)=>({type:'character_status',characterId,status,text});

test('registered main characters share one identity and alias configuration',()=>{
  for(const id of ['yingzheng','lisi','jingke','dan','xiawuju','wangjian']){
    assert.ok(characterIds.includes(id),id);assert.equal(aliases.get(characterMeta(id).name),id);
  }
  assert.equal(characterEntries.length,new Set(characterEntries.map(entry=>entry.id)).size);
  assert.equal(characterMeta('not-registered'),undefined);
});

test('new named actors and their aliases get separate physical conditions',()=>{
  assert.deepEqual(extractPhysicalFacts('夏无且重伤濒死；荆轲已经受伤；太子丹已经死亡；王翦已经康复'),[
    {characterId:'xiawuju',status:'critical'},{characterId:'jingke',status:'injured'},{characterId:'dan',status:'dead'},{characterId:'wangjian',status:'normal'},
  ]);
  const state=adoptCondition(initialState(doctor),doctor,body('xiawuju','critical','夏无且重伤，原因AUTHOR_PRIVATE不能公开。'));
  assert.equal(getCharacterStatus(state,doctor).condition,'critical');assert.equal(getCharacterStatus(state,'yingzheng').condition,'normal');
  const status=getCharacterStatus(state,doctor);
  assert.deepEqual(Object.keys(status).sort(),['alive','condition','sourceConditionIds']);
  assert.doesNotMatch(JSON.stringify(status),/AUTHOR_PRIVATE/);
});

test('scene history distinguishes living Jing Ke before the attack from dead Jing Ke afterwards',()=>{
  const living=initialState(before);
  assert.equal(getCharacterStatus(living,before).alive,true);
  const injured=adoptCondition(living,before,body('jingke','injured','荆轲已经受伤。'));
  assert.equal(getCharacterStatus(injured,before).condition,'injured');
  const later=initialState(after);
  assert.equal(getCharacterStatus(later,'jingke').alive,false);
  assert.throws(()=>assertScene({...after,characterId:'jingke'},later),error=>error.code==='SCENE_CONFLICT');
  assert.throws(()=>adoptCondition(later,after,body('jingke','normal','荆轲恢复伤势。')),error=>error.code==='SCENE_CONFLICT');
});

test('explicitly adopted physical death is not healed away for newly registered people',()=>{
  const state=initialState(doctor);
  const dead=adoptCondition(state,doctor,{type:'character_dead',characterId:'xiawuju',text:'夏无且已经死亡。'});
  assert.equal(getCharacterStatus(dead,doctor).alive,false);
  assert.throws(()=>adoptCondition(dead,doctor,body('xiawuju','normal','夏无且已经康复。')),error=>error.code==='SCENE_CONFLICT');
  assert.throws(()=>assertScene(doctor,dead),error=>error.code==='SCENE_CONFLICT');
  assert.equal(getCharacterStatus(state,doctor).alive,true,'the source state is unchanged');
});

test('unknown structured character IDs are rejected instead of entering world overrides',()=>{
  const state=initialState(doctor),original=JSON.stringify(state);
  for(const input of [body('unknown','critical','他濒死。'),{type:'character_dead',characterId:'unknown',text:'他已死。'},{type:'custom',characterId:'unknown',text:'当前出现新人物。'}])assert.throws(()=>adoptCondition(state,doctor,input),error=>error.code==='INVALID_CHARACTER');
  assert.equal(JSON.stringify(state),original);
});

test('same-year event phases do not inherit backwards or forwards as if simultaneous',()=>{
  const earlier=initialState(before),later=initialState(after);
  for(const [target,source] of [[after,earlier],[before,later]]){
    const original=JSON.stringify(source);
    assert.throws(()=>initialState(target,source),error=>error.code==='TIME_CONFLICT');
    assert.equal(JSON.stringify(source),original);
  }
  assert.equal(initialState(doctor,later).momentId,'jingke-after');
  assert.equal(initialState(unified,later).year,-221,'ordinary later-year continuation remains available');
});

test('all registered characters participate in unresolved critical-state time-gap checks',()=>{
  const critical=adoptCondition(initialState(doctor),doctor,body('xiawuju','critical','夏无且处于濒死状态。'));
  assert.throws(()=>initialState(unified,critical),error=>error.code==='SCENE_CONFLICT' && error.details.some(detail=>detail.key==='xiawuju_critical_time_gap' && /夏无且/u.test(detail.message)));
  const healed=adoptCondition(critical,doctor,body('xiawuju','normal','夏无且已经恢复。'));
  assert.equal(initialState(unified,healed).world.xiawuju_alive,true);
});

test('legacy own-body records still work without rewriting their original shape',()=>{
  const old={year:-227,mode:'hypothetical',overrides:{},world:{yingzheng_alive:true,unified:false},conditions:[{id:'legacy',type:'custom',text:'秦王处于濒死状态',year:-227,visibleTo:[]}],events:[],knowledge:[]};
  const copy=JSON.stringify(old);
  assert.equal(getCharacterStatus(old,'yingzheng').condition,'critical');
  assert.equal(initialState(after,old).momentId,'jingke-after');
  assert.equal(JSON.stringify(old),copy);
});

test('new records are tagged by event phase without changing ordinary question classification',()=>{
  const state=initialState(doctor),next=adoptCondition(state,doctor,{text:'当面收到一则消息。',knownToCurrent:true});
  for(const record of [...next.conditions,...next.events,...next.knowledge]){assert.equal(record.momentId,doctor.momentId);assert.equal(record.momentOrder,20);}
  const spoken=recordUserClaim(state,doctor,'我告诉你，现在已经收到通知。','message-1');
  assert.equal(spoken.knowledge[0].momentId,doctor.momentId);
  assert.equal(recordUserClaim(state,doctor,'你是否收到消息？','message-2').knowledge.length,0);
});

test('future filtering compares years first and only then phases within a year',()=>{
  assert.equal(momentOf({chapterId:'jingke',year:-227}),'jingke:-227');
  assert.equal(momentOf(before),'jingke-before');
  assert.equal(isFromFuture({year:-227,momentOrder:20},before),true);
  assert.equal(isFromFuture({year:-227,momentOrder:10},after),false);
  assert.equal(isFromFuture({year:-221,momentOrder:1},after),true);
  assert.equal(isFromFuture({year:-230,momentOrder:100},after),false);
  assert.equal(isFromFuture({year:-227},before),false,'legacy records require server source-moment normalization, not guessed order');
});
