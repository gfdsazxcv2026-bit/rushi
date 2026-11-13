"""Third chapter real Chrome acceptance; explicit --live allows at most one post.
Own QA authentication checkpoint is stored outside the distributable evidence.
"""
import json,os,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
BASE=os.environ.get('RUSHI_CHAPTER3_BASE','http://127.0.0.1:4317').rstrip('/')
OUT=ROOT/Path(os.environ.get('RUSHI_CHAPTER3_OUT','docs/qa/bolangsha-2026-10-30/main-browser'))
PRIVATE=ROOT/'data/qa-state'/OUT.name
OUT.mkdir(parents=True,exist_ok=True);PRIVATE.mkdir(parents=True,exist_ok=True)
LIVE='--live' in sys.argv;RESTORE='--restore' in sys.argv
assert not(LIVE and RESTORE)
report_path=OUT/('restore.json' if RESTORE else 'browser.json')
assert not report_path.exists(),'Preserve earlier evidence.'
ledger=PRIVATE/'model-budget.json'
if LIVE:
 assert not ledger.exists(),'A live run was already started; do not repeat the paid submission.'
 ledger.write_text('{"maximumApplicationPosts":1,"started":true}',encoding='utf-8')
checks=[];posts=[];errors=[];failure=None
def check(name,value):
 checks.append({'name':name,'passed':bool(value)});assert value,name
def saved(page,sid):return page.evaluate('(id)=>fetch("/api/sessions/"+id).then(r=>r.json())',sid)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROME_PATH',r'C:\Program Files\Google\Chrome\Application\chrome.exe'),headless=True)
 context=browser.new_context(viewport={'width':1366,'height':768},locale='zh-CN',**({'storage_state':str(PRIVATE/'own-storage.json')} if RESTORE else {}))
 def budget(route):
  posts.append(route.request.url)
  if not LIVE or len(posts)>1:route.abort()
  else:route.continue_()
 context.route('**/api/sessions/*/messages',budget)
 page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 try:
  if RESTORE:
   expected=json.loads((PRIVATE/'expected.json').read_text(encoding='utf-8'))
   sid=expected['id'];page.goto(BASE+'/#/chapter/bolangsha?session='+sid,wait_until='networkidle')
   check('重启后恢复当前场景',page.locator('#scene-select').input_value()=='yingzheng-c')
   value=saved(page,sid)
   check('重启后完整回复原样存在',[m['content'] for m in value['messages']]==expected['messages'])
   check('重启后已采用状态存在',value['characterStatus']['condition']=='critical' and value['mode']=='hypothetical')
   check('重启后假设标记可见',page.locator('#plot-badge').is_visible() and '假设剧情' in page.locator('#plot-badge').inner_text())
   check('重启后未发送草稿存在',page.locator('#chat-input').input_value()==expected['draft'])
   page.screenshot(path=str(OUT/'restart.png'))
  else:
   page.goto(BASE+'/#/qin',wait_until='networkidle')
   check('目录三章开放四章待公开',page.locator('a.chapter-card').count()==3 and page.locator('article.chapter-card').count()==4)
   page.locator('[data-chapter-id="unification"]').click();page.locator('#chapter-view:not([hidden])').wait_for()
   page.locator('#next-chapter a').click();page.locator('#article-title').filter(has_text='博浪沙').wait_for()
   check('第二章下一章真实进入第三章','/chapter/bolangsha' in page.url)
   check('第三章正文七段可读',page.locator('#article-body p').count()==7)
   check('桌面读聊同时可见',page.locator('#reading-pane').is_visible() and page.locator('#chat-pane').is_visible())
   page.locator('#show-sources').click()
   page.locator('#source-bolangsha-qin-search summary').click()
   check('第三章资料有原文和定位',page.locator('.source-card').count()>=10 and '博狼沙' in page.locator('#article-sources').inner_text())
   page.locator('#switch-character').click()
   check('人物入口列出第四个人物及C场景',page.locator('.character-option').count()==4 and page.locator('[data-scene-id="yingzheng-c"]').count()==1)
   with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/api/sessions')) as response:
    page.locator('[data-scene-id="yingzheng-c"]').click()
   sid=response.value.json()['id'];page.locator('#character-picker').wait_for(state='hidden')
   check('新场景有皇帝身份和时点','秦始皇' in page.locator('#scene-description').inner_text() and page.locator('#scene-select').input_value()=='yingzheng-c')
   if LIVE:
    text='陛下，遇袭之后你眼下最挂心什么？请只谈当下感受与考虑，不把未来或尚未查明的幕后说成事实。'
    page.locator('#chat-input').fill(text);page.locator('#send-message').click()
    page.wait_for_function('()=>document.querySelectorAll(".message.assistant:not(.pending)[data-message-id]").length===1',timeout=150000)
    value=saved(page,sid);reply=value['messages'][-1]
    check('真实模型返回并保存完整回答',reply['role']=='assistant' and reply['status']=='complete' and bool(reply['content']))
    (OUT/'live-turn.json').write_text(json.dumps({'input':text,'output':reply['content'],'citations':reply.get('citations',[]),'model':'qwen3.5-omni-plus'},ensure_ascii=False,indent=2),encoding='utf-8')
   page.screenshot(path=str(OUT/'desktop.png'))
   page.locator('#plot-settings summary').click();page.locator('#condition-type').select_option('character_status');page.locator('#condition-status').select_option('critical')
   with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/conditions')) as response:page.locator('#adopt-condition').click()
   check('明确采用条件已保存',response.value.status==200)
   page.wait_for_function('()=>document.getElementById("plot-badge").classList.contains("hypothetical")')
   check('持续显示假设剧情与AI演绎说明','假设剧情' in page.locator('#plot-badge').inner_text() and 'AI 历史角色演绎' in page.locator('.chat-disclaimer').inner_text())
   page.locator('#plot-settings summary').click()
   draft='第三章刷新恢复测试，尚未发送。';page.locator('#chat-input').fill(draft)
   page.set_viewport_size({'width':390,'height':844});page.locator('#chat-tab').click();page.locator('#read-tab').click()
   page.locator('#reading-pane').evaluate('(n)=>n.scrollTop=350');page.wait_for_timeout(650)
   position=page.locator('#reading-pane').evaluate('(n)=>n.scrollTop')
   page.locator('#chat-tab').click();page.locator('#read-tab').click()
   check('手机切换保留阅读位置',abs(page.locator('#reading-pane').evaluate('(n)=>n.scrollTop')-position)<3)
   page.locator('#chat-tab').click()
   check('手机切换保留输入',page.locator('#chat-input').input_value()==draft)
   check('手机无横向溢出',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
   page.screenshot(path=str(OUT/'mobile.png'))
   page.reload(wait_until='networkidle')
   check('刷新保留人物、条件和输入',page.locator('#scene-select').input_value()=='yingzheng-c' and saved(page,sid)['characterStatus']['condition']=='critical' and page.locator('#chat-input').input_value()==draft)
   expected={'id':sid,'messages':[m['content'] for m in saved(page,sid)['messages']],'draft':draft}
   (PRIVATE/'expected.json').write_text(json.dumps(expected,ensure_ascii=False),encoding='utf-8')
   context.storage_state(path=str(PRIVATE/'own-storage.json'))
  check('本轮对话提交符合上限',len(posts)==(1 if LIVE else 0))
  check('无页面脚本错误',not errors)
 except Exception as exc:
  failure=str(exc);page.screenshot(path=str(OUT/'failure.png'))
 finally:
  browser.close()
  report={'date':'2026-10-30','scope':'Installed Chrome, owned QA context','live':LIVE,'restore':RESTORE,'applicationPosts':len(posts),'realModelCalls':len(posts) if LIVE else 0,'passed':sum(c['passed'] for c in checks),'checks':checks,'browserErrors':errors,'failure':failure}
  report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
if failure:raise SystemExit(1)
