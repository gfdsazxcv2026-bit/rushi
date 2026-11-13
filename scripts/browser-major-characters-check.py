"""Operate every selectable role in the published chapters using an owned QA context.
--live: one model submission at most. --restore: only saved QA state, no new chat.
"""
import json,os,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];BASE=os.environ.get('RUSHI_MAJOR_BASE','http://127.0.0.1:4317')
OUT=ROOT/os.environ.get('RUSHI_MAJOR_OUT','docs/qa/major-characters-2026-10-30/main-browser');OUT.mkdir(parents=True,exist_ok=True)
PRIVATE=ROOT/'data/qa-state'/OUT.name;PRIVATE.mkdir(parents=True,exist_ok=True)
LIVE='--live' in sys.argv;RESTORE='--restore' in sys.argv;assert not(LIVE and RESTORE)
report_path=OUT/('restore.json' if RESTORE else 'browser.json');assert not report_path.exists()
ledger=PRIVATE/'budget.json'
if LIVE:assert not ledger.exists();ledger.write_text('{"started":true,"maxApplicationPosts":1}',encoding='utf-8')
checks=[];errors=[];posts=[];failure=None;selected={}
def check(label,value):checks.append({'name':label,'passed':bool(value)});assert value,label
def session(page,sid):return page.evaluate('(id)=>fetch("/api/sessions/"+id).then(r=>r.json())',sid)
def choose(page,sid):
 page.locator('#switch-character').click();page.locator('#character-picker').wait_for(state='visible')
 page.locator(f'[data-scene-id="{sid}"]').click();page.locator('#character-picker').wait_for(state='hidden')
 page.wait_for_function('(s)=>document.getElementById("scene-select").value===s',arg=sid)
 page.wait_for_function('(s)=>document.getElementById("session-origin").textContent.includes("当前会话")',arg=sid)
 short=page.locator('#session-origin').inner_text().split('当前会话 ')[1][:8]
 boot=page.evaluate('()=>fetch("/api/bootstrap").then(r=>r.json())')
 current=next(s for s in boot['sessions'] if s['id'].startswith(short))
 selected[sid]=current['id'];return session(page,current['id'])
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True)
 c=b.new_context(viewport={'width':1440,'height':1000},locale='zh-CN',**({'storage_state':str(PRIVATE/'own-storage.json')} if RESTORE else {}))
 def limit(route):
  posts.append(route.request.url)
  if LIVE and len(posts)==1:route.continue_()
  else:route.abort()
 c.route('**/api/sessions/*/messages',limit)
 page=c.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 try:
  if RESTORE:
   expected=json.loads((PRIVATE/'expected.json').read_text(encoding='utf-8'))
   for sid,saved_id in expected['sessions'].items():
    chapter=expected['chapterByScene'][sid];page.goto(BASE+'/#/chapter/'+chapter+'?session='+saved_id,wait_until='networkidle')
    page.wait_for_function('([sid,id])=>document.getElementById("scene-select").value===sid && document.getElementById("session-origin").textContent.includes(id.slice(0,8))',arg=[sid,saved_id])
    check('重启恢复人物 '+sid,page.locator('#scene-select').input_value()==sid and session(page,saved_id)['id']==saved_id)
   page.goto(BASE+'/#/chapter/bolangsha?session='+expected['zhangId'],wait_until='networkidle')
   page.wait_for_function('(id)=>document.getElementById("scene-select").value==="zhangliang-escape" && document.getElementById("session-origin").textContent.includes(id.slice(0,8))',arg=expected['zhangId'])
   value=session(page,expected['zhangId'])
   check('重启保留张良完整真实回复',[m['content'] for m in value['messages']]==expected['zhangMessages'])
   check('重启保留张良身体与假设',value['characterStatus']['condition']=='critical' and value['mode']=='hypothetical')
   check('重启保留张良草稿',page.locator('#chat-input').input_value()==expected['draft'])
   page.screenshot(path=str(OUT/'restart.png'))
  else:
   catalog=json.loads((ROOT/'content/catalog.json').read_text(encoding='utf-8'))
   all_scenes=[s for s in catalog['scenes'] if s['status']=='published'];chapter_by_scene={s['id']:s['chapterId'] for s in all_scenes}
   for chapter,npeople,nscenes in [('jingke',7,8),('unification',6,6),('bolangsha',4,4)]:
    page.goto(BASE+'/#/chapter/'+chapter,wait_until='networkidle');page.locator('#chapter-view:not([hidden])').wait_for()
    page.locator('#switch-character').click()
    check(chapter+'主要人物数量正确',len(set(page.locator('.character-option').evaluate_all('(ns)=>ns.map(n=>n.dataset.characterId)')))==npeople)
    check(chapter+'场景数量正确',page.locator('.character-option').count()==nscenes)
    if chapter=='jingke':check('樊於期明确停在自尽前','尚未自尽' in page.locator('[data-scene-id="fanyuqi-private"]').inner_text())
    if chapter=='bolangsha':check('沧海君明确年月不详','不详' in page.locator('[data-scene-id="canghaijun-plan"]').inner_text())
    page.screenshot(path=str(OUT/f'{chapter}-picker-desktop.png'));page.keyboard.press('Escape')
    for s in [s for s in all_scenes if s['chapterId']==chapter]:
     current=choose(page,s['id'])
     check('点击可进入 '+s['id'],current['sceneId']==s['id'] and page.locator('#character-name').inner_text()==s['characterName'])
     check('自身身体预设正确 '+s['id'],s['characterName'] in page.locator('#condition-type option[value="character_status"]').text_content())
    page.set_viewport_size({'width':390,'height':844});page.locator('#chat-tab').click();page.locator('#switch-character').click()
    check(chapter+'手机人物面板无横向溢出',page.locator('#character-picker').evaluate('(n)=>n.scrollWidth<=n.clientWidth+1'))
    for s in [s for s in all_scenes if s['chapterId']==chapter]:
     card=page.locator('[data-scene-id="'+s['id']+'"]');card.scroll_into_view_if_needed()
     check('手机卡片可滚到 '+s['id'],card.is_visible())
    page.screenshot(path=str(OUT/f'{chapter}-picker-mobile.png'));page.keyboard.press('Escape');page.set_viewport_size({'width':1440,'height':1000})
   zhang=choose(page,'zhangliang-escape');zhang_id=zhang['id']
   if LIVE:
    question='你此时为何改换名姓？接下来最担心什么？只站在藏身下邳的当下谈，不预知之后的命运。'
    page.locator('#chat-input').fill(question);page.locator('#send-message').click()
    page.wait_for_function('()=>document.querySelectorAll(".message.assistant:not(.pending)[data-message-id]").length===1',timeout=150000)
    zhang=session(page,zhang_id);reply=zhang['messages'][-1]
    check('张良真实模型完整回答并保存',reply['role']=='assistant' and reply['status']=='complete')
    (OUT/'live-turn.json').write_text(json.dumps({'question':question,'output':reply['content'],'citations':reply.get('citations',[])},ensure_ascii=False,indent=2),encoding='utf-8')
   page.locator('#messages').evaluate('(n)=>n.scrollTop=0');page.screenshot(path=str(OUT/'zhang-desktop.png'))
   page.locator('#plot-settings summary').click();page.locator('#condition-type').select_option('character_status');page.locator('#condition-status').select_option('critical')
   with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/conditions')) as response:page.locator('#adopt-condition').click()
   check('张良濒死设定保存',response.value.status==200)
   page.locator('#plot-settings summary').click();draft='张良的未发送草稿。';page.locator('#chat-input').fill(draft)
   king=choose(page,'yingzheng-c');check('秦始皇不共享张良伤势和草稿',king['characterStatus']['condition']=='normal' and page.locator('#chat-input').input_value()=='')
   returned=choose(page,'zhangliang-escape');check('切回恢复张良原记录条件与输入',returned['id']==zhang_id and returned['characterStatus']['condition']=='critical' and page.locator('#chat-input').input_value()==draft)
   check('跨地点时点切换使用独立分支',king['branchId']!=returned['branchId'])
   page.set_viewport_size({'width':390,'height':844});page.locator('#chat-tab').click();page.locator('#read-tab').click();page.locator('#chat-tab').click()
   check('手机读聊切换保留输入',page.locator('#chat-input').input_value()==draft)
   page.reload(wait_until='networkidle');check('刷新保留人物状态与输入',page.locator('#scene-select').input_value()=='zhangliang-escape' and page.locator('#chat-input').input_value()==draft)
   check('假设标记持续存在','假设剧情' in page.locator('#plot-badge').inner_text())
   page.screenshot(path=str(OUT/'zhang-mobile.png'))
   expected={'sessions':selected,'chapterByScene':chapter_by_scene,'zhangId':zhang_id,'zhangMessages':[m['content'] for m in session(page,zhang_id)['messages']],'draft':draft}
   (PRIVATE/'expected.json').write_text(json.dumps(expected,ensure_ascii=False),encoding='utf-8');c.storage_state(path=str(PRIVATE/'own-storage.json'))
  check('对话提交未超过授权上限',len(posts)==(1 if LIVE else 0));check('无浏览器脚本异常',not errors)
 except Exception as exc:
  failure=str(exc);page.screenshot(path=str(OUT/'failure.png'))
 finally:
  b.close();report={'date':'2026-10-30','scope':'Actual installed Chrome, owned isolated QA context','live':LIVE,'restore':RESTORE,'passed':sum(x['passed'] for x in checks),'checks':checks,'failure':failure,'browserErrors':errors,'applicationPosts':len(posts),'realModelCalls':len(posts) if LIVE else 0}
  report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k!='checks'},ensure_ascii=False))
if failure:raise SystemExit(1)
