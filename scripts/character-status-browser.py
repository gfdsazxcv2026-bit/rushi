"""Real Chrome regression for explicitly adopted character body states.

Run only after the coordinating agent confirms the updated service is ready.
All contexts are new anonymous contexts: no saved identity or user session is loaded.
The server must be in explicitly labelled mock mode.
"""
import json
import os
import re
import traceback
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ.get('RUSHI_TEST_BASE', 'http://127.0.0.1:4317').rstrip('/')
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs' / 'qa'
RESULTS = []
ERRORS = []
EXPECTED_HTTP = []
CONSOLE_ERRORS = []
WOUND = re.compile(r'濒死|濒危|重伤|伤势|伤口|伤处|气息|疼痛|受伤|命在旦夕')


def check(name, value, detail=''):
    RESULTS.append({'name': name, 'passed': bool(value), 'detail': detail})
    if not value:
        raise AssertionError(name + (': ' + str(detail) if detail else ''))


def current_id(page, chapter):
    return page.evaluate('(id) => JSON.parse(localStorage.getItem("rushi:session:" + id))', chapter)


def current_session(page, chapter):
    sid = current_id(page, chapter)
    return page.evaluate('(id) => fetch("/api/sessions/" + encodeURIComponent(id)).then(r => r.json())', sid)


def open_fresh_page(browser, chapter='jingke', mobile=False):
    context = browser.new_context(viewport={'width': 390 if mobile else 1440, 'height': 844 if mobile else 900}, is_mobile=mobile, has_touch=mobile, locale='zh-CN')
    page = context.new_page()
    page.on('pageerror', lambda error: ERRORS.append(str(error)))

    def console(msg):
        if msg.type != 'error':
            return
        url = msg.location.get('url', '')
        CONSOLE_ERRORS.append({'message': msg.text, 'url': url})

    page.on('console', console)
    page.goto(f'{BASE}/#/chapter/{chapter}', wait_until='networkidle')
    page.locator('#chapter-view:not([hidden])').wait_for()
    boot = page.evaluate('() => fetch("/api/bootstrap").then(r => r.json())')
    if boot.get('mode') != 'mock':
        raise RuntimeError('本脚本只验收标注的mock模式，未发起真实模型调用。')
    check(f'{chapter}新匿名上下文不含原有会话', len(boot.get('sessions', [])) == 0)
    if mobile:
        page.locator('#chat-tab').click()
    return context, page


def open_settings(page):
    if not page.locator('#plot-settings').evaluate('(n) => n.open'):
        page.locator('#plot-settings summary').click()


def close_settings(page):
    if page.locator('#plot-settings').evaluate('(n) => n.open'):
        page.locator('#plot-settings summary').click()


def adopt(page, kind='character_status', status='critical', text=None):
    open_settings(page)
    page.locator('#condition-type').select_option(kind)
    if kind == 'character_status':
        page.locator('#condition-status').select_option(status)
    if text is not None:
        page.locator('#condition-text').fill(text)
    page.locator('#condition-known').uncheck()
    with page.expect_response(lambda r: '/conditions' in r.url and r.request.method == 'POST') as response:
        page.locator('#adopt-condition').click()
    response = response.value
    payload = response.request.post_data_json
    if response.status == 200:
        page.locator('#plot-badge').filter(has_text='假设剧情').wait_for()
    return response, payload


def send(page, text, label):
    close_settings(page)
    page.locator('#chat-input').fill(text)
    page.locator('#send-message').click()
    page.locator('#stop-message').wait_for(state='visible')
    page.locator('#stop-message').wait_for(state='hidden', timeout=20000)
    check(label + '完整生成成功', page.locator('#chat-input').input_value() == '', page.locator('#chat-error').inner_text() if page.locator('#chat-error').is_visible() else '')
    return page.locator('.message.assistant .message-content').last.inner_text()


def attempt_continue(page, source_id):
    if not page.locator('#continue-details').evaluate('(n) => n.open'):
        page.locator('#continue-details summary').click()
    page.locator('#source-session').select_option(source_id)
    page.locator('#source-snapshot').select_option('')
    with page.expect_response(lambda r: r.url.endswith('/api/sessions') and r.request.method == 'POST') as response:
        page.locator('#start-continue').click()
    return response.value


def run_case(browser, name, function, mobile=False, chapter='jingke'):
    context = None
    try:
        context, page = open_fresh_page(browser, chapter, mobile)
        function(page)
    except Exception:
        RESULTS.append({'name': name + '流程异常', 'passed': False, 'detail': traceback.format_exc()})
        if context:
            try:
                page.screenshot(path=str(OUT / f'character-status-{name}-failure.png'), full_page=False)
            except Exception:
                pass
    finally:
        if context:
            context.close()


def critical_and_recovery(page):
    check('模拟横幅明确为规则演示和自由剧情边界', page.locator('#mock-banner').is_visible() and '规则演示' in page.locator('#mock-banner').inner_text() and '接入模型' in page.locator('#mock-banner').inner_text())
    original = page.locator('#article-body').inner_text()
    response, payload = adopt(page)
    check('濒死预设提交结构化status且背景知情默认不勾选', response.status == 200 and payload.get('type') == 'character_status' and payload.get('status') == 'critical' and payload.get('characterId') == 'yingzheng' and payload.get('knownToCurrent') is False)
    saved = current_session(page, 'jingke')
    first_id = saved['id']
    check('濒死状态已保存且没有误记为死亡', saved['conditions'][-1].get('status') == 'critical' and saved['conditions'][-1]['type'] == 'character_status')
    reply = send(page, '你现在身体状况如何？', '濒死首轮')
    check('无需勾选背景知情也能承接自身濒死状态', bool(WOUND.search(reply)) and '现有资料未找到依据' not in reply, reply)
    note = page.locator('.message.assistant').last.locator('.message-creation-note')
    check('角色正文与创作说明分开且默认折叠', note.count() == 1 and not note.evaluate('(n) => n.open') and '创作说明：' not in reply)
    note.locator('summary').click()
    check('创作说明可以按需展开', note.locator('.supplement-body').is_visible())
    note.locator('summary').click()
    send(page, '史料记载，荆轲献图行刺秦王时发生了什么？', '假设分支查看史料')
    check('假设分支资料chips明确仅作历史参考', '历史参考，不作为假设剧情的事实证明' in page.locator('.message.assistant').last.locator('.message-source-info').inner_text())
    reply = send(page, '现在还能继续说话吗？', '濒死多轮')
    check('后续普通追问仍尊重濒死状态', bool(WOUND.search(reply)), reply)
    adopted_ids = [c['id'] for c in current_session(page, 'jingke')['conditions']]
    reply = send(page, '如果李斯现在来救你，你会对他说些什么？', '已采用后继续问如果')
    check('已采用后的如果追问继续承接伤势而非要求重复采用', bool(WOUND.search(reply)) and '若要把某项条件用于这条演绎' not in reply, reply)
    check('讨论李斯救援不自动成为救援完成或新增条件', [c['id'] for c in current_session(page, 'jingke')['conditions']] == adopted_ids)
    check('濒死演绎未改正式正文', page.locator('#article-body').inner_text() == original)
    page.screenshot(path=str(OUT / 'character-status-desktop.png'), full_page=False)
    page.reload(wait_until='networkidle')
    page.locator('#session-origin').wait_for(state='visible')
    restored = current_session(page, 'jingke')
    check('刷新恢复同一濒死会话和假设类型', restored['id'] == first_id and restored['mode'] == 'hypothetical' and restored['conditions'][-1].get('status') == 'critical')
    check('刷新恢复完整说明且仍按需折叠', page.locator('.message-creation-note').count() > 0 and all(not item.evaluate('(n) => n.open') for item in page.locator('.message-creation-note').all()) and any('\n\n创作说明：' in item.get('content', '') for item in restored['messages']))
    reply = send(page, '眼下你最急迫的事情是什么？', '刷新后濒死')
    check('刷新后回答仍承接伤势', bool(WOUND.search(reply)), reply)
    page.locator('#next-chapter a').click()
    page.locator('#chapter-breadcrumb').filter(has_text='第2章').wait_for()
    response = attempt_continue(page, first_id)
    check('伤势结果未明时跨年续接被明确阻止', response.status == 409, response.text())
    EXPECTED_HTTP.append({'url': response.url, 'status': response.status, 'note': '未明确濒死后果，预期拒绝跨章续接'})
    page.locator('#chat-error').wait_for(state='visible')
    check('跨章冲突说明恢复或明确后果路径', bool(re.search(r'恢复|伤势|结果|前提', page.locator('#chat-error').inner_text())))
    page.locator('#return-source').click()
    page.locator('#chapter-breadcrumb').filter(has_text='第1章').wait_for()
    page.locator('#session-origin').wait_for(state='visible')
    response, payload = adopt(page, status='normal')
    check('明确获救恢复提交normal而非清空假设分支', response.status == 200 and payload.get('status') == 'normal')
    recovered = current_session(page, 'jingke')
    check('恢复保留历史设定记录与假设标记', recovered['mode'] == 'hypothetical' and recovered['conditions'][-1].get('status') == 'normal' and len(recovered['conditions']) >= 2)
    reply = send(page, '现在身体怎么样？', '明确恢复后')
    check('明确恢复后回答承接最新状态', bool(re.search(r'恢复|获救|缓过|脱离|无伤|平稳', reply)), reply)
    page.locator('#next-chapter a').click()
    page.locator('#chapter-breadcrumb').filter(has_text='第2章').wait_for()
    response = attempt_continue(page, first_id)
    check('来源明确恢复后能够向后续接', response.status == 201, response.text())
    page.locator('#session-origin').filter(has_text='续接自').wait_for()
    continued = current_session(page, 'unification')
    check('恢复后的续接保留来源快照与假设性质', continued['sourceSessionId'] == first_id and bool(continued['sourceSnapshotId']) and continued['mode'] == 'hypothetical')


def custom_critical(page):
    text = '嬴政被荆轲刺中，正处于濒死状态，但还没有死亡。'
    response, payload = adopt(page, kind='custom', text=text)
    check('自定义保留用户原句提交', response.status == 200 and payload.get('type') == 'custom' and payload.get('text') == text)
    saved = current_session(page, 'jingke')
    check('自定义濒死原句保留且兼容结构化伤势', saved['conditions'][-1]['text'] == text and saved['conditions'][-1].get('status') == 'critical')
    reply = send(page, '你现在身体怎样？', '自定义濒死')
    check('自定义濒死也能实际承接', bool(WOUND.search(reply)) and '现有资料未找到依据' not in reply, reply)


def injured(page):
    response, payload = adopt(page, status='injured')
    check('受伤预设提交injured', response.status == 200 and payload.get('status') == 'injured')
    reply = send(page, '你的伤势如何？', '受伤预设')
    check('受伤状态正常交谈并有伤势反馈', bool(WOUND.search(reply)), reply)
    check('受伤未被升级成濒死或死亡', current_session(page, 'jingke')['conditions'][-1].get('status') == 'injured')


def actor_isolation(page):
    response, _ = adopt(page)
    check('统一后同样可采用濒死状态', response.status == 200)
    source = current_session(page, 'unification')
    close_settings(page)
    page.locator('#scene-select').select_option('lisi-b')
    page.locator('#switch-character').click()
    page.locator('#character-name').filter(has_text='李斯').wait_for()
    lisi = current_session(page, 'unification')
    check('李斯沿用分支但不会自动获知嬴政伤势', lisi['branchId'] == source['branchId'] and not any(WOUND.search(k.get('text', '')) for k in lisi.get('knowledge', [])))
    reply = send(page, '说说你眼下能够确认的处境。', '李斯未知伤势')
    check('李斯普通回答不主动泄漏未知伤势', not WOUND.search(reply), reply)
    page.locator('#scene-select').select_option('yingzheng-b')
    page.locator('#switch-character').click()
    page.locator('#character-name').filter(has_text='嬴政').wait_for()
    reply = send(page, '你的伤势现在如何？', '切回嬴政')
    check('切回本人仍能承接自身伤势', bool(WOUND.search(reply)), reply)


def ordinary_hypothesis(page):
    send(page, '如果嬴政在行刺后濒死，会怎样？', '普通濒死假设提问')
    saved = current_session(page, 'jingke')
    check('普通假设提问不自动采用身体状态', saved['mode'] == 'historical' and len(saved['conditions']) == 0)
    send(page, '史料记载，荆轲献图行刺秦王时发生了什么？', '独立史实资料问题')
    check('普通史料答复资料chips标为本轮检索资料', '本轮检索资料' in page.locator('.message.assistant').last.locator('.message-source-info').inner_text())


def no_resurrection(page):
    response, _ = adopt(page, kind='character_dead')
    check('死亡条件仍可明确采用', response.status == 200)
    before = current_session(page, 'jingke')
    response, _ = adopt(page, status='normal')
    check('恢复预设不能让已死人物直接复活', 400 <= response.status < 500, response.text())
    EXPECTED_HTTP.append({'url': response.url, 'status': response.status, 'note': '已死人物不能通过恢复预设复活，预期拒绝'})
    after = current_session(page, 'jingke')
    check('被拒绝的复活不改变既有条件', [c['id'] for c in after['conditions']] == [c['id'] for c in before['conditions']])


def mobile_preset(page):
    response, payload = adopt(page, status='critical')
    check('手机濒死预设与未勾选背景知情提交成功', response.status == 200 and payload.get('status') == 'critical' and payload.get('knownToCurrent') is False)
    close_settings(page)
    reply = send(page, '你的身体状况如何？', '手机濒死')
    check('手机实际聊天承接自身濒死状态', bool(WOUND.search(reply)), reply)
    page.locator('#chat-input').fill('这条身体状态测试草稿尚未发送。')
    page.locator('#read-tab').click()
    page.locator('#reading-pane').evaluate('(n) => { n.scrollTop = 280; }')
    read_top = page.locator('#reading-pane').evaluate('(n) => n.scrollTop')
    page.locator('#chat-tab').click()
    check('手机切换视图保留濒死对话和未发送输入', WOUND.search(page.locator('.message.assistant .message-content').last.inner_text()) is not None and page.locator('#chat-input').input_value() == '这条身体状态测试草稿尚未发送。')
    page.locator('#read-tab').click()
    check('手机身体状态交互后保留阅读位置', abs(page.locator('#reading-pane').evaluate('(n) => n.scrollTop') - read_top) < 2)
    page.locator('#chat-tab').click()
    open_settings(page)
    page.locator('#condition-type').select_option('character_status')
    page.locator('#condition-status').select_option('injured')
    bounds = page.locator('#send-message').bounding_box()
    check('手机展开身体状态表单不推出发送区', bounds is not None and bounds['y'] + bounds['height'] <= 844)
    check('手机身体状态表单无水平溢出', not page.evaluate('() => document.documentElement.scrollWidth > innerWidth + 1'))
    check('手机仅切换预设不自动采用新的身体状态', current_session(page, 'jingke')['conditions'][-1].get('status') == 'critical')
    page.screenshot(path=str(OUT / 'character-status-mobile.png'), full_page=False)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe', headless=True)
        for name, function, chapter, mobile in [
            ('critical-and-recovery', critical_and_recovery, 'jingke', False),
            ('custom-critical', custom_critical, 'jingke', False),
            ('injured', injured, 'jingke', False),
            ('actor-isolation', actor_isolation, 'unification', False),
            ('ordinary-hypothesis', ordinary_hypothesis, 'jingke', False),
            ('no-resurrection', no_resurrection, 'jingke', False),
            ('mobile-preset', mobile_preset, 'jingke', True),
        ]:
            run_case(browser, name, function, mobile=mobile, chapter=chapter)
        browser.close()
    for console_error in CONSOLE_ERRORS:
        if not any(item['url'] == console_error['url'] and str(item['status']) in console_error['message'] for item in EXPECTED_HTTP):
            ERRORS.append(console_error)
    RESULTS.append({'name': '无非预期浏览器脚本或控制台错误', 'passed': len(ERRORS) == 0, 'detail': ERRORS})
    report = {'createdAt': datetime.now(timezone.utc).isoformat(), 'verification': '真实系统Chrome + Playwright操作，后端为明确标注的mock规则模式；不是模型真实调用验收', 'scope': '全部使用新建匿名浏览器上下文，仅操作本次新建测试会话；未读取或改动用户已有会话', 'desktop': '1440×900', 'mobile': '390×844', 'results': RESULTS, 'passed': sum(r['passed'] for r in RESULTS), 'failed': sum(not r['passed'] for r in RESULTS), 'errors': ERRORS, 'expectedHttpErrors': EXPECTED_HTTP}
    (OUT / 'character-status-browser-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
