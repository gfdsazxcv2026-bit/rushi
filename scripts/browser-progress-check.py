"""Real Chrome regression for expanded-source reading restoration. No model calls."""
import json
import os
from pathlib import Path
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('RUSHI_BASE_URL', 'http://127.0.0.1:4317').rstrip('/')
OUT = ROOT / 'docs' / 'qa' / 'demo2' / 'qwen38-live'
OUT.mkdir(parents=True, exist_ok=True)
report = {'startedAt': datetime.now(timezone.utc).isoformat(), 'scope': 'Actual Chrome; fresh anonymous identities; all model message POSTs blocked.', 'modelCalls': 0, 'checks': [], 'blockedModelCalls': 0, 'browserErrors': []}


def check(name, ok, detail=None):
    report['checks'].append({'name': name, 'passed': bool(ok), 'detail': detail})
    if not ok:
        raise AssertionError(name + ': ' + str(detail))


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe'), headless=True)
    try:
        for mobile in [False, True]:
            name = 'mobile' if mobile else 'desktop'
            context = browser.new_context(viewport={'width': 390 if mobile else 1440, 'height': 844 if mobile else 900}, is_mobile=mobile, has_touch=mobile, locale='zh-CN')

            def deny_model(route):
                report['blockedModelCalls'] += 1
                route.abort('blockedbyclient')

            context.route('**/api/sessions/*/messages', deny_model)
            page = context.new_page()
            page.on('pageerror', lambda e: report['browserErrors'].append(str(e)))
            page.goto(BASE + '/#/chapter/jingke', wait_until='networkidle')
            page.locator('#chapter-view:not([hidden])').wait_for()
            page.locator('.source-card').first.evaluate('(n) => { n.open = true; }')
            page.locator('.supplement').first.evaluate('(n) => { n.open = true; }')
            page.wait_for_timeout(250)
            pane = page.locator('#reading-pane')
            pane.evaluate('(n) => { n.scrollTop = Math.round((n.scrollHeight - n.clientHeight) * .42); }')
            expected_top = pane.evaluate('(n) => n.scrollTop')
            expected_open = pane.locator('details[open]').evaluate_all('(nodes) => nodes.map(n => n.id)')
            if mobile:
                page.locator('#chat-tab').click()
            page.locator('#chat-input').fill('仅供阅读恢复回归的未发送草稿')
            if mobile:
                page.locator('#read-tab').click()
                check(name + ': switching retains position', abs(pane.evaluate('(n) => n.scrollTop') - expected_top) < 2)
                page.locator('#chat-tab').click()
            page.wait_for_timeout(1300)
            saved = page.evaluate('() => fetch("/api/bootstrap").then(r => r.json()).then(b => b.progress.jingke)')
            check(name + ': server stores expanded sections', saved['openSections'] == expected_open)
            check(name + ': server stores pixel position', abs(saved['scrollTop'] - expected_top) < 2)
            for fallback in [False, True]:
                label = name + (': server fallback' if fallback else ': local restore')
                if fallback:
                    page.evaluate('() => { localStorage.removeItem("rushi:progress:jingke"); localStorage.removeItem("rushi:draft:chapter:jingke"); }')
                page.reload(wait_until='networkidle')
                page.locator('#chapter-view:not([hidden])').wait_for()
                check(label + ': same reading position', abs(pane.evaluate('(n) => n.scrollTop') - expected_top) < 2)
                check(label + ': same expanded sections', pane.locator('details[open]').evaluate_all('(nodes) => nodes.map(n => n.id)') == expected_open)
                check(label + ': draft retained', page.locator('#chat-input').input_value() == '仅供阅读恢复回归的未发送草稿')
                check(label + ': correct tab', page.locator('#reading-layout').get_attribute('data-view') == ('chat' if mobile else 'read'))
            check(name + ': no horizontal overflow', not page.evaluate('() => document.documentElement.scrollWidth > innerWidth + 1'))
            page.screenshot(path=str(OUT / ('progress-regression-' + name + '.png')))
            context.close()
        check('No model requests attempted', report['blockedModelCalls'] == 0)
        check('No browser script errors', report['browserErrors'] == [])
    finally:
        browser.close()
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        report['passed'] = sum(c['passed'] for c in report['checks'])
        report['failed'] = sum(not c['passed'] for c in report['checks'])
        (OUT / 'progress-regression-browser.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False, indent=2))
