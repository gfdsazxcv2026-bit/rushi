import test from 'node:test';
import assert from 'node:assert/strict';
import {renderRoleReply} from '../server/role-output.mjs';
test('changed questions cannot receive the same old reply while an explicit repeat request is allowed',()=>{
 const scene={identity:'秦王',year:-227};
 const context={characterStatus:{condition:'critical'},sources:[],messages:[{role:'assistant',content:'声音微弱。\n\n寡人还活着，你近些。\n\n创作说明：角色演绎。'}],question:'那你此刻最想留下什么话？'};
 const raw=JSON.stringify({frame:{identity:'秦王',year:-227,condition:'critical'},action:'声音微弱。',reply:'寡人还活着，你近些。',references:[]});
 assert.throws(()=>renderRoleReply(raw,{scene,context}),e=>e.code==='MODEL_ROLE_REPEAT' && e.retryable);
 assert.doesNotThrow(()=>renderRoleReply(raw,{scene,context:{...context,question:'请重复刚才那段原话。'}}));
});
