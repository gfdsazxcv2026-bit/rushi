import { spawn } from 'node:child_process';
import { openSync,closeSync,mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync,statSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Launcher records stay at a fixed project-local path; the child database still honors DATA_DIR.
const runtimeDir=resolve(root,'data');
const port=Number(process.env.PORT || 4317);
if(!Number.isInteger(port) || port<1 || port>65535) throw new Error('PORT must be between 1 and 65535.');
const host=process.env.HOST || '127.0.0.1';
const connectHost=['0.0.0.0','::'].includes(host)?'127.0.0.1':host;
const url=`http://${connectHost.includes(':')?`[${connectHost}]`:connectHost}:${port}`;
const pidFile=resolve(runtimeDir,'server-process.json');
const lockFile=resolve(runtimeDir,'launch.lock');
mkdirSync(runtimeDir,{recursive:true});
async function running() {
  try {
    const response=await fetch(`${url}/api/health`,{signal:AbortSignal.timeout(800)});
    if(!response.ok) return false;
    const health=await response.json();
    if(health.status!=='ok' || !['mock','openai-compatible'].includes(health.mode)) return false;
    const page=await fetch(url,{signal:AbortSignal.timeout(800)});
    return page.ok && /<title>入史[\s\S]*?<\/title>/u.test(await page.text());
  } catch { return false; }
}
const printReady=existing=>console.log(`${existing?'入史已经在运行':'入史已在后台启动'}：${url}\n关闭这个启动窗口不会停止服务。停止服务请运行 stop.cmd。`);
if(await running()) {printReady(true);process.exit(0);}
let lock;
try {lock=openSync(lockFile,'wx');writeFileSync(lock,JSON.stringify({pid:process.pid}));}
catch(error) {
  if(error.code!=='EEXIST') throw error;
  let stale=false;
  try {const previous=JSON.parse(readFileSync(lockFile,'utf8'));try {process.kill(previous.pid,0);} catch(check) {if(check.code==='ESRCH') stale=true;}} catch {try {stale=Date.now()-statSync(lockFile).mtimeMs>30000;}catch {}}
  if(stale) {unlinkSync(lockFile);lock=openSync(lockFile,'wx');writeFileSync(lock,JSON.stringify({pid:process.pid}));}
  else {
    for(let i=0;i<40;i++){if(await running()){printReady(true);process.exit(0);}await delay(250);}
    throw new Error('另一个启动任务尚未完成，请稍后再试。');
  }
}
let output,errorOutput,child;
try {
  output=openSync(resolve(runtimeDir,'server-output.log'),'a');
  errorOutput=openSync(resolve(runtimeDir,'server-error.log'),'a');
  const serverFile=resolve(root,'server/index.mjs');
  child=spawn(process.execPath,[`--env-file-if-exists=${resolve(root,'.env')}`,serverFile],{
    cwd:root,env:process.env,detached:true,windowsHide:true,stdio:['ignore',output,errorOutput]
  });
  let spawnError;
  child.once('error',error=>{spawnError=error;});
  child.unref();
  closeSync(output);output=undefined;closeSync(errorOutput);errorOutput=undefined;
  if(!child.pid) throw new Error('后台进程未能创建，请检查本机 Node 路径。');
  const record={pid:child.pid,node:process.execPath,serverFile,url,startedAt:new Date().toISOString()};
  writeFileSync(pidFile,JSON.stringify({...record,status:'starting'},null,2));
  for(let i=0;i<50;i++) {
    if(spawnError) throw spawnError;
    if(await running()) {
      if(child.exitCode!==null) throw new Error('启动进程已退出。请检查端口占用及 data/server-error.log。');
      writeFileSync(pidFile,JSON.stringify({...record,status:'ready'},null,2));
      printReady(false);process.exitCode=0;break;
    }
    if(child.exitCode!==null) throw new Error('服务启动失败。请查看 data/server-error.log；不会自动安装软件或改动系统配置。');
    if(i===49) throw new Error('服务未能及时就绪。请查看 data/server-error.log。');
    await delay(200);
  }
} catch(error) {
  if(child && child.exitCode===null) {try {child.kill();}catch {}}
  throw error;
} finally {
  if(output!==undefined)closeSync(output);
  if(errorOutput!==undefined)closeSync(errorOutput);
  if(lock!==undefined){closeSync(lock);if(existsSync(lockFile))unlinkSync(lockFile);}
}
