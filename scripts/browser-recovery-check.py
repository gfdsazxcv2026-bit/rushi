"""Isolated local fake generator + actual Chrome. No .env or paid calls."""
import json, os, subprocess, time, traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('RUSHI_RECOVERY_OUT',str(ROOT/'docs/qa/final-acceptance-2026-10-28/recovery-browser')))
OUT.mkdir(parents=True, exist_ok=True)
REPORT = OUT/'report.json'
assert not REPORT.exists(), 'Preserve prior evidence; choose a new directory before another run.'
checks, posts, errors = [], [], []
session_id = None
failure = None

def check(name, value):
    checks.append({'name': name, 'passed': bool(value)})
    assert value, name

service = subprocess.Popen(['node', str(ROOT/'scripts/fake-recovery-server.mjs')], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
try:
    details = json.loads(service.stdout.readline())
    BASE = details['baseUrl']
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe'), headless=True)
        context = browser.new_context(viewport={'width':1440,'height':1000}, locale='zh-CN')
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        def request_seen(request):
            if request.method == 'POST' and request.url.endswith('/messages'):
                body = request.post_data_json
                posts.append({'text':body['text'], 'requestId':body['requestId']})
                assert len(posts) <= 8, 'hard limit of eight local fake application submissions'
        page.on('request', request_seen)
        def view():
            return page.evaluate('(id)=>fetch("/api/sessions/"+id).then(r=>r.json())', session_id)
        def idle():
            page.locator('#stop-message').wait_for(state='hidden', timeout=10000)
        def send(text):
            page.locator('#chat-input').fill(text)
            with page.expect_response(lambda r: r.request.method=='POST' and r.url.endswith('/messages')):
                page.locator('#send-message').click()
        def new_replies(state):
            return [m for m in state['messages'] if m['role']=='assistant' and m['status']=='complete']

        try:
            page.goto(BASE+'/#/chapter/jingke', wait_until='networkidle')
            page.locator('#switch-character').click()
            with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/api/sessions')) as opening:
                page.locator('.character-option[data-scene-id="yingzheng-a"]').click()
            opened = opening.value.json(); session_id = opened['id']
            page.locator('#character-picker').wait_for(state='hidden')
            check('独立QA身份会话为空', not opened['messages'] and not opened['conditions'])
            page.locator('#plot-settings summary').click()
            page.locator('#condition-type').select_option('character_status')
            page.locator('#condition-status').select_option('critical')
            with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/conditions')):
                page.locator('#adopt-condition').click()
            page.wait_for_function('()=>!document.getElementById("adopt-condition").disabled')
            page.locator('#plot-settings summary').click()
            original = view()
            check('明确采用濒死且仍存活', original['characterStatus']['condition']=='critical' and original['characterStatus']['alive'])

            text = 'UI_FAIL_ONCE：故障后保留这条输入，重试同一操作。'
            send(text); idle()
            check('故障提示清楚可见', page.locator('#chat-error').is_visible() and '失败' in page.locator('#chat-error').inner_text())
            check('失败保留输入并显示重试', page.locator('#chat-input').input_value()==text and page.locator('#retry-message').is_visible())
            failed = view()
            check('失败片段未作为完整回复保存', len(failed['messages'])==1 and failed['messages'][0]['status']=='failed' and not new_replies(failed))
            check('失败未改变身体与剧情', failed['conditions']==original['conditions'] and failed['characterStatus']==original['characterStatus'] and failed['knowledge']==original['knowledge'])
            page.screenshot(path=str(OUT/'failure-input-retained.png'))
            page.reload(wait_until='networkidle')
            check('刷新后保留失败输入及重试入口', page.locator('#chat-input').input_value()==text and page.locator('#retry-message').is_visible())
            with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/messages')):
                page.locator('#retry-message').click()
            idle(); retried = view()
            check('故障重试使用相同操作ID', posts[0]['requestId']==posts[1]['requestId'])
            check('重试仅一条输入一条答复', len(retried['messages'])==2 and len(new_replies(retried))==1 and retried['messages'][0]['id']==failed['messages'][0]['id'])
            check('成功清空输入并隐藏重试', page.locator('#chat-input').input_value()=='' and not page.locator('#retry-message').is_visible())

            text = 'UI_STOP_ONCE：主动停止本轮，再继续重试。'
            send(text)
            page.wait_for_function('()=>document.getElementById("messages").innerText.includes("模拟正在生成的片段")')
            check('生成中显示独立停止并保留禁用的发送按钮', page.locator('#stop-message').is_visible() and page.locator('#send-message').is_visible() and page.locator('#send-message').is_disabled())
            check('生成中禁止切换人物', page.locator('#switch-character').is_disabled())
            page.locator('#stop-message').click(); idle()
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                stopped = view()
                if stopped['messages'][-1]['status']=='cancelled': break
                page.wait_for_timeout(80)
            check('停止后保留输入与明确提示', page.locator('#chat-input').input_value()==text and '已停止' in page.locator('#chat-error').inner_text())
            check('停止状态已保存且无新完整答复', stopped['messages'][-1]['status']=='cancelled' and len(new_replies(stopped))==1)
            check('停止未改变濒死或剧情条件', stopped['characterStatus']==original['characterStatus'] and stopped['conditions']==original['conditions'])
            page.screenshot(path=str(OUT/'stopped-input-retained.png'))
            page.locator('#retry-message').click(); idle(); resumed=view()
            check('停止后重试复用操作ID', posts[2]['requestId']==posts[3]['requestId'])
            check('停止后重试不重复输入', len(resumed['messages'])==4 and len(new_replies(resumed))==2)

            text = 'UI_TIMEOUT_ONCE：超时恢复仍保留输入。'
            send(text); idle()
            check('真实应用超时提示与输入保留', '超时' in page.locator('#chat-error').inner_text() and page.locator('#chat-input').input_value()==text)
            timed = view()
            check('超时未保存错误答复', len(timed['messages'])==5 and timed['messages'][-1]['status']=='cancelled' and len(new_replies(timed))==2)
            page.locator('#retry-message').click(); idle(); recovered=view()
            check('超时重试复用操作ID且不重复保存', posts[4]['requestId']==posts[5]['requestId'] and len(recovered['messages'])==6 and len(new_replies(recovered))==3)

            text = 'UI_DUP_ONCE：快速重复点击不得重复提交。'
            page.locator('#chat-input').fill(text)
            page.locator('#send-message').dblclick(force=True)
            idle(); duplicate = view()
            check('快速重复点击只提交一次', len(posts)==7 and len([m for m in duplicate['messages'] if m['role']=='user' and m['content']==text])==1)
            check('重复点击后仅一条完整答复', len(duplicate['messages'])==8 and len(new_replies(duplicate))==4)
            check('所有恢复后身体状态与采用条件保持', duplicate['characterStatus']==original['characterStatus'] and duplicate['conditions']==original['conditions'])
            page.set_viewport_size({'width':390,'height':844}); page.locator('#chat-tab').click()
            page.screenshot(path=str(OUT/'recovery-mobile.png'))
            check('手机视图显示恢复答复且无横向溢出', page.locator('#messages').is_visible() and page.locator('#chat-pane').evaluate('(n)=>n.scrollWidth<=n.clientWidth+1'))
            check('浏览器无页面脚本异常', not errors)
        except Exception:
            failure=traceback.format_exc()
            try: page.screenshot(path=str(OUT/'failure.png'))
            except Exception: pass
        finally:
            browser.close()
    metrics = json.loads(Path(details['metricsPath']).read_text(encoding='utf-8'))
    report = {'date':'2026-10-29','scope':'Actual Chrome with isolated application, SQLite and deterministic fake generator; not real-model semantic or natural-provider-failure acceptance', 'browserRuntime':'Official Chrome plugin bootstrap failed: privileged native pipe bridge unavailable / browser-client not trusted; standalone Playwright controlling installed actual Chrome fallback', 'realProviderCalls':0,'applicationPosts':len(posts),'fakeGeneratorAttempts':metrics['fakeGeneratorAttempts'],'checks':checks,'passed':sum(c['passed'] for c in checks),'failed':sum(not c['passed'] for c in checks),'browserErrors':errors,'failure':failure}
    REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
finally:
    service.terminate()
    try: service.wait(timeout=5)
    except subprocess.TimeoutExpired: service.kill(); service.wait()
if failure: raise RuntimeError(failure)
