import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateClaimEvidence} from '../server/claim-evidence.mjs';
test('unsupported enemy travel is conditional inference even when preceded by my judgment',()=>{
 const catalog=JSON.parse(readFileSync(new URL('../content/catalog.json',import.meta.url),'utf8'));
 const context={evidencePolicy:'claim-links-v1',scene:{characterId:'wangjian'},sources:[catalog.sources.find(s=>s.id==='unification-chu-pursuit')]};
 const value={answerKind:'interpretation',evidence:[],references:[],reply:'我的判断是楚军远来，求的是速战。'};
 assert.throws(()=>validateClaimEvidence(value,context),e=>e.code==='MODEL_EVIDENCE_LINK');
 assert.doesNotThrow(()=>validateClaimEvidence({...value,reply:'若楚军远来，可能会希望速战；这只是用兵推演。'},context));
});
