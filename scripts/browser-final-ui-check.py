"""Final main-site Chrome UI acceptance. Always intercepts model submissions.
Uses an ephemeral fresh QA browser context, never the user browser profile.
"""
import json,os,sys,traceback
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
BASE=os.environ.get('RUSHI_BASE_URL','http://127.0.0.1:4317').rstrip('/')
OUT=Path(os.environ.get('RUSHI_FINAL_UI_OUT',str(ROOT/'docs/qa/final-acceptance-2026-10-28/ui-main')))
OUT.mkdir(parents=True,exist_ok=True)
assert '--live' not in sys.argv, 'This checker never allows live model calls.'
LIVE=False
REPORT=OUT/('live-browser.json' if LIVE else 'ui-browser.json')
assert not REPORT.exists(),'Preserve prior results; choose a new RUSHI_FINAL_UI_OUT.'
checks=[];errors=[];turns=[];held=[];selected={}
calls=[]
def save(path,data):path.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
def check(name,ok):
 checks.append({'name':name,'passed':bool(ok)})
 assert ok,name
def current(page):
 scene_id=page.locator('#scene-select').input_value()
 assert scene_id in selected, 'The selected scene session must have been observed in its normal API response.'
 return page.evaluate('(id)=>fetch("/api/sessions/"+id).then(r=>r.json())',selected[scene_id])
def enter(page,chapter):
 page.goto(BASE+'/#/chapter/'+chapter,wait_until='networkidle');page.locator('#chapter-view:not([hidden])').wait_for()
def choose(page,scene):
 check('选择人物入口可直接点击',page.locator('#switch-character').is_enabled())
 page.locator('#switch-character').click();page.locator('#character-picker').wait_for(state='visible')
 page.locator(f'.character-option[data-scene-id="{scene}"]').click()
 page.locator('#character-picker').wait_for(state='hidden',timeout=10000)
 page.wait_for_function('(id)=>document.getElementById("scene-select").value===id',arg=scene)
 s=current(page);check('直接选卡进入目标人物',s and s['sceneId']==scene);return s
def adopt(page,status='injured'):
 page.locator('#plot-settings summary').click();page.locator('#condition-type').select_option('character_status');page.locator('#condition-status').select_option(status)
 text=page.locator('#condition-text').input_value();check('身体预设明确指向当前人物','夏无且' in text and '嬴政' not in text)
 with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/conditions')) as response:page.locator('#adopt-condition').click()
 check('当前人物身体条件成功保存',response.value.status==200);page.wait_for_function('()=>!document.getElementById("adopt-condition").disabled')
 page.locator('#plot-settings summary').click()
failure=None
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROME_PATH',r'C:\Program Files\Google\Chrome\Application\chrome.exe'),headless=True)
 try:
  context=browser.new_context(viewport={'width':1440,'height':900},locale='zh-CN');page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  def intercept(route):
   held.append(route) # Never continue any message request to the main server.
  context.route('**/api/sessions/*/messages',intercept)
  def observe(response):
   if '/api/sessions' not in response.url or not response.headers.get('content-type','').startswith('application/json'):return
   try:
    data=response.json()
    if response.ok and isinstance(data,dict) and data.get('id') and data.get('sceneId'):selected[data['sceneId']]=data['id']
   except Exception:pass
  page.on('response',observe)
  enter(page,'jingke');boot=page.evaluate('()=>fetch("/api/bootstrap").then(r=>r.json())')
  check('全新测试游客，不读取已有用户会话',not boot['sessions'])
  check('桌面阅读与聊天同时可见',page.locator('#reading-pane').is_visible() and page.locator('#chat-pane').is_visible())
  check('桌面左右分栏而非上下堆叠',page.locator('#reading-pane').bounding_box()['x']<page.locator('#chat-pane').bounding_box()['x'] and abs(page.locator('#reading-pane').bounding_box()['y']-page.locator('#chat-pane').bounding_box()['y'])<5)

  check('尚无会话也可打开人物入口',page.locator('#switch-character').is_enabled())
  page.locator('#switch-character').click();page.locator('#character-picker').wait_for(state='visible')
  check('第一章列出八个人物场景',page.locator('.character-option').count()==8)
  check('行刺前后分组清楚',page.locator('.character-picker-group[data-moment-id="jingke-before"]').count()==1 and page.locator('.character-picker-group[data-moment-id="jingke-after"]').count()==1)
  check('荆轲卡明确标行刺前及独立会话','行刺之前' in page.locator('[data-scene-id="jingke-before"]').inner_text() and '独立会话' in page.locator('[data-scene-id="jingke-before"]').inner_text())
  page.screenshot(path=str(OUT/'people-desktop.png'));page.keyboard.press('Escape');check('Escape可以关闭列表',not page.locator('#character-picker').is_visible())
  king=choose(page,'yingzheng-a');page.locator('#chat-input').fill('秦王私有的未发送输入。')
  doctor=choose(page,'xiawuju-a');check('同一时点保留分支',doctor['branchId']==king['branchId']);check('新人物不带另一人草稿',page.locator('#chat-input').input_value()=='')
  check('头像属于当前人物',page.locator('#character-avatar').inner_text()!='政')
  adopt(page);check('夏无且受伤条件属于本人',current(page)['characterStatus']['condition']=='injured')
  page.locator('#chat-input').fill('侍医自己的未发送输入。');returned=choose(page,'yingzheng-a')
  check('秦王未因医生受伤而受伤',returned['characterStatus']['condition']=='normal')
  check('来回切换恢复会话与草稿',returned['id']==king['id'] and page.locator('#chat-input').input_value()=='秦王私有的未发送输入。')
  before=choose(page,'jingke-before');check('跨时点独立开始，不带事后条件',before['branchId']!=king['branchId'] and not before['conditions'] and not before['messages'])
  check('行刺前荆轲确为存活',before['characterStatus']['alive'])
  dan=choose(page,'dan-before');check('太子丹同前时点可切换',dan['branchId']==before['branchId'])
  qin_before=choose(page,'yingzheng-before');check('秦王前场景不会恢复事后会话',qin_before['id']!=king['id'] and qin_before['branchId']==before['branchId'])
  restored=choose(page,'xiawuju-a');check('回到另一时点可恢复原会话及自己的草稿',restored['id']==doctor['id'] and page.locator('#chat-input').input_value()=='侍医自己的未发送输入。')
  page.goto(BASE+'/#/chapter/jingke?session='+king['id'],wait_until='networkidle');choose(page,'xiawuju-a');page.reload(wait_until='networkidle')
  check('显式会话URL刷新不回退到旧人物',current(page)['id']==doctor['id'] and page.locator('#character-name').inner_text()=='夏无且')
  page.set_viewport_size({'width':390,'height':844});page.locator('#chat-tab').click();page.locator('#switch-character').click();page.locator('#character-picker').wait_for(state='visible')
  check('手机人物面板无横向溢出',page.locator('#character-picker').evaluate('(n)=>n.scrollWidth<=n.clientWidth+1'))
  check('手机切聊天后阅读隐藏',page.locator('#chat-pane').is_visible() and not page.locator('#reading-pane').is_visible())

  page.screenshot(path=str(OUT/'people-mobile.png'));page.locator('#close-character-picker').click()
  draft=page.locator('#chat-input').input_value();page.locator('#read-tab').click();page.locator('#chat-tab').click()
  check('手机读聊往返保留人物与未发送输入',current(page)['id']==doctor['id'] and page.locator('#chat-input').input_value()==draft)

  enter(page,'unification');page.locator('#chat-tab').click();page.locator('#switch-character').click()
  check('第二章有六位主要人物',page.locator('.character-option').count()==6)
  page.locator('[data-scene-id="wangjian-b"]').click();page.locator('#character-picker').wait_for(state='hidden')
  check('未先开始对话也可直接选王翦',current(page)['characterId']=='wangjian')
  choose(page,'lisi-b');choose(page,'yingzheng-b')
  page.locator('#chat-input').fill('这条请求被浏览器拦截，不会调用模型。');page.locator('#send-message').click();page.wait_for_timeout(150)
  check('生成时禁止换人',page.locator('#switch-character').is_disabled())
  check('生成中发送原位禁用且停止单独可用',page.locator('#send-message').is_visible() and page.locator('#send-message').is_disabled() and page.locator('#stop-message').is_visible() and page.locator('#stop-message').is_enabled())

  assert len(held)==1
  held[0].fulfill(status=503,content_type='application/json',body=json.dumps({'error':{'message':'验收故障注入，未调用模型。'}}));page.locator('#stop-message').wait_for(state='hidden')
  check('失败后入口恢复且输入保留',page.locator('#switch-character').is_enabled() and page.locator('#chat-input').input_value()=='这条请求被浏览器拦截，不会调用模型。')
  check('无浏览器脚本异常',not errors)
 except Exception:
  failure=traceback.format_exc()
  try:page.screenshot(path=str(OUT/('live-failure.png' if LIVE else 'ui-failure.png')))
  except Exception:pass
 finally:
  browser.close()
  report={'date':'2026-10-29','scope':'Actual installed Chrome UI, new ephemeral owned QA context, model POST intercepted before server','browserRuntime':'Standalone Playwright fallback after official browser runtime bootstrap failure','interceptedMessagePosts':len(held),'serverMessagePosts':len(calls),'realModelCalls':0,'liveModelMode':LIVE,'maximumLiveApplicationPosts':8 if LIVE else 0,'applicationPosts':len(calls),'completedRealModelReplies':len([x for x in turns if x['reply']]),'checks':checks,'passed':sum(c['passed'] for c in checks),'failed':sum(not c['passed'] for c in checks),'browserErrors':errors,'failure':failure,'semanticReview':'pending readthrough' if LIVE else 'not a model quality test'}
  save(REPORT,report);print(json.dumps(report,ensure_ascii=False))
if failure:raise RuntimeError(failure)
