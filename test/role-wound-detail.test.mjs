import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRoleConsistency} from '../server/role-consistency.mjs';
const context={scene:{characterId:'yingzheng',required:{}},characterStatus:{condition:'critical',alive:true},conditions:[{text:'本段设定嬴政濒死，尚未死亡。'}],events:[],knowledge:[],sources:[],messages:[]};
test('a scalar critical condition does not establish an invented wound location in action or speech',()=>{
 for(const value of [{action:'朕胸口剧痛，气息微弱。',reply:'近前些。'},{action:'气息微弱。',reply:'朕腹部流血，难以开口。'}])assert.throws(()=>validateRoleConsistency(value,context),e=>e.code==='MODEL_ROLE_STATE');
});
test('cinematic breathing remains allowed and an explicitly adopted wound location can be used',()=>{
 assert.doesNotThrow(()=>validateRoleConsistency({action:'气息微弱，停顿片刻。',reply:'近前些……朕还有话要交代。'},context));
 assert.doesNotThrow(()=>validateRoleConsistency({action:'朕胸口剧痛，气息微弱。',reply:'近前些。'},{...context,conditions:[{text:'已采用嬴政胸口受伤，濒死但尚存活。'}]}));
});

test('critical alone does not grant bleeding symptoms but explicitly adopted bleeding remains possible',()=>{
 for(const value of [{action:'喉间涌上腥甜，强撑睁眼。',reply:'别靠太近，血止不住。'},{action:'我吐血不止。',reply:'听我说。'}])assert.throws(()=>validateRoleConsistency(value,context),e=>e.code==='MODEL_ROLE_STATE');
 assert.doesNotThrow(()=>validateRoleConsistency({action:'声音微弱。',reply:'血止不住，先听我说。'},{...context,conditions:[{text:'本段明确采用人物正在出血，处于濒死状态。'}]}));
});
