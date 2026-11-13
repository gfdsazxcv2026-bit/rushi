import json
import os
from uuid import uuid4
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('RUSHI_FAULT_OUT',str(root/'docs/qa/manual-logic-fault')))
out.mkdir(parents=True,exist_ok=True)
assert not (out/'fault-browser.json').exists(),'Preserve earlier evidence; choose a fresh RUSHI_FAULT_OUT.'
base=json.loads((root/'data/qa-state/logic-browser-runtime.json').read_text())['url']
checks=[]
def check(name,condition):
 checks.append({'name':name,'passed':bool(condition)})
 assert condition,name
def saved(page):
 return page.evaluate('()=>{const id=JSON.parse(localStorage.getItem("rushi:session:jingke"));return fetch("/api/sessions/"+id).then(r=>r.json())}')
def send(page,text):
 page.locator('#chat-input').fill(text)
 page.locator('#send-message').click()
def done(page):
 page.wait_for_function('()=>document.getElementById("chat-input").value===""')
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROME_PATH',r'C:\Program Files\Google\Chrome\Application\chrome.exe'),headless=True)
 errors=[]
 try:
  ctx=browser.new_context(viewport={'width':1440,'height':900},locale='zh-CN');page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(base+'/#/chapter/jingke',wait_until='networkidle')
  run_id=str(uuid4())[:8]
  stop_question='CASE_REPAIR_STOP 荆轲行刺经过？ '+run_id
  send(page,'CASE_REPAIR 荆轲行刺有何依据？ '+run_id);done(page)
  s=saved(page);text=page.locator('#messages').inner_text()
  check('引用修订后只保存一问一答',len(s['messages'])==2)
  check('错误草稿与错误资料不残留在页面和保存结果','错误草稿' not in text+json.dumps(s,ensure_ascii=False) and 'INVALID_FIXTURE_REFERENCE' not in text)
  send(page,stop_question)
  page.wait_for_function('()=>document.getElementById("mock-banner").textContent.includes("正在核对资料")')
  page.locator('#stop-message').click();page.locator('#stop-message').wait_for(state='hidden')
  check('修订中可停止并保留输入',page.locator('#chat-input').input_value()==stop_question)
  page.reload(wait_until='networkidle')
  check('刷新不提交被停止的草稿',len([m for m in saved(page)['messages'] if m['status']=='complete'])==2)
  check('刷新后可以重试同一输入',page.locator('#chat-input').input_value()==stop_question)
  page.locator('#retry-message').click();done(page)
  s=saved(page)
  check('停止后重试没有重复保存用户消息',len(s['messages'])==4)
  send(page,'宫门外所有侍卫分别叫什么？');done(page)
  check('明确显示本次资料核对未调用模型','本次未调用模型' in page.locator('#mock-banner').inner_text())
  check('资料不足没有编造姓名','【资料核对】' in page.locator('.message.assistant').last.inner_text())
  page.screenshot(path=str(out/'fault-browser-desktop.png'))
  page.reload(wait_until='networkidle')
  check('资料核对标记刷新后仍在','【资料核对】' in page.locator('.message.assistant').last.inner_text())
  stats=page.evaluate('()=>fetch("/__fixture__/stats").then(r=>r.json())')
  check('完整名单查询没有经过生成器','宫门外所有侍卫分别叫什么？' not in stats['calls'])
  page.set_viewport_size({'width':390,'height':844});page.locator('#read-tab').click();page.locator('#chat-tab').click()
  check('手机切换保留回答',len(saved(page)['messages'])==6 and '【资料核对】' in page.locator('.message.assistant').last.inner_text())
  page.screenshot(path=str(out/'fault-browser-mobile.png'))
  check('无浏览器脚本异常',not errors)
 finally:
  browser.close()
  report={'scope':'Actual Chrome UI; isolated injected generator, zero external model calls','checks':checks,'passed':sum(c['passed'] for c in checks),'failed':sum(not c['passed'] for c in checks),'errors':errors}
  (out/'fault-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
  print(json.dumps(report,ensure_ascii=False))
