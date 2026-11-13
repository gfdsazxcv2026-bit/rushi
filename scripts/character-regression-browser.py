import json
import sys
import shutil
import os
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
if '--live' not in sys.argv:
    print('计划：10组人物回归，最多24次应用提交。实际调用须显式运行 --live，可能产生费用。')
    raise SystemExit(0)
OUT = Path(os.environ.get('RUSHI_DIALOGUE_OUT', str(ROOT / 'docs' / 'qa' / ('character-recheck-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')))))
OUT.mkdir(parents=True,exist_ok=True)
if not (OUT/'scenarios.json').exists(): shutil.copyfile(ROOT/'eval/character-regression-cases.json',OUT/'scenarios.json')
REPORT = OUT / 'browser-dialogue.json'
LEDGER = ROOT / 'data' / 'qa-state' / (OUT.name + '-character-conversation-budget.json')
LEDGER.parent.mkdir(parents=True,exist_ok=True)
BASE = os.environ.get('RUSHI_BASE_URL','http://127.0.0.1:4317')
suite = json.loads((OUT / 'scenarios.json').read_text(encoding='utf-8'))


def read(path, fallback):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else fallback


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


assert not REPORT.exists(), 'Do not repeat paid cases or overwrite evidence; review the existing report.'
assert not LEDGER.exists(), 'A call budget already exists; do not start a second paid run.'
report = {'startedAt': datetime.now(timezone.utc).isoformat(), 'execution': 'Actual Windows Chrome UI messages against localhost real model mode', 'modelLabel': 'qwen3.8-omni-flash', 'providerIdentityIndependentlyAudited': False, 'maximumApplicationPosts': suite['maximumApplicationChatPosts'], 'privacy': 'Fresh test contexts; C04 intentionally shares C03 to test switching. No existing-user identity accessed.', 'scope': 'Focus on actual replies; technical checks and human/assistant content judgment stay separate. No code or prompt changes.', 'cases': [], 'newApplicationPosts': 0, 'browserErrors': []}
active = None


def session(page):
    sid = page.evaluate('() => JSON.parse(localStorage.getItem("rushi:session:" + location.hash.split("/")[2].split("?")[0]))')
    return page.evaluate('(id) => fetch("/api/sessions/"+id).then(r=>r.json())', sid) if sid else None


def summary(s):
    return {k: s.get(k) for k in ['id', 'sceneId', 'characterName', 'identity', 'mode', 'sourceSessionId', 'sourceSnapshotId', 'characterStatus', 'conditions', 'knowledge']} if s else None


def check(name, passed):
    active['technicalChecks'].append({'name': name, 'passed': bool(passed)})
    if not passed:
        raise AssertionError(name)


def close_plot(page):
    if page.locator('#plot-settings').evaluate('(n)=>n.open'):
        page.locator('#plot-settings summary').click()


def chat(page, step):
    close_plot(page)
    before = session(page)
    ids_before = {m['id'] for m in (before or {}).get('messages', [])}
    page.locator('#chat-input').fill(step['text'])
    with page.expect_response(lambda r: '/messages' in r.url and r.request.method == 'POST') as pending:
        page.locator('#send-message').click()
    response = pending.value
    deadline = time.monotonic() + 80
    while time.monotonic() < deadline:
        if page.locator('#chat-input').input_value() == '':
            break
        if page.locator('#chat-error').is_visible() and page.locator('#stop-message').is_hidden():
            break
        page.wait_for_timeout(140)
    after = session(page)
    answers = [m for m in (after or {}).get('messages', []) if m['id'] not in ids_before and m['role'] == 'assistant' and m['status'] == 'complete']
    expected = step.get('expectedHttp', 200)
    turn = {'question': step['text'], 'httpStatus': response.status, 'expectedHttp': expected, 'completeReply': len(answers) == 1, 'reply': answers[0]['content'] if answers else None, 'displayedError': page.locator('#chat-error').inner_text() if page.locator('#chat-error').is_visible() else None, 'citations': answers[0].get('citations', []) if answers else [], 'stateBefore': summary(before), 'stateAfter': summary(after)}
    try:
        stream = response.text()
        turn['referenceRepairUsed'] = 'event: reset' in stream
        turn['responseKind'] = 'evidence-gap' if '"responseKind":"evidence-gap"' in stream else 'character' if answers else 'blocked'
    except Exception:
        turn['referenceRepairUsed'] = None
    # Chrome may no longer expose a consumed fetch-stream body. Classify from
    # the durable explicit response marker, independent of DevTools buffering.
    turn['responseKind'] = 'evidence-gap' if answers and answers[0]['content'].startswith('【资料核对】') else 'character' if answers else 'blocked'
    turn['sources'] = [page.evaluate('(id)=>fetch("/api/sources/"+id).then(r=>r.json())', source_id) for source_id in turn['citations']]
    active['turns'].append(turn)
    check('Expected HTTP status', response.status == expected)
    check('Complete assistant response' if expected == 200 else 'No completed dead-character response', len(answers) == (1 if expected == 200 else 0))
    print(json.dumps({'case': active['id'], 'turn': len(active['turns']), 'question': turn['question'], 'reply': turn['reply'], 'error': turn['displayedError']}, ensure_ascii=False), flush=True)


def adopt(page, step):
    if not page.locator('#plot-settings').evaluate('(n)=>n.open'):
        page.locator('#plot-settings summary').click()
    page.locator('#condition-type').select_option(step['type'])
    if step['type'] == 'character_status':
        page.locator('#condition-status').select_option(step['status'])
    if step.get('text'):
        page.locator('#condition-text').fill(step['text'])
    page.locator('#condition-known').set_checked(step.get('known', False))
    with page.expect_response(lambda r: '/conditions' in r.url and r.request.method == 'POST') as response:
        page.locator('#adopt-condition').click()
    check('Adopted condition persisted', response.value.status == 200)
    page.wait_for_function('()=>!document.getElementById("adopt-condition").disabled')
    active['operations'].append({'action': 'adopt', 'stateAfter': summary(session(page))})
    close_plot(page)


def switch(page, step):
    close_plot(page)
    page.locator('#scene-select').select_option(step['scene'])
    with page.expect_response(lambda r: '/switch' in r.url and r.request.method == 'POST') as response:
        page.locator('#switch-character').click()
    check('Switch succeeded', response.value.status == 200)
    page.wait_for_function('()=>document.getElementById("character-name").textContent.includes("李斯")')
    active['operations'].append({'action': 'switch', 'stateAfter': summary(session(page))})


def continued(page, step):
    source = session(page)
    page.goto(BASE + '/#/chapter/' + step['chapter'], wait_until='networkidle')
    page.locator('#continue-details summary').click()
    page.locator('#source-session').select_option(source['id'])
    page.wait_for_timeout(250)
    page.locator('#source-snapshot').select_option('')
    with page.expect_response(lambda r: r.url.endswith('/api/sessions') and r.request.method == 'POST') as response:
        page.locator('#start-continue').click()
    check('Continuation succeeded', response.value.status == 201)
    page.wait_for_function('()=>document.getElementById("session-origin").textContent.includes("续接自")')
    child = session(page)
    check('Correct source inherited', child['sourceSessionId'] == source['id'])
    active['operations'].append({'action': 'continue', 'stateAfter': summary(child)})


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH',r'C:\Program Files\Google\Chrome\Application\chrome.exe'), headless=True)
    contexts = {}
    try:
        for case in suite['cases']:
            active = {'id': case['id'], 'title': case['title'], 'criteria': case['criteria'], 'turns': [], 'operations': [], 'technicalChecks': [], 'semanticVerdict': 'pending_readthrough'}
            report['cases'].append(active)
            try:
                if case.get('reuse'):
                    ctx, page = contexts[case['reuse']]
                else:
                    ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN')
                    page = ctx.new_page()
                    page.on('pageerror', lambda e: report['browserErrors'].append(str(e)))

                    def gate(route):
                        if route.request.method != 'POST':
                            route.continue_()
                            return
                        ledger = read(LEDGER, {'maximumApplicationPosts': suite['maximumApplicationChatPosts'], 'attempts': []})
                        if len(ledger['attempts']) >= suite['maximumApplicationChatPosts']:
                            route.abort('blockedbyclient')
                            return
                        payload = route.request.post_data_json
                        ledger['attempts'].append({'case': active['id'], 'text': payload.get('text'), 'requestId': payload.get('requestId'), 'at': datetime.now(timezone.utc).isoformat()})
                        save(LEDGER, ledger)
                        report['newApplicationPosts'] += 1
                        route.continue_()

                    ctx.route('**/api/sessions/*/messages', gate)
                    page.goto(BASE + '/#/chapter/' + case['chapter'], wait_until='networkidle')
                    boot = page.evaluate('()=>fetch("/api/bootstrap").then(r=>r.json())')
                    check('Fresh visitor and real mode', not boot['sessions'] and boot['mode'] == 'openai-compatible' and boot['modelConfigured'])
                contexts[case['id']] = (ctx, page)
                for step in case['steps']:
                    {'chat': chat, 'adopt': adopt, 'switch': switch, 'continue': continued}[step['action']](page, step)
                    save(REPORT, report)
                page.screenshot(path=str(OUT / (case['id'] + '-last-reply.png')))
                active['executionStatus'] = 'completed'
            except Exception:
                active['executionStatus'] = 'failed'
                active['failure'] = traceback.format_exc()
            save(REPORT, report)
    finally:
        for ctx in {id(pair[0]): pair[0] for pair in contexts.values()}.values():
            ctx.close()
        browser.close()
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        report['summary'] = {'completedCases': sum(c.get('executionStatus') == 'completed' for c in report['cases']), 'failedCases': sum(c.get('executionStatus') == 'failed' for c in report['cases']), 'applicationPosts': report['newApplicationPosts'], 'completeReplies': sum(t['completeReply'] for c in report['cases'] for t in c['turns']), 'modelReplies': sum(t['completeReply'] and t.get('responseKind') == 'character' for c in report['cases'] for t in c['turns']), 'evidenceOnlyReplies': sum(t['completeReply'] and t.get('responseKind') == 'evidence-gap' for c in report['cases'] for t in c['turns']), 'semanticJudgment': 'pending_readthrough'}
        save(REPORT, report)
        print(json.dumps(report['summary'], ensure_ascii=False), flush=True)
