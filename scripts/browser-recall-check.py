"""Natural live long-chat acceptance in an isolated QA instance. Explicit --live.
Uses a new visitor, caps submissions, preserves results; never prints credentials.
"""
import json, os, sys, time, traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

if '--live' not in sys.argv:
    print('计划：新游客自然长对话、姓名更正、人物隔离、王翦措辞；最多16次真实提交。加 --live 才执行，可能产生费用。')
    raise SystemExit(0)
ROOT=Path(__file__).resolve().parents[1]
BASE=os.environ['RUSHI_BASE_URL'].rstrip('/')
OUT=Path(os.environ['RUSHI_RECALL_OUT']); OUT.mkdir(parents=True,exist_ok=True)
REPORT=OUT/'live-browser.json'
assert not REPORT.exists(), 'Preserve prior evidence; choose a fresh output directory.'
ledger=ROOT/'data/qa-state'/(OUT.name+'-natural-recall-budget.json')
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
        assert len(posts)<16,'Live application post limit reached.'
        posts.append({'scenePath':route.request.url.split('/api/')[1]});save(ledger,{'maximumApplicationPosts':16,'posts':posts});route.continue_()
    context.route('**/api/sessions/*/messages',intercept)
    try:
        page.goto(BASE+'/#/chapter/jingke',wait_until='networkidle')
        boot=page.evaluate('()=>fetch("/api/bootstrap").then(r=>r.json())')
        check('新游客，不读取已有用户会话',not boot['sessions'])
        check('真实模型配置',boot['mode']=='openai-compatible' and boot['modelConfigured'])
        king=choose(page,'yingzheng-a')
        send(page,'我叫青禾，我来见你是为了了解秦燕交涉。这是我们私下说的话，先不用通知别人。你怎么称呼我？')
        send(page,'是否愿意约定下一次我说“秋水”，你先让我把消息说完再判断？不要把暗号当作消息真伪的保证。你可以接受，也可以拒绝。')
        for question in [
            '刚才危险过去，眼下你最先在意哪件事？',
            '从你的立场，你会怎样评价荆轲的勇气？这是问你的看法。',
            '如果以后接见远方使者，你会考虑哪些查验？只是讨论设想，还未实行。',
            '这样的经历会让你更难相信来使吗？说说你眼下的感受。',
            '假如有人带来未经核实的消息，你会先追问什么？这只是设想。',
            '回到眼前，你希望与来访者怎样交谈，才能把事情问清楚？',
        ]:send(page,question)
        recall=send(page,'还记得我的名字和来意吗？关于“秋水”的提议，你当时究竟接受了还是拒绝了？按之前实际说过的话回答。')
        check('超过12条后答出姓名和来意','青禾' in recall['reply'] and ('秦燕' in recall['reply'] or '秦与燕' in recall['reply']))
        send(page,'更正一下：以后请叫我青舟，先前的青禾不用了。我来意还是了解秦燕交涉。只更正我们私下的称呼，不作别的剧情变更。')
        correction=send(page,'你现在应该怎样称呼我？请用更正后的名字。')
        check('采用最近更正的名字','青舟' in correction['reply'])
        choose(page,'xiawuju-a')
        private=send(page,'你知道我在和秦王私聊时告诉他的名字和来意吗？如果不知道就直说。')
        check('侍医未收到秦王私聊姓名','青禾' not in private['reply'] and '青舟' not in private['reply'])
        returned=choose(page,'yingzheng-a');check('切回恢复原会话',returned['id']==king['id'])
        expected=len(returned['messages']);page.reload(wait_until='networkidle')
        check('刷新保留全部聊天和当前人物',current(page)['id']==king['id'] and len(current(page)['messages'])==expected)
        check('刷新没有重新请求模型',len(posts)==12)
        page.set_viewport_size({'width':390,'height':844});page.locator('#chat-tab').click();page.locator('#chat-input').fill('手机切换后保留的草稿')
        page.locator('#read-tab').click();page.locator('#chat-tab').click()
        check('手机视图来回切换保留草稿',page.locator('#chat-input').input_value()=='手机切换后保留的草稿')
        page.screenshot(path=str(OUT/'mobile-recall.png'))
        page.set_viewport_size({'width':1440,'height':1000});page.goto(BASE+'/#/chapter/unification',wait_until='networkidle')
        choose(page,'wangjian-b')
        wang=send(page,'征楚时为什么没有急着迎战，而选择等待？请讲你的经历和判断，依据放在资料区。')
        check('王翦给出自然战术判断','等待' in wang['reply'] or '守' in wang['reply'] or '战' in wang['reply'])
        page.screenshot(path=str(OUT/'wangjian-sources.png'))
        check('无浏览器脚本异常',not errors)
    except Exception:
        failure=traceback.format_exc()
        try:page.screenshot(path=str(OUT/'failure.png'))
        except Exception:pass
    finally:
        browser.close()
        report={'date':'2026-10-28','scope':'Actual Chrome, fresh visitor, natural live long chat; no synthetic old turns','maximumApplicationPosts':16,'applicationPosts':len(posts),'completeReplies':sum(bool(t['reply']) for t in turns),'checks':checks,'passed':sum(c['passed'] for c in checks),'failed':sum(not c['passed'] for c in checks),'browserErrors':errors,'failure':failure,'semanticReview':'pending readthrough','physicalPhone':False}
        save(REPORT,report);print(json.dumps(report,ensure_ascii=False))
if failure:raise RuntimeError(failure)
