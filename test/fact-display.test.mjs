import test from 'node:test';
import assert from 'node:assert/strict';
import {renderRoleReply} from '../server/role-output.mjs';
test('only adjacent duplicate reviewed fact sentences are collapsed after slot expansion',()=>{
 const scene={identity:'秦将',year:-221,characterId:'wangjian'};
 const source={id:'rest',excerpt:'王翦日休士洗沐。',auditedStatements:[{characterIds:['wangjian'],text:'我让士卒休整洗沐。'}]};
 const context={scene,characterStatus:{condition:'normal'},sources:[source],evidencePolicy:'claim-links-v1'};
 const value={frame:{identity:'秦将',year:-221,condition:'normal'},action:'',reply:'[[F1]]我让士卒休整洗沐。我愿再谈。我愿再谈。',references:['rest'],answerKind:'mixed',evidence:[{factId:'F1',sourceIds:['rest']}],sourceGap:false};
 const output=renderRoleReply(JSON.stringify(value),{scene,context}).split('\n\n资料说明：')[0];
 assert.equal(output,'我让士卒休整洗沐。我愿再谈。我愿再谈。');
});

test('full fact sentences cannot be inserted as the object of an unfinished clause',()=>{
 const scene={identity:'秦将',year:-221,characterId:'wangjian'};
 const source={id:'rest',excerpt:'王翦日休士洗沐。',auditedStatements:[{characterIds:['wangjian'],text:'我让士卒休整洗沐。'}]};
 const context={scene,characterStatus:{condition:'normal'},sources:[source],evidencePolicy:'claim-links-v1'};
 const value={frame:{identity:'秦将',year:-221,condition:'normal'},action:'',references:['rest'],answerKind:'mixed',evidence:[{factId:'F1',sourceIds:['rest']}],sourceGap:false};
 for(const reply of ['我定下[[F1]]的方略。','让军队休整[[F1]]','[[F1]]的安排。'])assert.throws(()=>renderRoleReply(JSON.stringify({...value,reply}),{scene,context}),e=>e.code==='MODEL_EVIDENCE_LINK' && /完整事实句/u.test(e.repairHint));
 for(const reply of ['当时，[[F1]]之后再议出兵。','[[F1]][[F1]]'])assert.doesNotThrow(()=>renderRoleReply(JSON.stringify({...value,reply}),{scene,context}));
});
