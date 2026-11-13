"""One explicitly enabled live Chrome turn, then a zero-call restart restore.

Default only prints a plan. --live uses a new QA context; --restore reads only
that context's own private checkpoint. Never prints cookies, CSRF or API keys.
"""
import json, os, sys, time, traceback
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('RUSHI_BASE_URL', 'http://127.0.0.1:4317').rstrip('/')
OUT = Path(os.environ.get('RUSHI_FINAL_LIVE_OUT', str(ROOT/'docs/qa/final-acceptance-2026-10-28/live-main')))
LIVE = '--live' in sys.argv
RESTORE = '--restore' in sys.argv
INSPECT = '--inspect' in sys.argv
assert sum([LIVE, RESTORE, INSPECT]) <= 1, 'Choose one mode.'
assert all(arg in ['--live', '--restore', '--inspect', '--plan'] for arg in sys.argv[1:]), 'Unknown argument.'
assert not ('--plan' in sys.argv and (LIVE or RESTORE or INSPECT)), 'Plan cannot be combined with an execution mode.'
if not LIVE and not RESTORE and not INSPECT:
    print('计划：--live 新匿名 Chrome 最多1次聊天；--inspect 查看同一已保存回复继续UI检查、--restore 实际重启后恢复，后二者0次模型调用。')
    raise SystemExit(0)

MAX_POSTS = 1 if LIVE else 0
PRIVATE = ROOT/'data/qa-state'/OUT.name
PRIVATE.mkdir(parents=True, exist_ok=True)
LEDGER = PRIVATE/'one-live-post-budget.json'
STATE = PRIVATE/'qa-private-storage.json'
EXPECTED = PRIVATE/'restart-expected.json'
OUT.mkdir(parents=True, exist_ok=True)
REPORT = OUT/('live-browser.json' if LIVE else 'inspect-browser.json' if INSPECT else 'restore-browser.json')
assert not REPORT.exists(), 'Preserve previous report; choose a fresh output directory.'
if LIVE:
    ledger = {'maximumApplicationPosts': 1, 'submitted': 0, 'purpose': 'Fresh QA doctor D07 actual Chrome'}
    with LEDGER.open('x', encoding='utf-8') as handle:
        json.dump(ledger, handle)
else:
    assert STATE.exists() and EXPECTED.exists(), 'This QA checkpoint does not exist.'
    ledger = json.loads(LEDGER.read_text(encoding='utf-8'))
    assert ledger['maximumApplicationPosts'] == 1 and ledger['submitted'] <= 1

checks, errors, selected = [], [], {}
posts, blocked, complete = 0, 0, 0
failure = None
checkpoint_saved = False
service_mode = None
stream_modes = []
stream_observation = 'not observed in this mode'
semantic_concerns = []
QUESTION = '方才你在殿上怎样帮秦王解围？药囊里具体装了哪些药，现有记载能说清吗？'
DRAFT = '最终验收：稍后继续了解殿上经过。'

def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')

def check(name, value):
    checks.append({'name': name, 'passed': bool(value)})
    assert value, name

def current(page):
    scene = page.locator('#scene-select').input_value()
    # Loading a source snapshot also returns a session of the same scene.
    # Identify the active session by its visible label, not the last API reply.
    label = page.locator('#session-origin').inner_text()
    sessions = page.evaluate('()=>fetch("/api/bootstrap").then(r=>r.json()).then(v=>v.sessions)')
    active = [s for s in sessions if s.get('sceneId') == scene and ('当前会话 '+s['id'][:8]) in label]
    if len(active) == 1:
        return page.evaluate('(id)=>fetch("/api/sessions/"+id).then(r=>r.json())', active[0]['id'])
    assert scene in selected, 'The selected scene must be observed through its normal session API response.'
    return page.evaluate('(id)=>fetch("/api/sessions/"+id).then(r=>r.json())', selected[scene])

def observe(response):
    if '/api/sessions' not in response.url or not response.headers.get('content-type', '').startswith('application/json'):
        return
    try:
        value = response.json()
        if response.ok and isinstance(value, dict) and value.get('id') and value.get('sceneId'):
            selected[value['sceneId']] = value['id']
    except Exception:
        pass

def checkpoint(page, context):
    state = current(page)
    pane = page.locator('#reading-pane')
    expected = {
        'sessionId': state['id'], 'sceneId': state['sceneId'], 'characterId': state['characterId'],
        'messages': state['messages'], 'conditions': state['conditions'],
        'draft': page.locator('#chat-input').input_value(),
        'scrollTop': pane.evaluate('(n)=>n.scrollTop'),
        'openSections': pane.locator('details[open]').evaluate_all('(nodes)=>nodes.map(n=>n.id)'),
    }
    save(EXPECTED, expected)
    context.storage_state(path=str(STATE)) # Only this newly created QA identity.

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe'), headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, locale='zh-CN', **({'storage_state': str(STATE)} if RESTORE or INSPECT else {}))
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('response', observe)

    def intercept(route):
        global posts, blocked
        if not LIVE or posts >= MAX_POSTS or ledger['submitted'] >= 1:
            blocked += 1
            route.abort()
            return
        posts += 1
        ledger['submitted'] = posts
        ledger['submittedAt'] = datetime.now(timezone.utc).isoformat()
        save(LEDGER, ledger) # Commit budget before forwarding the request.
        route.continue_()

    context.route('**/api/sessions/*/messages', intercept)
    try:
        page.goto(BASE+'/#/chapter/jingke', wait_until='networkidle')
        boot = page.evaluate('()=>fetch("/api/bootstrap").then(r=>r.json())')
        service_mode = boot.get('mode')
        check('主站明确真实模型模式且已配置', service_mode == 'openai-compatible' and boot.get('modelConfigured') is True)

        if LIVE:
            check('新QA身份没有既有会话', not boot['sessions'])
            page.locator('#switch-character').click()
            page.locator('.character-option[data-scene-id="xiawuju-a"]').click()
            page.locator('#character-picker').wait_for(state='hidden')
            page.wait_for_function('()=>document.getElementById("scene-select").value==="xiawuju-a"')
            before = current(page)
            check('当前为独立夏无且侍医场景', before['characterId'] == 'xiawuju' and before['identity'] == '侍医' and not before['messages'])
            page.locator('#chat-input').fill(QUESTION)
            with page.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/messages')) as sending:
                page.locator('#send-message').click()
            response = sending.value
            page.locator('#stop-message').wait_for(state='hidden', timeout=130000)
            after = current(page)
            answers = [m for m in after['messages'] if m['role'] == 'assistant' and m['status'] == 'complete']
            complete = len(answers)
            turn = {'sceneId': 'xiawuju-a', 'question': QUESTION, 'httpStatus': response.status, 'completeReplies': complete,
                    'reply': answers[0]['content'] if answers else None, 'citations': answers[0]['citations'] if answers else [], 'sources': [],
                    'error': page.locator('#chat-error').inner_text() if page.locator('#chat-error').is_visible() else None}
            save(OUT/'turn.json', turn) # Preserve paid output even if a later UI assertion fails.
            check('仅一次应用提交并完成一条保存回复', posts == 1 and blocked == 0 and response.status == 200 and complete == 1)
            try:
                raw = response.text()
                for event in raw.replace('\r\n', '\n').split('\n\n'):
                    if event.startswith('event: meta\n'):
                        data = next((line[6:] for line in event.split('\n') if line.startswith('data: ')), '{}')
                        stream_modes.append(json.loads(data).get('mode'))
                stream_observation = 'read from the original response'
            except Exception:
                stream_observation = 'Chrome did not retain the SSE body; do not replay the paid request to obtain it'
            check('保存回复没有规则模拟标记', '【模拟' not in turn['reply'])
            if stream_modes:
                check('捕获的流式模式保持真实', all(mode == 'openai-compatible' for mode in stream_modes))
            for source_id in turn['citations']:
                value = page.evaluate('(id)=>fetch("/api/sources/"+id).then(r=>r.json())', source_id)
                turn['sources'].append(value.get('source'))
            save(OUT/'turn.json', turn)
            check('引用均可打开实际公开原文', bool(turn['citations']) and all(s and s['published'] and s['excerpt'] for s in turn['sources']))
            message = page.locator('.message.assistant[data-message-id]').last
            body = message.locator('.message-content').inner_text()
            note = message.locator('.message-reference-note')
            check('正文交代药囊行动并无原始JSON或F标记', '药囊' in body and '[[F' not in body and 'sourceIds' not in body and 'factId' not in body)
            check('独立资料区默认折叠', note.count() == 1 and not note.evaluate('(n)=>n.open'))
            note.locator('summary').click()
            check('资料缺口在独立资料区说明', '现有资料未找到所问具体细节的依据' in note.inner_text() and '当前选材的范围' in note.inner_text())
            check('引用原文及对应表述可展开查看', '对应表述' in note.inner_text() and all(s['excerpt'] in note.inner_text() for s in turn['sources']))
            check('未编造职业经历解释缺口', '并未逐一清点' not in body and '平日只负责供奉' not in body)
            message.locator('.citation-chip').first.click()
            check('引用按钮展开正文真实资料卡', page.locator('#reading-pane .source-card[open]').count() > 0)
            page.screenshot(path=str(OUT/'live-desktop.png'))
            page.set_viewport_size({'width': 390, 'height': 844})
            page.locator('#chat-tab').click()
            page.locator('#chat-input').fill(DRAFT)
            page.locator('#read-tab').click(); page.locator('#chat-tab').click()
            check('手机阅读聊天往返保留草稿与真实记录', page.locator('#chat-input').input_value() == DRAFT and current(page)['messages'] == after['messages'])
            check('手机资料说明未横向溢出', note.evaluate('(n)=>n.scrollWidth<=n.clientWidth+1'))
            page.screenshot(path=str(OUT/'live-mobile.png'))
            page.locator('#read-tab').click(); page.set_viewport_size({'width': 1440, 'height': 1000})
            pane = page.locator('#reading-pane')
            pane.evaluate('(n)=>{n.scrollTop=Math.round((n.scrollHeight-n.clientHeight)*.35)}')
            page.wait_for_timeout(1400)
            page.reload(wait_until='networkidle')
            check('刷新恢复同一人物与完整回复', current(page)['id'] == after['id'] and current(page)['messages'] == after['messages'])
            check('刷新保留草稿且没有重复调用', page.locator('#chat-input').input_value() == DRAFT and posts == 1 and blocked == 0)
            checkpoint(page, context); checkpoint_saved = True
            check('只保存当前新QA身份供实际重启后恢复', STATE.exists() and EXPECTED.exists())
        elif INSPECT:
            # Resume UI inspection of the already paid response. The route
            # blocks every message POST in this mode; never purchase a rerun.
            after = current(page)
            answers = [m for m in after['messages'] if m['role'] == 'assistant' and m['status'] == 'complete']
            turn = json.loads((OUT/'turn.json').read_text(encoding='utf-8'))
            check('只检查原先保存的同一条回复', after['sceneId'] == 'xiawuju-a' and len(answers) == 1 and answers[0]['content'] == turn['reply'])
            for source_id in turn['citations']:
                value = page.evaluate('(id)=>fetch("/api/sources/"+id).then(r=>r.json())', source_id)
                if not any(item and item.get('id') == source_id for item in turn['sources']):
                    turn['sources'].append(value.get('source'))
            save(OUT/'inspected-turn.json', turn)
            check('引用均可打开实际公开原文', bool(turn['citations']) and all(s and s['published'] and s['excerpt'] for s in turn['sources']))
            message = page.locator('.message.assistant[data-message-id]').last
            body = message.locator('.message-content').inner_text()
            note = message.locator('.message-reference-note')
            check('正文显示药囊行动且无原始格式泄漏', '药囊' in body and '[[F' not in body and 'sourceIds' not in body and 'factId' not in body)
            if '我未曾留意' in body:
                semantic_concerns.append('Reply invents having never attended to medicine contents; successful UI does not resolve this semantic concern.')
            check('独立资料区默认折叠', note.count() == 1 and not note.evaluate('(n)=>n.open'))
            note.locator('summary').click()
            check('资料缺口在独立资料区说明', '现有资料未找到所问具体细节的依据' in note.inner_text() and '当前选材的范围' in note.inner_text())
            check('引用原文与对应表述可展开查看', '对应表述' in note.inner_text() and all(s['excerpt'] in note.inner_text() for s in turn['sources']))
            message.locator('.citation-chip').first.click()
            check('引用按钮展开正文真实资料卡', page.locator('#reading-pane .source-card[open]').count() > 0)
            page.screenshot(path=str(OUT/'inspected-desktop.png'))
            page.set_viewport_size({'width': 390, 'height': 844}); page.locator('#chat-tab').click()
            page.locator('#chat-input').fill(DRAFT)
            page.locator('#read-tab').click(); page.locator('#chat-tab').click()
            check('手机阅读聊天往返保留草稿与记录', page.locator('#chat-input').input_value() == DRAFT and current(page)['messages'] == after['messages'])
            check('手机资料说明未横向溢出', note.evaluate('(n)=>n.scrollWidth<=n.clientWidth+1'))
            page.screenshot(path=str(OUT/'inspected-mobile.png'))
            page.locator('#read-tab').click(); page.set_viewport_size({'width': 1440, 'height': 1000})
            page.locator('#reading-pane').evaluate('(n)=>{n.scrollTop=Math.round((n.scrollHeight-n.clientHeight)*.35)}')
            page.wait_for_timeout(1400)
            page.reload(wait_until='networkidle')
            check('刷新恢复同一人物与原完整回复', current(page)['id'] == after['id'] and current(page)['messages'] == after['messages'])
            check('刷新保留草稿且没有重发模型', page.locator('#chat-input').input_value() == DRAFT and posts == 0 and blocked == 0)
            checkpoint(page, context); checkpoint_saved = True
            check('只保存当前QA身份供实际重启恢复', STATE.exists() and EXPECTED.exists())
        else:
            expected = json.loads(EXPECTED.read_text(encoding='utf-8'))
            page.wait_for_timeout(1400)
            restored = current(page)
            check('实际重启后恢复原QA会话与人物', restored['id'] == expected['sessionId'] and restored['sceneId'] == expected['sceneId'] and restored['characterId'] == expected['characterId'])
            check('实际重启后原完整对话与条件一致', restored['messages'] == expected['messages'] and restored['conditions'] == expected['conditions'])
            check('实际重启后草稿保留', page.locator('#chat-input').input_value() == expected['draft'])
            pane = page.locator('#reading-pane')
            check('实际重启后阅读位置恢复', abs(pane.evaluate('(n)=>n.scrollTop')-expected['scrollTop']) < 20)
            actual_open = pane.locator('details[open]').evaluate_all('(nodes)=>nodes.map(n=>n.id)')
            check('实际重启后展开的阅读资料保留', set(actual_open) == set(expected['openSections']))
            check('恢复全过程没有调用模型或尝试重发', posts == 0 and blocked == 0)
            page.screenshot(path=str(OUT/'restored-after-restart.png'))
        check('无浏览器页面脚本异常', not errors)
    except Exception:
        failure = traceback.format_exc()
        try:
            page.screenshot(path=str(OUT/('live-failure.png' if LIVE else 'restore-failure.png')))
        except Exception:
            pass
    finally:
        if (LIVE or INSPECT) and selected:
            try:
                checkpoint(page, context); checkpoint_saved = True
            except Exception:
                try:
                    context.storage_state(path=str(STATE)); checkpoint_saved = True
                except Exception:
                    pass
        browser.close()

report = {
    'date': '2026-10-29', 'execution': 'live_chrome' if LIVE else 'inspect_existing_paid_reply_without_new_call' if INSPECT else 'restore_after_actual_service_restart',
    'browserRuntime': 'Installed Chrome controlled by Playwright fallback after official runtime bootstrap failure',
    'maximumApplicationPosts': MAX_POSTS, 'applicationPosts': posts, 'blockedExtraPosts': blocked,
    'completeRealModeReplies': complete if LIVE else 0, 'serviceMode': service_mode,
    'operatorModelLabel': os.environ.get('RUSHI_MODEL_LABEL','qwen3.5-omni-plus'), 'providerIdentityIndependentlyVerified': False,
    'providerAttempts': 'not precisely instrumented; server permits at most one shared retry',
    'providerAttemptUpperBound': posts*2, 'tokensAndCost': 'not measured',
    'privateQaCheckpointSaved': checkpoint_saved if LIVE or INSPECT else False,
    'streamBodyObservation': stream_observation, 'observedSemanticConcerns': semantic_concerns,
    'checks': checks, 'passed': sum(item['passed'] for item in checks), 'failed': sum(not item['passed'] for item in checks),
    'browserErrors': errors, 'failure': failure,
    'semanticReview': 'pending independent review of saved turn; UI success alone is not full semantic acceptance',
}
save(REPORT, report)
print(json.dumps(report, ensure_ascii=False))
if failure:
    raise RuntimeError(failure)
