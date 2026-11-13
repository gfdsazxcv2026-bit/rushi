// Deliberate fault injection; never connects to an external model.
import {createApp,root} from '../server/index.mjs';
import {mkdtempSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const qaDir=resolve(root,'data','qa-state');mkdirSync(qaDir,{recursive:true});
const dataDir=mkdtempSync(resolve(qaDir,'logic-browser-'));
const calls={};
const app=createApp({dataDir,env:{VISITOR_REQUESTS_PER_MINUTE:'100'},modelConfig:{mode:'openai-compatible',baseUrl:'http://127.0.0.1:1/v1',model:'fixture-only',apiKey:'FAKE_LOCAL_ONLY',timeoutMs:10000,maxRetries:1},generate:async function*({question,signal}){
  calls[question]=(calls[question]||0)+1;
  if(question.includes('CASE_REPAIR') && calls[question]===1){yield '不应留下的错误草稿[资料:INVALID_FIXTURE_REFERENCE]';return;}
  if(question.includes('CASE_REPAIR_STOP') && calls[question]===2){await delay(5000,undefined,{signal});}
  else await delay(300,undefined,{signal});
  yield '声音很轻。\n\n寡人先听你把眼前的事说清。\n\n创作说明：本条为隔离故障注入样例。';
}});
const original=app.server.listeners('request')[0];app.server.removeAllListeners('request');
app.server.on('request',(req,res)=>{
  if(req.url==='/__fixture__/stats'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({calls,realProviderCalls:0}));return;}
  original(req,res);
});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const runtime={url:`http://127.0.0.1:${app.server.address().port}`,pid:process.pid};
writeFileSync(resolve(qaDir,'logic-browser-runtime.json'),JSON.stringify(runtime));
console.log(JSON.stringify(runtime));
