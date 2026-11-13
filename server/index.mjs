import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { Store } from './store.mjs';
import { AppError, fail, initialState, assertScene, adoptCondition, recordUserClaim, getCharacterStatus } from './world.mjs';
import { getModelConfig, getModelStatus, generateReply } from './model.mjs';
import { buildRoleContext } from './rag.mjs';
import { replyCitations } from './references.mjs';
import { momentOf } from './scene-time.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const scenePublic = scene => Object.fromEntries(['id','chapterId','characterId','characterName','identity','title','timeLabel','year','chronologyPrecision','yearIsNavigationAnchor','status','greeting','momentId','momentOrder','momentLabel','avatar','selfAddress'].map(key => [key,scene[key]]));
const meta = chapter => Object.fromEntries(['id','order','title','subtitle','eraLabel','timeLabel','status','summary','nextId'].map(key => [key,chapter[key]]));
const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const allowedEvents = new Set(['chapter_open','chat_start','continue','restart','next_chapter','return_visit','feedback','coming_soon_interest']);
export function createApp(options = {}) {
  const env = options.env || process.env;
  const catalog = options.catalog || JSON.parse(readFileSync(resolve(root,'content/catalog.json'),'utf8'));
  const store = new Store(options.dataDir || resolve(root, env.DATA_DIR || 'data'), catalog);
  const config = options.modelConfig || getModelConfig(env);
  const modelConfigured = getModelStatus(config).readyForLive;
  const generator = options.generate || generateReply;
  const locks = new Map(), rates = new Map();
  const limits = { inputChars: positive(env.MAX_INPUT_CHARS,2000), requestsPerMinute: positive(env.VISITOR_REQUESTS_PER_MINUTE,12), daily: positive(env.DAILY_MODEL_REQUESTS,100), globalDaily: positive(env.GLOBAL_DAILY_MODEL_REQUESTS,1000) };
  const sign = value => createHmac('sha256',store.secret).update(value).digest('hex');
  const csrf = id => sign(`csrf:${id}`);
  const chapterFor = id => { const c = catalog.chapters.find(c => c.id===id && c.status==='published' && c.reviewStatus==='checked'); if (!c) fail(404,'NOT_PUBLISHED','本章尚未公开。'); return c; };
  const sceneFor = id => { const s = catalog.scenes.find(s=>s.id===id && s.status==='published'); if(!s) fail(404,'CHAT_CLOSED','这个人物场景暂未开放。'); chapterFor(s.chapterId); return s; };
  const sourcesFor = chapterId => catalog.sources.filter(s=>s.published===true && s.chapterIds?.includes(chapterId));
  const idle = branchId => { if(locks.has(branchId)) fail(409,'BRANCH_BUSY','这一条剧情正在生成回复。请等待或停止生成后再操作。'); };
  function visitor(req,res) {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').filter(s=>s.includes('=')).map(s=>{const p=s.trim().indexOf('=');return [s.trim().slice(0,p),s.trim().slice(p+1)];}));
    const [candidate,signature] = (cookies.rushi_visitor || '').split('.');
    if(candidate && equal(sign(candidate),signature) && store.hasVisitor(candidate)) return candidate;
    const id=randomUUID(); store.addVisitor(id);
    const secure = req.socket.encrypted ? '; Secure' : '';
    res.setHeader('Set-Cookie',`rushi_visitor=${id}.${sign(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`);
    return id;
  }
  async function body(req) {
    const chunks=[]; let length=0; for await(const chunk of req) {length+=chunk.length;if(length>20000) fail(413,'INPUT_TOO_LONG','请求内容过长。');chunks.push(chunk);}
    const raw=Buffer.concat(chunks).toString('utf8');
    try { const parsed=raw?JSON.parse(raw):{};if(parsed===null || typeof parsed!=='object' || Array.isArray(parsed)) fail(400,'INVALID_JSON','请求必须是 JSON 对象。');return parsed; } catch(error) { if(error instanceof AppError) throw error;fail(400,'INVALID_JSON','请求格式错误。'); }
  }
  function rate(visitorId) {
    const timestamp=Date.now(); const recent=(rates.get(visitorId)||[]).filter(t=>timestamp-t<60000);
    if(recent.length>=limits.requestsPerMinute) fail(429,'RATE_LIMIT','发送过快，请稍后重试，输入已保留。');
    recent.push(timestamp); rates.set(visitorId,recent);
    if(rates.size>10000) for(const [key,times] of rates) if(!times.some(t=>timestamp-t<60000)) rates.delete(key);
  }
  function emit(res,event,value) { if(!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); }
  function sse(res) { res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'}); res.flushHeaders(); }
  async function chat(req,res,visitorId,sessionId,input) {
    const session=store.session(sessionId,visitorId), branch=store.branch(session.branch_id,visitorId), scene=sceneFor(session.scene_id);
    const question=String(input.text || '').trim(), requestId=String(input.requestId || '');
    if(!question || question.length>limits.inputChars) fail(400,'INVALID_INPUT',`请输入 1～${limits.inputChars} 字。`);
    if(!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) fail(400,'INVALID_REQUEST_ID','缺少有效操作标识，请重试。');
    const prior=store.db.prepare('SELECT * FROM operations WHERE session_id=? AND id=?').get(session.id,requestId);
    if(prior && prior.text!==question) fail(409,'IDEMPOTENCY_CONFLICT','同一个操作标识不能用于不同的问题。');
    if(prior?.status==='complete') {
      const message=store.messages(session.id).find(m=>m.id===prior.message_id);
      sse(res); emit(res,'meta',{mode:config.mode,requestId,replayed:true,responseKind:message.content.startsWith('【资料核对】')?'evidence-gap':'character'}); emit(res,'delta',{text:message.content}); emit(res,'done',{message,session:store.view(session,catalog)}); res.end(); return;
    }
    idle(branch.id); assertScene(scene,branch.state); rate(visitorId); store.usage(visitorId,limits.daily,limits.globalDaily);
    const controller=new AbortController(); locks.set(branch.id,controller);
    const userId=prior?.message_id || randomUUID();
    try { store.transaction(()=>{
      if(!prior) {
        store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(userId,session.id,'user',question,'pending','[]',new Date().toISOString());
        store.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(session.id,requestId,question,'pending',userId);
      } else {
        store.db.prepare("UPDATE operations SET status='pending' WHERE session_id=? AND id=?").run(session.id,requestId);
        store.db.prepare("UPDATE messages SET status='pending' WHERE id=?").run(userId);
      }
    }); } catch(error) { locks.delete(branch.id); throw error; }
    const abort=()=>{if(!res.writableEnded) controller.abort(new Error('USER_CANCELLED'));};
    res.on('close',abort);
    const timeout=setTimeout(()=>controller.abort(new Error('GENERATION_TIMEOUT')),config.timeoutMs || 45000);
    try {
      const memories=store.memories(branch.id,visitorId)[scene.characterId] || [];
      const context=buildRoleContext({scene,question,sources:catalog.sources.filter(s=>s.published===true && s.chapterIds?.some(id=>catalog.chapters.some(c=>c.id===id && c.status==='published' && c.reviewStatus==='checked'))),conditions:branch.state.conditions.filter(c=>c.visibleTo?.includes(scene.characterId)),events:branch.state.events.filter(e=>e.visibleTo?.includes(scene.characterId)),knowledge:branch.state.knowledge.filter(k=>k.characterId===scene.characterId),messages:memories,mode:branch.state.mode,characterStatus:getCharacterStatus(branch.state,scene)});
      const evidenceOnly=config.mode==='openai-compatible' && context.evidenceGap;
      sse(res); emit(res,'meta',{mode:config.mode,requestId,responseKind:evidenceOnly?'evidence-gap':'character'});
      const generateCurrent=evidenceOnly ? async function*(){yield context.evidenceGap.text;} : generator;
      let content='',citations,attemptContext=context;
      // Transport retries and a citation repair share one configured budget.
      // Never save the failed draft, create another user message, or loop.
      const retryBudget={remaining:config.maxRetries ?? 1};
      while(true) {
        for await(const token of generateCurrent({scene,context:attemptContext,question,signal:controller.signal,config,retryBudget})) {
          if(controller.signal.aborted) throw controller.signal.reason;
          if(typeof token!=='string') continue;
          content+=token;
          if(content.length>20000) throw new AppError(502,'OUTPUT_TOO_LONG','回答超出长度限制，请换一个更具体的问题。');
          emit(res,'delta',{text:token});
        }
        if(controller.signal.aborted || res.destroyed) throw controller.signal.reason || new Error('USER_CANCELLED');
        if(!content.trim()) throw new AppError(502,'EMPTY_RESPONSE','模型未返回有效内容，请重试。');
        try {citations=replyCitations(content,context.sources,config.mode,context.citationPolicy);break;}
        catch(error) {
          if(config.mode!=='openai-compatible' || !['MODEL_INVALID_CITATION','MODEL_CITATION_UNSUPPORTED'].includes(error.code) || retryBudget.remaining<=0) throw error;
          retryBudget.remaining--;
          content='';
          emit(res,'reset',{reason:'reference-check'});
          emit(res,'meta',{mode:config.mode,requestId,phase:'reference-check'});
          attemptContext={...context,system:context.system+'\n\n同一问题的引用修订：上一份草稿引用未通过校核。请重新回答原问题。资料不足就直说现有资料未找到依据，不必引用；如有引用，只在资料说明中逐字复制本轮给出的连续原文，并紧跟对应真实id。人物正文保持自然，心理与创作不加资料标记。'};
        }
      }
      const messageId=randomUUID();
      store.transaction(()=>{
        const current=store.branch(branch.id,visitorId);
        if(current.version!==branch.version) fail(409,'STATE_CONFLICT','剧情状态已变化，请刷新后重试。');
        const next=recordUserClaim(current.state,scene,question,userId);
        const firstTurn=!store.messages(session.id,true).some(m=>m.role==='assistant');
        store.db.prepare("UPDATE messages SET status='complete' WHERE id=?").run(userId);
        store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(messageId,session.id,'assistant',content,'complete',JSON.stringify(citations),new Date().toISOString());
        store.db.prepare("UPDATE operations SET status='complete',message_id=? WHERE session_id=? AND id=?").run(messageId,session.id,requestId);
        store.updateState(branch.id,visitorId,next); store.snapshot(session);
        store.event(visitorId,firstTurn?'chat_start':'chat_turn',session.chapter_id,session.id,null);
      });
      emit(res,'done',{message:store.messages(session.id).find(m=>m.id===messageId),session:store.view(session,catalog)});
      res.end();
    } catch(error) {
      const cancelled=controller.signal.aborted;
      store.transaction(()=>{
        store.db.prepare('UPDATE operations SET status=? WHERE session_id=? AND id=?').run(cancelled?'cancelled':'failed',session.id,requestId);
        store.db.prepare('UPDATE messages SET status=? WHERE id=? AND role=\'user\'').run(cancelled?'cancelled':'failed',userId);
      });
      const timeoutHit=controller.signal.reason?.message==='GENERATION_TIMEOUT';
      const safeModelError=typeof error.code==='string' && error.code.startsWith('MODEL_');
      const detail={code:timeoutHit?'MODEL_TIMEOUT':cancelled?'CANCELLED':safeModelError || error instanceof AppError?error.code:'MODEL_FAILURE',message:timeoutHit?'生成超时，输入已保留，可以重试。':cancelled?'已停止生成，剧情状态未改变，输入已保留。':error instanceof AppError || safeModelError?error.message:'模型调用失败，输入已保留。请检查服务器配置或稍后重试。',retryable:cancelled?true:typeof error.retryable==='boolean'?error.retryable:true};
      if(!res.headersSent) json(res,error.status || 502,{error:detail});
      else {emit(res,'error',detail);res.end();}
    } finally { clearTimeout(timeout); res.off('close',abort); locks.delete(branch.id); }
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const url=new URL(req.url,'http://localhost'), path=url.pathname;
      if(path.startsWith('/api/')) {
        res.setHeader('Cache-Control','no-store');
        if(req.method==='GET' && path==='/api/health') return json(res,200,{status:'ok',mode:config.mode,modelConfigured});
        const visitorId=visitor(req,res);
        if(req.method==='POST') {
          if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}` && req.headers.origin!==`https://${req.headers.host}`) fail(403,'ORIGIN_DENIED','不接受来自其他站点的操作。');
          if(!equal(String(req.headers['x-csrf-token'] || ''),csrf(visitorId))) fail(403,'CSRF_DENIED','页面身份已更新，请刷新页面后重试。');
        }
        if(req.method==='GET' && path==='/api/bootstrap') return json(res,200,{mode:config.mode,modelConfigured,csrfToken:csrf(visitorId),periods:catalog.periods,chapters:catalog.chapters.map(meta),scenes:catalog.scenes.filter(s=>s.status==='published' && catalog.chapters.some(c=>c.id===s.chapterId && c.status==='published' && c.reviewStatus==='checked')).map(scenePublic),sessions:store.sessions(visitorId,catalog),progress:store.getProgress(visitorId),limits:{inputChars:limits.inputChars,requestsPerMinute:limits.requestsPerMinute}});
        let match;
        if(req.method==='GET' && (match=path.match(/^\/api\/chapters\/([^/]+)$/))) {const chapter=chapterFor(match[1]);return json(res,200,{chapter,scenes:catalog.scenes.filter(s=>s.chapterId===chapter.id && s.status==='published').map(scenePublic),sources:sourcesFor(chapter.id)});}
        if(req.method==='GET' && path==='/api/sources') {chapterFor(url.searchParams.get('chapterId'));return json(res,200,{sources:sourcesFor(url.searchParams.get('chapterId'))});}
        if(req.method==='GET' && (match=path.match(/^\/api\/sources\/([^/]+)$/))) {const source=catalog.sources.find(s=>s.id===match[1] && s.published===true && s.chapterIds?.some(id=>catalog.chapters.some(c=>c.id===id && c.status==='published' && c.reviewStatus==='checked')));if(!source) fail(404,'NOT_FOUND','资料尚未公开或不存在。');return json(res,200,{source});}
        if(req.method==='GET' && (match=path.match(/^\/api\/sessions\/([^/]+)$/))) return json(res,200,store.view(store.session(match[1],visitorId),catalog));
        if(req.method==='POST') {
          const input=await body(req);
          if(path==='/api/sessions') {
            chapterFor(input.chapterId); const scene=sceneFor(input.sceneId);
            if(scene.chapterId!==input.chapterId) fail(400,'SCENE_MISMATCH','人物场景与章节不匹配。');
            let source, snapshot;
            if(input.sourceSessionId) {
              source=store.session(input.sourceSessionId,visitorId); idle(source.branch_id);
              const snapshotId=input.sourceSnapshotId || store.transaction(()=>store.snapshot(source)); snapshot=store.getSnapshot(snapshotId,source);
            } else if(input.sourceSnapshotId) fail(400,'MISSING_SOURCE','请指定来源会话。');
            const sourceScene=source && catalog.scenes.find(item=>item.id===source.scene_id);
            const inherited=snapshot ? {...snapshot.state,momentId:snapshot.state.momentId || momentOf(sourceScene),momentOrder:snapshot.state.momentOrder ?? sourceScene?.momentOrder} : undefined;
            const state=initialState(scene,inherited);
            const created=store.transaction(()=>store.createSession(visitorId,scene,state,{memories:snapshot?.memories,sourceSessionId:source?.id,sourceSnapshotId:snapshot?.id}));
            store.event(visitorId,source?'continue':'restart',scene.chapterId,created.id,null);
            return json(res,201,store.view(created,catalog));
          }
          if((match=path.match(/^\/api\/sessions\/([^/]+)\/switch$/))) {
            const session=store.session(match[1],visitorId), branch=store.branch(session.branch_id,visitorId), scene=sceneFor(input.sceneId);
            idle(branch.id);
            const sourceScene=catalog.scenes.find(item=>item.id===session.scene_id);
            if(scene.chapterId!==session.chapter_id || scene.year!==branch.state.year || momentOf(scene)!==momentOf(sourceScene)) fail(409,'TIME_CONFLICT','这位人物处于不同历史时点。请通过人物入口独立开始或恢复该时点的会话；当前剧情和消息不会带过去。');
            assertScene(scene,branch.state);
            const found=store.db.prepare('SELECT * FROM sessions WHERE branch_id=? AND visitor_id=? AND scene_id=?').get(branch.id,visitorId,scene.id);
            const created=found || store.transaction(()=>store.createSession(visitorId,scene,branch.state,{branchId:branch.id}));
            return json(res,200,store.view(created,catalog));
          }
          if((match=path.match(/^\/api\/sessions\/([^/]+)\/conditions$/))) {
            const session=store.session(match[1],visitorId), branch=store.branch(session.branch_id,visitorId), scene=sceneFor(session.scene_id);
            idle(branch.id); const operationId=String(input.operationId || '');
            if(!/^[a-zA-Z0-9_-]{8,100}$/.test(operationId)) fail(400,'INVALID_REQUEST_ID','缺少有效设定操作标识。');
            const payload=JSON.stringify({text:input.text,type:input.type,characterId:input.characterId,...(input.status!==undefined?{status:input.status}:{}),knownToCurrent:input.knownToCurrent===true});
            const prior=store.db.prepare('SELECT payload FROM conditions_ops WHERE branch_id=? AND id=?').get(branch.id,operationId);
            if(prior && prior.payload!==payload) fail(409,'IDEMPOTENCY_CONFLICT','同一操作标识不能用于不同设定。');
            if(!prior) store.transaction(()=>{
              const next=adoptCondition(branch.state,scene,input); store.updateState(branch.id,visitorId,next);
              store.db.prepare('INSERT INTO conditions_ops VALUES(?,?,?)').run(branch.id,operationId,payload); store.snapshot(session);
            });
            return json(res,200,store.view(session,catalog));
          }
          if((match=path.match(/^\/api\/sessions\/([^/]+)\/messages$/))) return await chat(req,res,visitorId,match[1],input);
          if(path==='/api/progress') {
            chapterFor(input.chapterId); const ratio=Number(input.ratio);
            if(!Number.isFinite(ratio) || ratio<0 || ratio>1 || !['read','chat'].includes(input.view) || String(input.draft || '').length>limits.inputChars) fail(400,'INVALID_PROGRESS','阅读位置或输入长度不正确。');
            const reading={};
            for(const key of ['scrollTop','scrollExtent']) {
              if(input[key]!==undefined) {
                if(!Number.isFinite(input[key]) || input[key]<0 || input[key]>10000000) fail(400,'INVALID_PROGRESS','阅读位置不正确。');
                reading[key]=input[key];
              }
            }
            if(input.openSections!==undefined) {
              if(!Array.isArray(input.openSections) || input.openSections.length>60 || input.openSections.some(id=>typeof id!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) fail(400,'INVALID_PROGRESS','展开资料记录不正确。');
              reading.openSections=[...new Set(input.openSections)];
            }
            store.progress(visitorId,input.chapterId,{ratio,view:input.view,draft:String(input.draft || ''),...reading,updatedAt:new Date().toISOString()}); return json(res,200,{ok:true});
          }
          if(path==='/api/events') {
            if(!allowedEvents.has(input.type)) fail(400,'INVALID_EVENT','不支持的行为类型。');
            if(input.sessionId) store.session(input.sessionId,visitorId);
            if(input.chapterId && !catalog.chapters.some(c=>c.id===input.chapterId)) fail(400,'INVALID_CHAPTER','章节不存在。');
            store.event(visitorId,input.type,input.chapterId,input.sessionId,input.value); return json(res,200,{ok:true});
          }
        }
        fail(404,'NOT_FOUND','接口不存在。');
      }
      if(req.method!=='GET' && req.method!=='HEAD') fail(405,'METHOD_NOT_ALLOWED','此操作不受支持。');
      let assetPath;
      try {assetPath=decodeURIComponent(path);} catch {fail(400,'INVALID_PATH','路径错误。');}
      const publicDir=resolve(root,'public'), file=resolve(publicDir,assetPath==='/'?'index.html':`.${assetPath}`);
      if(!file.startsWith(publicDir+sep) || !['.html','.css','.js','.svg','.ico','.webp','.png'].includes(extname(file)) || !existsSync(file)) fail(404,'NOT_FOUND','页面不存在。');
      const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.ico':'image/x-icon'};
      res.writeHead(200,{'Content-Type':types[extname(file)],'Cache-Control':'no-cache'}); res.end(req.method==='HEAD'?undefined:readFileSync(file));
    } catch(error) {
      if(!res.headersSent) json(res,error instanceof AppError?error.status:500,{error:{code:error.code || 'INTERNAL_ERROR',message:error instanceof AppError?error.message:'服务暂时不可用，请稍后重试。',retryable:!(error instanceof AppError) || error.status>=500, ...(error.details?{details:error.details}:{})}});
      else res.end();
      if(!(error instanceof AppError)) console.error('Request failed:',error.code || error.name);
    }
  });
  return {server,store,catalog,config,close:async()=>{for(const controller of locks.values()) controller.abort(new Error('SERVER_SHUTDOWN'));await new Promise(resolveClose=>server.close(resolveClose));store.close();}};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const app=createApp(); const port=positive(process.env.PORT,4317), host=process.env.HOST || '127.0.0.1';
  app.server.listen(port,host,()=>console.log(`入史本地验收页 http://${host}:${port} · 模式 ${app.config.mode} · 数据持久化已启用`));
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
