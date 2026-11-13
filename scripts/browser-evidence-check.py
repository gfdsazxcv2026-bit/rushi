"""Natural live long-chat acceptance in an isolated QA instance. Explicit --live.
Uses a new visitor, caps submissions, preserves results; never prints credentials.
"""
import json, os, sys, time, traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

if '--live' not in sys.argv:
    print('计划：实际Chrome验证事实对应、来源和恢复；--live最多1次真实聊天，可能产生费用。')
    raise SystemExit(0)
ROOT=Path(__file__).resolve().parents[1]
BASE=os.environ.get('RUSHI_BASE_URL','http://127.0.0.1:4317').rstrip('/')
OUT=Path(os.environ['RUSHI_EVIDENCE_OUT']); OUT.mkdir(parents=True,exist_ok=True)
REPORT=OUT/'live-browser.json'
assert not REPORT.exists(), 'Preserve prior evidence; choose a fresh output directory.'
ledger=ROOT/'data/qa-state'/(OUT.name+'-evidence-budget.json')
assert not ledger.exists(),'Budget already exists; do not replay paid turns.'
ledger.parent.mkdir(parents=True,exist_ok=True)
checks=[];turns=[];posts=[];errors=[];failure=None
def save(path,data): path.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
def check(name,ok):
    checks.append({'name':name,'passed':bool(ok)})
    assert ok,name
def current(page):
    return page.evaluate('()=>{const id=JSON.parse(localStorage.getItem("rushi:session:"+location.hash.split("/")[2].split("?")[0]));return id?fetch("/api/sessions/"+id).then(r=>r.json()):null}')
def choose(page,scene):
    page.locator('#switch-character').click();page.locator('#character-picker').wait_for(state='visible')
    page.locator(f'.character-option[data-scene-id="{scene}"]').click();page.locator('#character-picker').wait_for(state='hidden')
    page.wait_for_function('(id)=>document.getElementById("scene-select").value===id',arg=scene)
    check('人物卡进入 '+scene,current(page)['sceneId']==scene)
    return current(page)
def send(page,question):
    before=current(page); ids={m['id'] for m in before['messages']}
    page.locator('#chat-input').fill(question)
    with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/messages')) as pending:page.locator('#send-message').click()
    response=pending.value; deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        if page.locator('#chat-input').input_value()=='': break
        if page.locator('#chat-error').is_visible() and page.locator('#stop-message').is_hidden(): break
        page.wait_for_timeout(100)
    after=current(page); replies=[m for m in after['messages'] if m['id'] not in ids and m['role']=='assistant' and m['status']=='complete']
    turn={'sceneId':after['sceneId'],'question':question,'httpStatus':response.status,'reply':replies[0]['content'] if replies else None,'citations':replies[0]['citations'] if replies else [],'error':page.locator('#chat-error').inner_text() if page.locator('#chat-error').is_visible() else None}
    turns.append(turn);save(OUT/'live-turns.json',turns)
    check('第'+str(len(turns))+'轮完整回复',response.status==200 and len(replies)==1)
    return turn

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROME_PATH',r'C:\Program Files\Google\Chrome\Application\chrome.exe'),headless=True)
    context=browser.new_context(viewport={'width':1440,'height':1000});page=context.new_page()
    page.on('pageerror',lambda error:errors.append(str(error)))
    def intercept(route):
        assert len(posts)<1,'One live application post only.'
        posts.append({'scenePath':route.request.url.split('/api/')[1]});save(ledger,{'maximumApplicationPosts':1,'posts':posts});route.continue_()
    context.route('**/api/sessions/*/messages',intercept)
    try:
        page.goto(BASE+'/#/chapter/unification',wait_until='networkidle')
        boot=page.evaluate('()=>fetch("/api/bootstrap").then(r=>r.json())')
        check('New QA visitor in real model mode',not boot['sessions'] and boot['mode']=='openai-compatible' and boot['modelConfigured'])
        choose(page,'wangjian-b')
        turn=send(page,'当年征楚，对方屡次挑战，你为何一直守着不出战？请先讲亲历的经过，再讲你自己的判断，史料放资料区。')
        note=page.locator('.message-reference-note').last
        check('Source note is separate from role speech',note.count()==1 and not note.evaluate('(n)=>n.open'))
        note.locator('summary').click()
        text=note.inner_text()
        check('Actual claim-to-source correspondence visible','对应表述' in text and '堅壁' in text)
        check('Speculation is not certified by the source note','不为心理、推断或假设' in text)
        check('No raw fact tokens or JSON fields in rendered reply','[[F' not in turn['reply'] and 'factId' not in turn['reply'] and 'sourceIds' not in turn['reply'])
        page.locator('.message-citations .citation-chip').first.click()
        check('Citation opens actual source',page.locator('#reading-pane .source-card[open]').count()>0)
        page.screenshot(path=str(OUT/'evidence-desktop.png'))
        page.set_viewport_size({'width':390,'height':844});page.locator('#chat-tab').click()
        page.locator('#chat-input').fill('资料对应验收：切换和重启后保留的草稿')
        page.locator('#read-tab').click();page.locator('#chat-tab').click()
        check('Mobile switch preserves draft',page.locator('#chat-input').input_value().startswith('资料对应验收'))
        check('Mobile source notes have no horizontal overflow',page.locator('.message-reference-note').last.evaluate('(n)=>n.scrollWidth<=n.clientWidth+1'))
        page.screenshot(path=str(OUT/'evidence-mobile.png'))
        page.locator('#read-tab').click();page.set_viewport_size({'width':1440,'height':1000})
        pane=page.locator('#reading-pane');pane.evaluate('(n)=>{n.scrollTop=Math.round((n.scrollHeight-n.clientHeight)*.4)}');page.wait_for_timeout(1300)
        s=current(page);count=len(posts);page.reload(wait_until='networkidle')
        check('Refresh restores original real reply',current(page)['id']==s['id'] and current(page)['messages'][-1]['content']==turn['reply'])
        check('Refresh does not invoke model',len(posts)==count)
        private=ROOT/'data/qa-state'/(OUT.parent.name+'-'+OUT.name);private.mkdir(parents=True,exist_ok=True)
        expected={'id':s['id'],'messageCount':len(s['messages']),'lastReply':turn['reply'],'draft':page.locator('#chat-input').input_value(),'scrollTop':pane.evaluate('(n)=>n.scrollTop'),'openSections':pane.locator('details[open]').evaluate_all('(nodes)=>nodes.map(n=>n.id)')}
        save(private/'restart-expected.json',expected);context.storage_state(path=str(private/'restart-private-storage.json'))
        check('No browser script errors',not errors)
    except Exception:
        failure=traceback.format_exc()
        try:page.screenshot(path=str(OUT/'failure.png'))
        except Exception:pass
    finally:
        if turns and turns[-1]['reply']:
            try:
                checkpoint=ROOT/'data/qa-state'/(OUT.parent.name+'-'+OUT.name);checkpoint.mkdir(parents=True,exist_ok=True);context.storage_state(path=str(checkpoint/'restart-private-storage.json'))
            except Exception:pass
        browser.close();report={'date':'2026-10-28','scope':'Main-site actual Chrome, new QA identity, one real model post; desktop/mobile dimensions and refresh','maximumApplicationPosts':1,'applicationPosts':len(posts),'completeReplies':sum(bool(t['reply']) for t in turns),'checks':checks,'passed':sum(c['passed'] for c in checks),'failed':sum(not c['passed'] for c in checks),'browserErrors':errors,'failure':failure,'providerAttempts':'not instrumented','physicalPhone':False,'semanticReview':'pending readthrough'};save(REPORT,report);print(json.dumps(report,ensure_ascii=False))
if failure:raise RuntimeError(failure)
