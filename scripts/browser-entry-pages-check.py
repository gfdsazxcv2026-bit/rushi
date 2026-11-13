"""Entry-page and shared chapter UI checks, fresh Chrome; model posts blocked."""
import json
import os
from datetime import datetime
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT=Path(os.environ.get('RUSHI_ENTRY_OUT','docs/qa/frontend-unification-2026-10-30/entry'))
OUT.mkdir(parents=True,exist_ok=True)
assert not (OUT/'report.json').exists(), 'Choose a new output directory to retain earlier results.'
checks=[]; errors=[]; blocked=[]; failure=None
def check(name,ok):
 checks.append({'name':name,'passed':bool(ok)})
 assert ok,name
def stable(a,b):return abs(a['y']-b['y'])<1 and abs(a['height']-b['height'])<1
def document_box(loc):return loc.evaluate('(n)=>{const r=n.getBoundingClientRect();return {y:r.y+scrollY,height:r.height}}')
def no_overflow(page):return page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
def shown(loc):return loc.evaluate('(n)=>getComputedStyle(n).visibility==="visible" && +getComputedStyle(n).opacity>.99')

with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROME_PATH',r'C:\Program Files\Google\Chrome\Application\chrome.exe'),headless=True)
 context=browser.new_context(viewport={'width':1440,'height':900},locale='zh-CN')
 def block(route):
  blocked.append(route.request.url);route.abort()
 context.route('**/api/sessions/*/messages',block)
 page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 try:
  page.goto('http://127.0.0.1:4317/#/',wait_until='networkidle')
  page.locator('.period').first.wait_for()
  check('默认隐藏所有时期的简介与入口',all(not shown(x) for x in page.locator('.period-detail').all()))
  qin=page.locator('[data-period-id="qin"]'); nxt=page.locator('.period').nth(1)
  page.screenshot(path=str(OUT/'home-desktop.png'))
  before=document_box(nxt); qin.hover();page.wait_for_timeout(300)
  check('整节点悬停展开',shown(qin.locator('.period-detail')))
  check('标题适度放大',qin.locator('h3').evaluate('(n)=>getComputedStyle(n).transform')!='none')
  check('展开不移动相邻节点',stable(before,document_box(nxt)))
  qin.locator('.period-enter').hover();page.wait_for_timeout(300)
  check('移动到详情链接仍展开',shown(qin.locator('.period-detail')))
  page.screenshot(path=str(OUT/'timeline-desktop.png'))
  page.mouse.move(0,0);page.locator('#home-view h1').click();page.wait_for_timeout(300)
  check('离开节点收起',not shown(qin.locator('.period-detail')))
  qin.locator('.period-heading').focus();page.wait_for_timeout(300)
  check('键盘聚焦展开且ARIA同步',shown(qin.locator('.period-detail')) and qin.locator('.period-heading').get_attribute('aria-expanded')=='true')
  page.keyboard.press('Tab')
  check('键盘可以进入精选章节',page.evaluate('document.activeElement.classList.contains("period-chapter")'))
  page.keyboard.press('Enter');page.locator('#chapter-view:not([hidden])').wait_for()
  check('精选章节进入第一章','jingke' in page.url)
  page.locator('.chapter-topbar .back-link').click();page.locator('#directory-view:not([hidden])').wait_for()
  check('目录三章开放四章待公开',page.locator('a.chapter-card.live').count()==3 and page.locator('article.chapter-card:not(.live)').count()==4)
  check('第一章明确前传归属','战国前传' in page.locator('[data-chapter-id="jingke"]').inner_text())
  check('未公开卡片没有阅读链接',page.locator('article.chapter-card a').count()==0)
  page.screenshot(path=str(OUT/'directory-desktop.png'))
  page.locator('[data-chapter-id="unification"]').click();page.locator('#chapter-view:not([hidden])').wait_for()
  check('第二章使用相同双栏',page.locator('#reading-pane').is_visible() and page.locator('#chat-pane').is_visible() and page.locator('#reading-pane').bounding_box()['x']<page.locator('#chat-pane').bounding_box()['x'])
  check('第二章使用确认的圆角卡片',page.locator('#reading-pane').evaluate('(n)=>getComputedStyle(n).borderRadius')=='16px')
  page.locator('#switch-character').click();page.locator('#character-picker').wait_for(state='visible')
  check('第二章三个人物入口保留',page.locator('.character-option').count()==3)
  page.keyboard.press('Escape');page.locator('#show-sources').click()
  check('第二章资料可以打开',page.locator('#sources-section').is_visible() and page.locator('.source-card').count()>0)
  page.screenshot(path=str(OUT/'chapter2-desktop.png'))
  page.goto('http://127.0.0.1:4317/#/',wait_until='networkidle')
  pending=page.locator('[data-period-id="han"]');pending.hover();page.wait_for_timeout(300)
  check('待公开展开后状态明确','待公开' in pending.inner_text() and pending.locator('a').count()==0)
  with page.expect_response(lambda r:'/api/events' in r.url and r.request.method=='POST') as event:
   pending.locator('button.period-enter').click()
  payload=event.value.request.post_data_json
  check('待公开点击仅记录兴趣',payload.get('type')=='coming_soon_interest' and event.value.ok and page.url.endswith('#/'))
  check('并立时期按共同节点组织',page.locator('[data-period-id="weijin"]').count()==1 and page.locator('[data-period-id="song-liao-xia-jin"]').count()==1)

  for w,h in [(1440,900),(1366,768),(1024,768),(768,600),(390,844),(360,640)]:
   page.set_viewport_size({'width':w,'height':h})
   page.goto('http://127.0.0.1:4317/#/',wait_until='networkidle');page.mouse.move(0,0)
   check(f'{w}首页无横向溢出',no_overflow(page))
   periods=page.locator('.period')
   for i in range(periods.count()):
    item=periods.nth(i);item.locator('.period-heading').click();page.wait_for_timeout(250)
    check(f'{w}时期{i+1}可展开',shown(item.locator('.period-detail')))
    check(f'{w}时期{i+1}详情未越过本节点',item.locator('.period-detail').bounding_box()['y']+item.locator('.period-detail').bounding_box()['height']<=item.bounding_box()['y']+item.bounding_box()['height']+1)
    check(f'{w}时期{i+1}展开无横向溢出',no_overflow(page))
    item.locator('.period-heading').click()
   if w<=760:
    qin=page.locator('[data-period-id="qin"]');next_before=document_box(periods.nth(1))
    qin.locator('.period-heading').click();page.wait_for_timeout(300)
    check(f'{w}轻点展开而不跳页',shown(qin.locator('.period-detail')) and page.url.endswith('#/'))
    check(f'{w}轻点不移动相邻节点',stable(next_before,document_box(periods.nth(1))))
    page.screenshot(path=str(OUT/f'home-{w}.png'))
    qin.locator('.period-enter').click()
   else:page.goto('http://127.0.0.1:4317/#/qin',wait_until='networkidle')
   page.locator('#directory-view:not([hidden])').wait_for()
   check(f'{w}目录无横向溢出',no_overflow(page))
   if w<=760:page.screenshot(path=str(OUT/f'directory-{w}.png'))
   page.locator('[data-chapter-id="unification"]').click();page.locator('#chapter-view:not([hidden])').wait_for()
   check(f'{w}第二章无横向溢出',no_overflow(page))
   if w<=760:
    page.locator('#chat-tab').click();page.locator('#chat-input').fill('统一之后，眼下最要紧的是什么？')
    page.locator('#read-tab').click();page.locator('#chat-tab').click()
    check(f'{w}第二章读聊切换保留输入',page.locator('#chat-input').input_value()=='统一之后，眼下最要紧的是什么？')
    page.screenshot(path=str(OUT/f'chapter2-chat-{w}.png'))
  check('没有浏览器脚本错误',not errors)
  check('本轮未提交对话或调用模型',not blocked)
 except Exception as exc:
  failure=str(exc);page.screenshot(path=str(OUT/'failure.png'))
 finally:
  browser.close()
  report={'auditDate':datetime.now().astimezone().isoformat(),'browser':'Installed Chrome, new isolated context','checks':checks,'passed':sum(x['passed'] for x in checks),'total':len(checks),'browserErrors':errors,'blockedMessageRequests':len(blocked),'realModelCalls':0,'failure':failure}
  (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k!='checks'},ensure_ascii=False))
if failure:raise SystemExit(1)
