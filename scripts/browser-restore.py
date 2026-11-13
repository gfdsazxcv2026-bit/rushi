import os
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = ROOT / 'data' / 'qa-state'
STATE_DIR.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('RUSHI_BASE_URL', 'http://127.0.0.1:4317').rstrip('/')
OUT = ROOT / 'docs' / 'qa'
expected = json.loads((STATE_DIR / 'frontend-restore-expected.json').read_text(encoding='utf-8'))
report_path = OUT / 'browser-report.json'
report = json.loads(report_path.read_text(encoding='utf-8'))
results = []

def check(name, value, detail=''):
    results.append({'name': name, 'passed': bool(value), 'detail': detail})

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe'), headless=True)
    context = browser.new_context(viewport=expected['viewport'], storage_state=str(STATE_DIR / 'frontend-browser-storage.json'), locale='zh-CN')
    page = context.new_page()
    page_errors = []
    page.on('pageerror', lambda e: page_errors.append(str(e)))
    page.goto(f"{BASE}/#/chapter/{expected['chapterId']}", wait_until='networkidle')
    page.locator('#session-origin').wait_for(state='visible')
    sid = page.evaluate('(id) => JSON.parse(localStorage.getItem("rushi:session:" + id))', expected['chapterId'])
    session = page.evaluate('(id) => fetch("/api/sessions/" + id).then(r => r.json())', sid)
    check('实际服务重启后游客身份与会话恢复', sid == expected['sessionId'] and session.get('branchId') == expected['branchId'])
    check('实际服务重启后假设条件与人物恢复', session.get('mode') == expected['mode'] and session.get('characterName') == expected['characterName'] and [c['id'] for c in session.get('conditions', [])] == expected['conditionIds'])
    check('实际服务重启后完整聊天记录恢复', len([m for m in session.get('messages', []) if m['status'] == 'complete']) == expected['messageCount'])
    check('实际服务重启后未发送输入恢复', page.locator('#chat-input').input_value() == expected['draft'])
    check('实际服务重启后阅读位置恢复', abs(page.locator('#reading-pane').evaluate('(n) => n.scrollTop') - expected['scrollTop']) < 35)
    check('实际服务重启恢复无浏览器错误', len(page_errors) == 0, page_errors)
    page.screenshot(path=str(OUT / 'desktop-after-restart.png'), full_page=False)
    browser.close()

report['results'].extend(results)
report['passed'] = sum(r['passed'] for r in report['results'])
report['failed'] = sum(not r['passed'] for r in report['results'])
report['restartVerification'] = '本脚本核对重启后的恢复。调用者须先实际停止并重启同一服务；测试身份保存在 data/qa-state，不应公开分发。'
report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'results': results, 'totalPassed': report['passed'], 'totalFailed': report['failed']}, ensure_ascii=False, indent=2))

if report['failed'] or report.get('errors'):
    raise SystemExit(1)
