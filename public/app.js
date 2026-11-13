const $ = id => document.getElementById(id);
const state = { boot: null, chapter: null, chapterData: null, session: null, generating: false, switchingCharacter: false, startingSession: false, adoptingCondition: false, selectingSceneId: null, previewSceneId: null, conditionSceneId: null, characterPickerOrigin: null, preparingMessage: false, controller: null, pending: null, routeVersion: 0, toastTimer: null, progressTimer: null, snapshotsForSource: [], modelMode: null, modelPhase: 'unverified' };
const store = {
  get(key, fallback = null) { try { const value = localStorage.getItem(`rushi:${key}`); return value === null ? fallback : JSON.parse(value); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`rushi:${key}`, JSON.stringify(value)); } catch { /* Browser storage may be disabled; server records remain available. */ } },
  remove(key) { try { localStorage.removeItem(`rushi:${key}`); } catch {} }
};
function node(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'text') n.textContent = String(value);
    else if (key === 'class') n.className = value;
    else if (key === 'on') for (const [event, handler] of Object.entries(value)) n.addEventListener(event, handler);
    else n.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child != null) n.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return n;
}
function clear(n) { n.replaceChildren(); return n; }
function setChatSettingsOpen(open) {
  const panel = $('chat-settings-panel'), toggle = $('chat-settings-toggle');
  if (!open && panel.contains(document.activeElement)) toggle.focus({ preventScroll: true });
  toggle.setAttribute('aria-expanded', String(open));
  $('chat-settings-toggle-text').textContent = open ? '收起' : '展开';
  panel.setAttribute('aria-hidden', String(!open));
  panel.inert = !open;
  panel.classList.toggle('is-open', open);
}
function setupReadingSplit() {
  const layout = $('reading-layout'), divider = $('reading-splitter'), reader = $('reading-pane');
  const desktop = matchMedia('(min-width: 761px)');
  const saved = store.get('reading-split', 0.5);
  let ratio = typeof saved === 'number' && Number.isFinite(saved) && saved > 0 && saved < 1 ? saved : 0.5;
  let drag = null;
  function dimensions() {
    const bounds = layout.getBoundingClientRect();
    if (!desktop.matches || !bounds.width || !bounds.height) return null;
    const gap = parseFloat(getComputedStyle(layout).columnGap) || 0;
    const available = bounds.width - gap;
    if (available <= 0) return null;
    const min = Math.min(320, available / 2), max = available - Math.min(350, available / 2);
    return { bounds, gap, available, min, max };
  }
  function render() {
    const size = dimensions();
    if (!size) return;
    const width = Math.max(size.min, Math.min(size.max, ratio * size.available));
    layout.style.setProperty('--reading-fr', `${width}fr`);
    layout.style.setProperty('--chat-fr', `${size.available - width}fr`);
    layout.style.setProperty('--split-position', `${width + size.gap / 2}px`);
    divider.setAttribute('aria-valuemin', String(Math.round(size.min / size.available * 100)));
    divider.setAttribute('aria-valuemax', String(Math.round(size.max / size.available * 100)));
    const percent = Math.round(width / size.available * 100);
    divider.setAttribute('aria-valuenow', String(percent));
    divider.setAttribute('aria-valuetext', `阅读 ${percent}%，聊天 ${100 - percent}%`);
  }
  function commit(value) { ratio = value; render(); store.set('reading-split', ratio); }
  function finish(event) {
    if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.id)) return;
    const id = drag.id;
    drag = null;
    document.body.classList.remove('resizing-reading');
    if (divider.hasPointerCapture(id)) divider.releasePointerCapture(id);
    store.set('reading-split', ratio);
  }
  divider.addEventListener('pointerdown', event => {
    const size = dimensions();
    if (!size || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    drag = { id: event.pointerId, offset: event.clientX - size.bounds.left - reader.getBoundingClientRect().width - size.gap / 2 };
    divider.setPointerCapture(event.pointerId);
    divider.focus({ preventScroll: true });
    document.body.classList.add('resizing-reading');
  });
  divider.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const size = dimensions();
    if (!size) { finish(event); return; }
    ratio = Math.max(size.min, Math.min(size.max, event.clientX - size.bounds.left - size.gap / 2 - drag.offset)) / size.available;
    render();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) divider.addEventListener(name, finish);
  window.addEventListener('blur', () => finish());
  window.addEventListener('pagehide', () => finish());
  divider.addEventListener('dblclick', () => commit(0.5));
  divider.addEventListener('keydown', event => {
    const size = dimensions();
    if (!size) return;
    let next = reader.getBoundingClientRect().width / size.available;
    if (event.key === 'ArrowLeft') next -= event.shiftKey ? 0.1 : 0.02;
    else if (event.key === 'ArrowRight') next += event.shiftKey ? 0.1 : 0.02;
    else if (event.key === 'Home') next = size.min / size.available;
    else if (event.key === 'End') next = size.max / size.available;
    else if (event.key === 'Enter') next = 0.5;
    else return;
    event.preventDefault();
    commit(Math.max(size.min, Math.min(size.max, next * size.available)) / size.available);
  });
  desktop.addEventListener('change', () => { finish(); render(); });
  new ResizeObserver(render).observe(layout);
  render();
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5200); }
function normalizeError(error) {
  if (error?.name === 'AbortError') return '已停止生成，输入已保留。未完成回复不会作为已发生剧情保存。';
  return error?.message || '暂时无法完成操作，请稍后重试。';
}
function chatError(error) {
  const errorBox = $('chat-error'); errorBox.hidden = !error;
  if (!error) { errorBox.textContent = ''; return; }
  let text = normalizeError(error);
  if (error.code === 'SCENE_CONFLICT') {
    text += ' 原记录仍保留；可在上方选择兼容人物，或从本章史实重开。';
    if (error.details) {
      const detailText = typeof error.details === 'string' ? error.details : Array.isArray(error.details) ? error.details.map(item => item.message).filter(Boolean).join('；') : error.details.message;
      if (detailText) text += ` ${detailText}`;
    }
  }
  errorBox.textContent = text;
}
async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET' && state.boot?.csrfToken) headers['X-CSRF-Token'] = state.boot.csrfToken;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`服务器返回异常（${response.status}），请重新连接。`); }
  if (!response.ok) {
    const details = data.error || data;
    const e = new Error(details.message || `请求未完成（${response.status}）`);
    Object.assign(e, { code: details.code, details: details.details, status: response.status, retryable: details.retryable });
    throw e;
  }
  return data;
}
function track(type, extra = {}) { if (state.boot) api('/api/events', { method: 'POST', body: { type, ...extra } }).catch(() => {}); }
function isPublished(c) { return c?.status === 'published'; }
function scenesFor(chapterId) { return (state.chapterData?.scenes || state.boot?.scenes || []).filter(s => s.chapterId === chapterId && (s.status === undefined || isPublished(s))); }
function chapterMeta(id) { return state.boot?.chapters?.find(c => c.id === id); }
function sceneMeta(id) { return [...(state.chapterData?.scenes || []), ...(state.boot?.scenes || [])].find(s => s.id === id); }
function momentKey(scene) { return scene ? scene.momentId || `${scene.chapterId}:${scene.year}` : null; }
function sceneMomentLabel(scene) { return scene?.momentLabel || scene?.timeLabel || scene?.title || '当前时点'; }
function interfaceBusy() { return state.generating || state.switchingCharacter || state.startingSession || state.adoptingCondition; }
function currentCharacterScene() { return sceneMeta(state.session?.sceneId || $('scene-select').value); }
function sessionLabel(s) { const c = chapterMeta(s.chapterId); const scene = sceneMeta(s.sceneId); return `第${c?.order || '?'}章 · ${s.characterName || scene?.characterName || s.characterId || '人物'} · ${s.mode === 'hypothetical' ? '假设剧情' : '历史场景演绎'} · ${String(s.id).slice(0, 6)}`; }
function dateLabel(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function sessionsList() { return Array.isArray(state.boot?.sessions) ? state.boot.sessions : []; }
function updateSessionIndex(session) {
  if (!state.boot) return;
  state.boot.sessions = sessionsList().filter(s => s.id !== session.id);
  state.boot.sessions.unshift(session);
}
function runtimeMode() { return state.modelMode || state.boot?.mode; }
function inputLimit() { const value = Number(state.boot?.limits?.inputChars); return Number.isInteger(value) && value > 0 ? value : 2000; }
function setModelPhase(phase, mode) {
  if (['mock', 'openai-compatible'].includes(mode)) state.modelMode = mode;
  state.modelPhase = phase;
  renderModelStatus();
}
function renderModelStatus() {
  if (!state.boot) return;
  const mode = runtimeMode();
  const mock = mode === 'mock';
  $('global-mode').textContent = mock ? '模拟 Demo' : mode === 'openai-compatible' ? '模型对话' : '模式待确认';
  $('global-mode').classList.toggle('mock', mock);
  $('global-mode').title = mock ? '当前为有限规则模拟' : '对话模式不代表连接成功或内容验收通过';
  $('global-notice').textContent = mock ? '体验版 · 当前为模拟对话，回复中会明确标注。章节按核对进度逐章开放。' : '体验版 · 当前已选择模型对话模式，连接状态以聊天区提示为准。章节按核对进度逐章开放。';
  const text = {
    unverified: state.boot.modelConfigured === false ? '模型对话模式 · 服务器配置尚未完整，本页尚未完成回答。' : '模型对话模式 · 本页尚未完成回答；选择模式不代表连接成功。',
    generating: '模型对话模式 · 正在等待完整回答；完成前不保存本轮剧情变化。',
    checking: '模型对话模式 · 正在核对资料并重新整理回答；完成前不保存本轮剧情变化。',
    evidence: '资料核对答复 · 当前资料不足以确认完整名单；本次未调用模型。',
    complete: '模型对话模式 · 本轮回答已完整返回；内容与角色表现仍需验收。',
    restored: '模型对话模式 · 已恢复先前完整回答，本次未发起新模型调用。',
    failed: '模型对话模式 · 本次调用未完成，输入已保留；请按下方提示恢复。',
    cancelled: '模型对话模式 · 已停止生成，输入已保留；未完成回复不写入剧情。'
  };
  $('mock-banner').textContent = mock ? '模拟模式 · 当前为规则演示，任意自由剧情需接入模型。' : mode === 'openai-compatible' ? (text[state.modelPhase] || text.unverified) : '对话模式尚未确认，请重新连接。';
  $('mock-banner').hidden = !state.chapter || scenesFor(state.chapter.id).length === 0;
  $('chat-input').maxLength = inputLimit();
  updateInputCount();
}

async function bootstrap() {
  $('loading-view').hidden = false; $('loading-text').textContent = '正在展开历史长卷……'; $('bootstrap-retry').hidden = true;
  try {
    state.boot = await api('/api/bootstrap');
    state.boot.chapters ||= []; state.boot.periods ||= []; state.boot.scenes ||= []; state.boot.sessions ||= [];
    state.modelMode = state.boot.mode; state.modelPhase = 'unverified'; renderModelStatus();
    if (store.get('visited')) track('return_visit');
    store.set('visited', new Date().toISOString());
    renderTimeline(); renderDirectory(); await route();
  } catch (error) {
    $('loading-text').textContent = `暂时无法连接本地服务：${normalizeError(error)}`;
    $('bootstrap-retry').hidden = false;
  }
}

function renderTimeline() {
  const root = clear($('timeline'));
  for (const period of state.boot.periods) {
    const published = isPublished(period);
    const title = node('h3', { text: period.name });
    const toggle = node('button', { class: 'period-heading', type: 'button', 'aria-expanded': 'false', 'aria-controls': `period-detail-${period.id}` }, [title, node('span', { class: `period-status${published ? ' live' : ''}`, text: published ? '已开放' : '待公开' })]);
    const detail = node('div', { class: 'period-detail', id: `period-detail-${period.id}` }, [node('p', { text: period.summary || '这一时期的故事正在整理，敬请期待。' })]);
    const card = node('section', { class: 'period', 'data-period-id': period.id }, [node('div', { class: 'period-years', text: period.years || '' }), node('div', { class: 'period-node', 'aria-hidden': 'true' }), node('div', { class: 'period-body' }, [toggle, detail])]);
    const links = node('div', { class: 'period-links' });
    if (published) {
      for (const id of (period.chapterIds || []).slice(0, 2)) {
        const chapter = chapterMeta(id);
        if (chapter && isPublished(chapter)) links.append(node('a', { class: 'period-chapter', href: `#/chapter/${id}`, text: `${chapter.order ? `第${chapter.order}章 · ` : ''}${chapter.title}` }));
      }
      links.append(node('a', { class: 'period-enter', href: '#/qin', text: '进入秦朝专题 ↗' }));
    } else links.append(node('button', { type: 'button', class: 'period-enter', text: '想读这个时代 · 待公开', on: { click: () => { track('coming_soon_interest', { value: period.id }); toast('已记录你的兴趣。这个时期仍在准备中，当前没有开放正文或聊天。'); } } }));
    detail.append(links);
    toggle.addEventListener('click', () => { const expanded = !card.classList.contains('expanded'); card.classList.toggle('expanded', expanded); toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false'); });
    card.addEventListener('mouseenter', () => toggle.setAttribute('aria-expanded', 'true'));
    card.addEventListener('mouseleave', () => { if (!card.classList.contains('expanded') && !card.contains(document.activeElement)) toggle.setAttribute('aria-expanded', 'false'); });
    card.addEventListener('focusin', () => toggle.setAttribute('aria-expanded', 'true'));
    card.addEventListener('focusout', event => { if (!card.contains(event.relatedTarget) && !card.classList.contains('expanded')) toggle.setAttribute('aria-expanded', 'false'); });
    root.append(card);
  }
}
function renderDirectory() {
  const chapters = [...state.boot.chapters].sort((a, b) => a.order - b.order);
  const published = chapters.filter(isPublished).length;
  $('published-count').textContent = `${published} / ${chapters.length} 章已开放 · 逐章核对`;
  const root = clear($('chapter-list'));
  for (const chapter of chapters) {
    const live = isPublished(chapter);
    const body = node('div', {}, [node('div', { class: 'chapter-meta' }, [node('span', { class: chapter.eraLabel?.includes('前传') ? 'era-tag' : '', text: chapter.eraLabel || '秦朝专题' }), node('span', { text: chapter.timeLabel || '' })]), node('h2', { text: chapter.title }), node('p', { text: chapter.summary || chapter.subtitle || '内容正在资料核对中，完成后逐章开放。' })]);
    const card = node(live ? 'a' : 'article', { class: `chapter-card${live ? ' live' : ''}`, ...(live ? { href: `#/chapter/${chapter.id}` } : {}), 'data-chapter-id': chapter.id }, [node('span', { class: 'chapter-number', text: String(chapter.order).padStart(2, '0') }), body, node('span', { class: live ? 'chapter-open' : 'coming-badge', text: live ? '进入故事 ↗' : '待公开' })]);
    root.append(card);
  }
}

function showView(name) {
  for (const id of ['loading', 'home', 'directory', 'chapter']) $(`${id}-view`).hidden = id !== name;
  document.body.classList.toggle('in-chapter', name === 'chapter');
  document.querySelectorAll('[data-nav]').forEach(n => n.classList.toggle('active', n.dataset.nav === (name === 'home' ? 'home' : 'qin')));
}
async function route() {
  if (!state.boot) return;
  const hash = location.hash || '#/';
  const match = hash.match(/^#\/chapter\/([^/?]+)/);
  const version = ++state.routeVersion;
  if ($('character-picker').open) $('character-picker').close();
  if (state.generating) state.controller?.abort();
  if (!match) {
    state.chapter = null; state.chapterData = null; state.session = null;
    showView(hash.startsWith('#/qin') ? 'directory' : 'home'); document.title = hash.startsWith('#/qin') ? '秦朝专题 · 入史' : '入史 · 进入历史的现场'; window.scrollTo(0, 0); return;
  }
  const chapterId = decodeURIComponent(match[1]);
  if (!isPublished(chapterMeta(chapterId))) { toast('这一章尚未公开，正文和人物聊天暂不可访问。'); location.hash = '#/qin'; return; }
  showView('loading');
  try {
    const data = await api(`/api/chapters/${encodeURIComponent(chapterId)}`);
    if (version !== state.routeVersion) return;
    state.chapterData = data; state.chapter = data.chapter; state.session = null; state.pending = null; state.previewSceneId = null; state.conditionSceneId = null;
    renderChapter(); showView('chapter');
    document.title = `${data.chapter.title} · 入史`;
    const storedProgress = store.get(`progress:${chapterId}`, null) || getServerProgress(chapterId) || {};
    setMobileView(storedProgress.view === 'chat' ? 'chat' : 'read', false);
    const expanded = new Set(storedProgress.openSections || []);
    $('reading-pane').querySelectorAll('details').forEach(section => { section.open = expanded.has(section.id); });
    requestAnimationFrame(() => {
      if (version !== state.routeVersion) return;
      const pane = $('reading-pane');
      const extent = Math.max(0, pane.scrollHeight - pane.clientHeight);
      // Expanded sources change the height. Restore them before using the saved
      // position; fall back to a ratio after a viewport or content size change.
      const sameExtent = Number.isFinite(storedProgress.scrollExtent) && Math.abs(storedProgress.scrollExtent - extent) < 2;
      pane.scrollTop = Math.max(0, sameExtent && Number.isFinite(storedProgress.scrollTop) ? storedProgress.scrollTop : extent * Number(storedProgress.ratio || 0));
    });
    const params = new URLSearchParams(hash.includes('?') ? hash.split('?')[1] : '');
    const savedSession = params.get('session') || store.get(`session:${chapterId}`);
    if (savedSession) {
      try { const session = await api(`/api/sessions/${encodeURIComponent(savedSession)}`); if (version === state.routeVersion && session.chapterId === chapterId) applySession(session); }
      catch { if (version === state.routeVersion) { store.remove(`session:${chapterId}`); renderEmptyChat(); } }
    }
    if (version !== state.routeVersion) return;
    if (!state.session) renderEmptyChat();
    populateSourceSessions();
    track('chapter_open', { chapterId });
  } catch (error) { if (version === state.routeVersion) { toast(normalizeError(error)); location.hash = '#/qin'; } }
}
function getServerProgress(chapterId) {
  const progress = state.boot?.progress;
  return Array.isArray(progress) ? progress.find(p => p.chapterId === chapterId) : progress?.[chapterId];
}
function renderChapter() {
  const c = state.chapter;
  $('chapter-breadcrumb').textContent = `第${c.order}章 · ${c.eraLabel || '秦朝专题'}`;
  clear($('article-meta')).append(node('span', { class: c.eraLabel?.includes('前传') ? 'era-tag' : '', text: c.eraLabel || '秦朝专题' }), node('span', { text: c.timeLabel || '' }), node('span', { class: 'review-tag', text: c.reviewStatus === 'checked' ? '本版资料已核对' : '资料核对状态待确认' }), node('span', { text: `v${c.version || '1.0'}` }));
  $('article-title').textContent = c.title; $('article-summary').textContent = c.summary || '';
  clear($('article-body')).append(...(c.paragraphs || []).map(text => node('p', { text })));
  const supplements = clear($('article-supplements'));
  for (const [index, item] of (c.supplements || []).entries()) supplements.append(node('details', { class: 'supplement', id: `supplement-${c.id}-${index}` }, [node('summary', { text: item.title }), node('div', { class: 'supplement-body', text: typeof item.body === 'string' ? item.body : JSON.stringify(item.body) })]));
  const sources = clear($('article-sources'));
  for (const source of state.chapterData.sources || []) {
    const details = node('details', { class: 'source-card', id: `source-${source.id}` }, [node('summary', { text: source.title }), node('p', { class: 'source-location', text: [source.author, source.location].filter(Boolean).join(' · ') }), node('blockquote', { text: source.excerpt || '请沿原文定位查阅资料。' })]);
    try { const url = new URL(source.url); if (['https:', 'http:'].includes(url.protocol)) details.append(node('a', { class: 'source-link', href: url.href, target: '_blank', rel: 'noopener noreferrer', text: '查阅来源原文 ↗' })); } catch {}
    sources.append(details);
  }
  if (!sources.childElementCount) sources.append(node('p', { class: 'section-caption', text: '当前没有可展示的已公开资料片段。' }));
  renderNextChapter();
  const scenes = scenesFor(c.id);
  clear($('scene-select')).append(...scenes.map(s => node('option', { value: s.id, text: `${s.characterName} · ${s.identity} · ${s.momentLabel || s.title}` })));
  const available = scenes.length > 0;
  for (const id of ['chat-settings-toggle', 'chat-controls', 'messages', 'plot-settings', 'chat-form']) $(id).hidden = !available;
  setChatSettingsOpen(false);
  $('chat-unavailable').hidden = available;
  renderModelStatus();
  $('session-origin').hidden = true; $('plot-settings').open = false; chatError(null);
  $('character-name').textContent = '与人物相遇'; $('character-avatar').textContent = '秦'; $('scene-description').textContent = available ? '选择历史场景，开始交流' : '本章人物场景暂未开放';
  $('plot-badge').textContent = '历史场景演绎'; $('plot-badge').classList.remove('hypothetical');
  clear($('condition-list')); clear($('knowledge-list')); $('condition-count').textContent = '0 项';
  $('condition-type').value = 'custom'; $('condition-text').value = ''; $('condition-known').checked = false; updateConditionPreset();
  $('chat-input').value = store.get(`draft:chapter:${c.id}`, getServerProgress(c.id)?.draft || ''); updateInputCount();
  setBusy(false); $('send-message').disabled = !available;
}
function renderNextChapter() {
  const root = clear($('next-chapter'));
  const next = chapterMeta(state.chapter.nextId) || state.boot.chapters.find(c => c.order === state.chapter.order + 1);
  if (!next) { root.append(node('p', { class: 'next-pending', text: '秦朝专题至此收束。后续时代正在准备中。' })); return; }
  if (!isPublished(next)) { root.append(node('small', { text: '下一章 · 待公开' }), node('p', { class: 'next-pending', text: next.title })); return; }
  const link = node('a', { href: `#/chapter/${next.id}`, on: { click: () => { saveProgressNow(); track('next_chapter', { chapterId: state.chapter.id, sessionId: state.session?.id, value: next.id }); } } }, [node('div', {}, [node('small', { text: '继续阅读 · 下一章' }), node('h3', { text: next.title })]), node('span', { class: 'next-arrow', text: '→', 'aria-hidden': 'true' })]);
  root.append(link);
}
function setMobileView(view, persist = true) {
  $('reading-layout').dataset.view = view; $('read-tab').setAttribute('aria-selected', String(view === 'read')); $('chat-tab').setAttribute('aria-selected', String(view === 'chat'));
  const mobile = matchMedia('(max-width: 760px)').matches;
  $('reading-pane').inert = mobile && view !== 'read'; $('chat-pane').inert = mobile && view !== 'chat';
  if (persist) saveProgressNow();
}
function saveProgressNow() {
  if (!state.chapter) return;
  const data = { chapterId: state.chapter.id, ...readingProgress(), view: $('reading-layout').dataset.view || 'read', draft: $('chat-input').value };
  store.set(`progress:${data.chapterId}`, data);
  api('/api/progress', { method: 'POST', body: data }).catch(() => {});
}
function readingProgress() {
  const pane = $('reading-pane');
  const scrollExtent = Math.max(0, pane.scrollHeight - pane.clientHeight);
  return { ratio: Math.min(1, Math.max(0, pane.scrollTop / Math.max(1, scrollExtent))), scrollTop: pane.scrollTop, scrollExtent, openSections: [...pane.querySelectorAll('details[open]')].map(section => section.id) };
}
function scheduleProgress() { if (!state.chapter) return; store.set(`progress:${state.chapter.id}`, { ...readingProgress(), view: $('reading-layout').dataset.view || 'read' }); clearTimeout(state.progressTimer); state.progressTimer = setTimeout(saveProgressNow, 1000); }
function showSources(sourceId) {
  setMobileView('read');
  const target = sourceId ? document.getElementById(`source-${sourceId}`) : $('sources-section');
  if (!target) { toast('当前章节没有这一条已公开资料。'); return; }
  if (target.tagName === 'DETAILS') target.open = true;
  target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

function updateSceneControls() {
  const scenes = state.chapter ? scenesFor(state.chapter.id) : [];
  const selected = sceneMeta($('scene-select').value);
  const busy = interfaceBusy();
  $('scene-select').disabled = busy || scenes.length < 2;
  $('switch-character').disabled = busy || !scenes.length;
  $('switch-character').textContent = state.switchingCharacter ? '正在进入…' : '选择人物';
  $('switch-character').setAttribute('aria-busy', String(state.switchingCharacter));
  for (const id of ['send-message', 'start-fresh', 'return-source', 'adopt-condition', 'condition-type', 'condition-status', 'condition-text', 'condition-known']) $(id).disabled = busy || !scenes.length;
  $('start-continue').disabled = busy || !$('source-session').value; $('return-source').disabled = busy || !$('source-session').value;
  $('chat-input').readOnly = busy;
  $('retry-message').disabled = busy;
  $('composer-hint').textContent = state.generating ? '正在生成；可以停止。完整回复完成后才保存本次剧情变化。' : state.switchingCharacter ? '正在进入人物会话，原对话和输入分别保留。' : 'Enter 发送 · Shift + Enter 换行';
  for (const card of $('character-picker-list').querySelectorAll('button')) card.disabled = busy;
  $('character-picker-list').setAttribute('aria-busy', String(state.switchingCharacter));
  $('character-picker-status').textContent = state.switchingCharacter ? `正在进入${sceneMeta(state.selectingSceneId)?.characterName || '人物'}的会话……` : '';
  const help = clear($('scene-selection-help'));
  if (!scenes.length) { help.textContent = '本章人物对话暂未开放。'; return; }
  if (busy) help.textContent = state.generating ? '正在回复，完成或停止后可选择人物。' : '正在保存或进入会话，请稍候。';
  else if (state.session && selected?.id !== state.session.sceneId) help.textContent = momentKey(selected) === momentKey(currentCharacterScene()) ? `点击“选择人物”与${selected?.characterName || '所选人物'}交流，原对话分别保留。` : `点击“选择人物”进入${sceneMomentLabel(selected)}，会使用独立会话，原剧情仍保留。`;
  else help.textContent = scenes.length === 1 ? `点击“选择人物”查看${scenes[0].characterName}的身份与时点，直接进入交流。` : '点击“选择人物”查看可交流的人物与时点，选中即可进入。';
}

function updateCharacterHeader(scene, session = null) {
  if (!scene) return;
  const name = session?.characterName || scene.characterName || scene.characterId;
  $('character-name').textContent = name;
  const avatar = scene.avatar || name;
  $('character-avatar').textContent = avatar;
  $('character-avatar').dataset.long = String(Array.from(avatar).length > 2);
  $('scene-description').textContent = [scene.identity, scene.momentLabel || scene.title].filter(Boolean).join(' · ');
  updateConditionCharacter(scene);
}

function updateConditionCharacter(scene) {
  if (!scene) return;
  const changed = state.conditionSceneId && state.conditionSceneId !== scene.id;
  state.conditionSceneId = scene.id;
  const name = scene.characterName || '当前人物';
  $('condition-type').querySelector('[value="character_status"]').textContent = `${name}受伤 / 濒死 / 恢复`;
  $('condition-type').querySelector('[value="character_dead"]').textContent = `${name}已死亡`;
  $('condition-status-label').textContent = `${name}的身体状态`;
  $('condition-status-help').textContent = `${name}能直接感知自己的伤势；其他人物仍须亲眼看到或收到消息才会获知。跨章前需明确伤势结果，不会自动恢复。`;
  if (changed) { $('condition-type').value = 'custom'; $('condition-text').value = ''; $('condition-known').checked = false; }
  if (changed || $('condition-type').value !== 'custom') updateConditionPreset();
}

function renderCharacterPicker() {
  const root = clear($('character-picker-list'));
  const scenes = [...scenesFor(state.chapter.id)].sort((a, b) => (a.momentOrder ?? 0) - (b.momentOrder ?? 0));
  const groups = new Map();
  for (const scene of scenes) { const key = momentKey(scene); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(scene); }
  const current = currentCharacterScene();
  for (const [key, choices] of groups) {
    const sameMoment = Boolean(state.session && momentKey(current) === key);
    const section = node('section', { class: 'character-picker-group', 'data-moment-id': key });
    section.append(node('h3', { text: sceneMomentLabel(choices[0]) }), node('p', { class: 'character-group-help', text: sameMoment ? '同一时点 · 切换人物，对话分别保留' : `进入${sceneMomentLabel(choices[0])} · 独立会话` }));
    const cards = node('div', { class: 'character-picker-cards' });
    for (const scene of choices) {
      const isCurrent = state.session?.sceneId === scene.id;
      const card = node('button', { type: 'button', class: `character-option${isCurrent ? ' is-current' : ''}`, 'data-scene-id': scene.id, 'data-character-id': scene.characterId, 'data-current': String(isCurrent), 'aria-label': `${scene.characterName}，${scene.identity}，${sceneMomentLabel(scene)}${isCurrent ? '，当前人物' : sameMoment ? '，切换交流' : '，独立会话'}`, on: { click: () => selectCharacter(scene.id) } }, [
        node('span', { class: 'character-option-avatar', 'aria-hidden': 'true', text: scene.avatar || scene.characterName }),
        node('span', { class: 'character-option-body' }, [node('span', { class: 'character-option-name' }, [node('strong', { text: scene.characterName }), ...(isCurrent ? [node('span', { class: 'character-current-mark', text: '当前人物' })] : [])]), node('span', { class: 'character-option-identity', text: scene.identity }), node('span', { class: 'character-option-time', text: scene.timeLabel || scene.momentLabel || scene.title }), node('span', { class: 'character-option-action', text: isCurrent ? '返回当前对话' : sameMoment ? '与此人交流 →' : `进入${sceneMomentLabel(scene)} · 独立会话 →` })])
      ]);
      cards.append(card);
    }
    section.append(cards); root.append(section);
  }
  updateSceneControls();
}

function openCharacterPicker() {
  if (interfaceBusy() || !state.chapter) return;
  state.characterPickerOrigin = document.activeElement;
  $('character-picker-error').hidden = true; $('character-picker-error').textContent = '';
  renderCharacterPicker();
  if (!$('character-picker').open) $('character-picker').showModal();
  $('character-picker').scrollTop = 0;
  requestAnimationFrame(() => {
    if (!$('character-picker').open) return;
    $('close-character-picker').focus({ preventScroll: true });
    $('character-picker').scrollTop = 0;
  });
}

function focusCharacterChat() {
  if ($('character-picker').open) $('character-picker').close();
  setMobileView('chat');
  requestAnimationFrame(() => $('chat-input').focus());
}

async function selectCharacter(sceneId) {
  if (interfaceBusy() || !state.chapter) return null;
  const scene = scenesFor(state.chapter.id).find(item => item.id === sceneId);
  if (!scene) return null;
  if (state.session?.sceneId === scene.id) { focusCharacterChat(); return state.session; }
  const previous = state.session;
  const previousScene = sceneMeta(previous?.sceneId);
  const chapterId = state.chapter.id, routeVersion = state.routeVersion;
  const sameMoment = previous && momentKey(previousScene) === momentKey(scene);
  persistDraft(); chatError(null);
  $('character-picker-error').hidden = true;
  state.switchingCharacter = true; state.selectingSceneId = scene.id; updateSceneControls();
  try {
    let session;
    if (sameMoment) session = await api(`/api/sessions/${encodeURIComponent(previous.id)}/switch`, { method: 'POST', body: { sceneId: scene.id } });
    else {
      const recent = sessionsList().filter(item => item.chapterId === chapterId && item.sceneId === scene.id).sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0];
      if (recent) {
        try { session = await api(`/api/sessions/${encodeURIComponent(recent.id)}`); }
        catch (error) { if (error.status !== 404) throw error; state.boot.sessions = sessionsList().filter(item => item.id !== recent.id); }
      }
      if (!session) session = await api('/api/sessions', { method: 'POST', body: { chapterId, sceneId: scene.id } });
    }
    updateSessionIndex(session);
    if (state.routeVersion !== routeVersion || state.chapter?.id !== chapterId) return session;
    applySession(session);
    setModelPhase((session.messages || []).some(message => message.role === 'assistant' && message.status === 'complete') ? 'restored' : 'unverified');
    focusCharacterChat();
    toast(sameMoment ? `已与${scene.characterName}相见，人物对话分别保留。` : `已进入${sceneMomentLabel(scene)}，原时点的会话仍然保留。`);
    return session;
  } catch (error) {
    if (state.routeVersion !== routeVersion) return null;
    chatError(error);
    if ($('character-picker').open) { $('character-picker-error').textContent = $('chat-error').textContent; $('character-picker-error').hidden = false; }
    if (previous) $('scene-select').value = previous.sceneId;
    return null;
  } finally { state.switchingCharacter = false; state.selectingSceneId = null; updateSceneControls(); }
}

function renderEmptyChat() {
  if (!state.chapter) return;
  const scene = sceneMeta($('scene-select').value);
  if (!scene) return;
  if (state.previewSceneId && state.previewSceneId !== scene.id) {
    store.set(`draft:scene:${state.previewSceneId}`, $('chat-input').value);
    $('chat-input').value = store.get(`draft:scene:${scene.id}`, ''); updateInputCount();
  }
  state.previewSceneId = scene.id;
  updateCharacterHeader(scene);
  clear($('messages')).append(node('div', { class: 'empty-chat' }, [node('span', { class: 'empty-seal', text: '问' }), node('p', { text: scene.greeting || '历史已经翻开。你可以从眼前的局势问起。' }), node('p', { text: '不必读完正文，也可以现在开始。' }), node('div', { class: 'suggestions' }, [suggestion('你如何看待眼前的局势？'), suggestion('现有资料记载了什么？'), suggestion('如果换一种选择，会怎样？')])]));
  updateSceneControls();
}
function suggestion(text) { return node('button', { type: 'button', text, on: { click: () => { $('chat-input').value = text; persistDraft(); $('chat-input').focus(); } } }); }
function populateSourceSessions() {
  if (!state.chapter) return;
  const candidates = sessionsList().filter(s => s.id !== state.session?.id && (chapterMeta(s.chapterId)?.order || 0) <= state.chapter.order);
  const select = clear($('source-session'));
  if (!candidates.length) select.append(node('option', { value: '', text: '暂无可承接的会话' }));
  else for (const s of candidates) select.append(node('option', { value: s.id, text: sessionLabel(s) }));
  $('continue-details').hidden = candidates.length === 0;
  $('start-continue').disabled = candidates.length === 0;
  $('return-source').disabled = candidates.length === 0;
  clear($('source-snapshot')).append(node('option', { value: '', text: '使用来源当前状态' }));
  if (candidates.length) loadSourceSnapshots().catch(() => {});
}
async function loadSourceSnapshots() {
  const id = $('source-session').value;
  clear($('source-snapshot')).append(node('option', { value: '', text: '使用来源当前状态' }));
  if (!id) return;
  const session = await api(`/api/sessions/${encodeURIComponent(id)}`);
  if ($('source-session').value !== id) return;
  state.snapshotsForSource = session.snapshots || [];
  for (const snapshot of [...state.snapshotsForSource].reverse()) $('source-snapshot').append(node('option', { value: snapshot.id, text: `${snapshot.label || '保存的快照'} · ${dateLabel(snapshot.createdAt)}` }));
}
function applySession(session, { scrollBottom = true, resetDraft = true } = {}) {
  state.session = session; updateSessionIndex(session);
  store.set(`session:${session.chapterId}`, session.id);
  const hashParts = location.hash.split('?');
  const params = new URLSearchParams(hashParts[1] || '');
  if (params.has('session')) { params.set('session', session.id); history.replaceState(null, '', `${hashParts[0]}?${params}`); }
  const scene = sceneMeta(session.sceneId);
  if (scene && [...$('scene-select').options].some(o => o.value === scene.id)) $('scene-select').value = scene.id;
  state.previewSceneId = session.sceneId;
  updateCharacterHeader(scene, session);
  const hypothetical = session.mode === 'hypothetical';
  $('plot-badge').textContent = hypothetical ? '假设剧情' : '历史场景演绎'; $('plot-badge').classList.toggle('hypothetical', hypothetical);
  $('session-origin').hidden = false;
  const source = sessionsList().find(s => s.id === session.sourceSessionId);
  $('session-origin').textContent = session.sourceSessionId ? `续接自 ${source ? sessionLabel(source) : String(session.sourceSessionId).slice(0, 8)}${session.sourceSnapshotId ? ` · 快照 ${String(session.sourceSnapshotId).slice(0, 8)}` : ''}。后续独立保存。` : `独立史实起点 · 当前会话 ${String(session.id).slice(0, 8)}。旧分支仍然保存。`;
  updateSceneControls();
  renderMessages(scrollBottom); renderConditions();
  if (resetDraft) {
    $('chat-input').value = store.get(`draft:${session.id}`, '');
    state.pending = store.get(`pending:${session.id}`, null);
  }
  $('retry-message').hidden = !state.pending; updateInputCount();
  populateSourceSessions();
}
function renderMessages(scrollBottom = true) {
  const root = clear($('messages'));
  const session = state.session;
  if (!session) return;
  const scene = sceneMeta(session.sceneId);
  if (!(session.messages || []).length) root.append(messageNode({ role: 'assistant', content: scene?.greeting || '你想从何事问起？' }, true));
  for (const message of session.messages || []) if (!message.status || message.status === 'complete') root.append(messageNode(message));
  if (scrollBottom) requestAnimationFrame(() => root.scrollTop = root.scrollHeight);
}
function displayReferenceMarkers(text, citations = []) {
  return String(text).replace(/\[资料\s*[:：]\s*([^\]\r\n]*)\]/gu, (marker, id) => {
    const index = citations.indexOf(id.trim());
    return index < 0 ? marker : `〔资料${index + 1}〕`;
  });
}
function displayStreamingText(text) {
  // Citation IDs are transport protocol. Before server validation there is no link.
  return String(text).replace(/\[资料\s*[:：]\s*[^\]\r\n]*\]/gu, '〔资料核对中〕').replace(/\[资料\s*[:：][^\]\r\n]*$/u, '〔资料核对中〕');
}
function splitReplyNotes(content) {
  // Only blank-line + line-start section markers are formatting protocol.
  // Quoted phrases and inline mentions remain ordinary character text.
  const marker = /\r?\n\r?\n(创作说明|资料说明)：/gu;
  const matches = [...content.matchAll(marker)];
  if (!matches.length || matches[0].index === 0) return { body: content, notes: [] };
  return {
    body: content.slice(0, matches[0].index),
    notes: matches.map((match, i) => ({ title: match[1], text: content.slice(match.index + match[0].length, matches[i + 1]?.index ?? content.length) })).filter(note => note.text.trim())
  };
}
function displayRoleBody(body) {
  // Older saved replies may place a leading stage direction beside the speech.
  // Restore the original two-paragraph presentation without rewriting history.
  return body.replace(/^([（(][^\r\n（）()]{1,80}[）)])[\t ]*(?=[^\s])/u, '$1\n\n');
}
function messageNode(message, greeting = false) {
  const scene = sceneMeta(state.session?.sceneId || $('scene-select').value);
  const role = message.role === 'user' ? '你' : (state.session?.characterName || scene?.characterName || '人物');
  const content = String(message.content || '');
  const formatted = message.role === 'assistant' ? splitReplyNotes(content) : { body: content, notes: [] };
  const citations = message.citations || [];
  const body = message.role === 'assistant' ? displayRoleBody(formatted.body) : formatted.body;
  const root = node('div', { class: `message ${message.role || 'assistant'}`, ...(message.id ? { 'data-message-id': message.id } : {}) }, [node('div', { class: 'message-role', text: `${role}${greeting ? ' · 场景开场（演绎）' : ''}` }), node('div', { class: 'message-content', text: displayReferenceMarkers(body, citations) })]);
  for (const note of formatted.notes) root.append(node('details', { class: `supplement ${note.title === '创作说明' ? 'message-creation-note' : 'message-reference-note'}` }, [node('summary', { text: note.title }), node('div', { class: 'supplement-body', text: displayReferenceMarkers(note.text, citations) })]));
  if (message.role === 'assistant' && (message.citations || []).length) {
    const refs = node('div', { class: 'message-citations' });
    const mockReply = runtimeMode() === 'mock' || /^\s*【[^】\n]*模拟演示[^】\n]*】/u.test(content);
    for (const [index, id] of message.citations.entries()) {
      const source = (state.chapterData?.sources || []).find(s => s.id === id);
      refs.append(node('button', { type: 'button', class: 'citation-chip', text: source ? `${mockReply ? '' : `资料${index + 1} · `}${source.title} · ${source.location || '资料'}` : `资料 ${index + 1}`, on: { click: () => showSources(id) } }));
    }
    const dramatization = state.session?.mode === 'hypothetical' || formatted.notes.some(note => note.title === '创作说明') || /【(?:角色创作|假设(?:讨论|剧情))/.test(content);
    const referenceType = mockReply ? '本轮检索资料' : '本轮引用资料';
    root.append(node('div', { class: 'message-source-info' }, [node('p', { class: 'message-notice', text: dramatization ? `${referenceType} · 历史参考，不作为假设剧情的事实证明` : referenceType }), refs]));
  }
  if (message.role === 'assistant' && message.id && state.session) {
    const feedback = node('div', { class: 'message-feedback' });
    for (const [value, label] of [['helpful', '有帮助'], ['needs_review', '需要核对']]) feedback.append(node('button', { type: 'button', text: label, on: { click: () => { track('feedback', { chapterId: state.chapter.id, sessionId: state.session.id, value: `${message.id}:${value}` }); toast('反馈已提交，感谢帮助核对这段演绎。'); } } }));
    root.append(feedback);
  }
  return root;
}
function renderConditions() {
  const session = state.session; if (!session) return;
  const conditions = session.conditions || []; $('condition-count').textContent = `${conditions.length} 项`;
  const root = clear($('condition-list'));
  if (!conditions.length) root.append(node('p', { class: 'setting-help', text: '尚未采用偏离史实的条件。普通假设讨论不会自动写入。' }));
  for (const c of conditions) root.append(node('div', { class: 'condition-item' }, [node('span', { text: c.text }), node('small', { text: `已采用 · ${dateLabel(c.createdAt)}` })]));
  const known = clear($('knowledge-list'));
  const entries = (session.knowledge || []).filter(k => !k.characterId || k.characterId === session.characterId);
  if (entries.length) {
    known.append(node('strong', { text: '当前人物收到的信息' }));
    for (const k of entries.slice(-5)) known.append(node('div', { class: 'knowledge-item', text: `${k.text} · ${k.channel || '告知'} / ${k.certainty || '待确认'}` }));
  }
  const events = session.events || [];
  if (events.length) known.append(node('p', { text: `本分支已记录 ${events.length} 个事件。事件发生与当前人物知情分别管理。` }));
}
function persistDraft() {
  if (!state.chapter) return;
  store.set(state.session ? `draft:${state.session.id}` : `draft:chapter:${state.chapter.id}`, $('chat-input').value);
  if (!state.session && (state.previewSceneId || $('scene-select').value)) store.set(`draft:scene:${state.previewSceneId || $('scene-select').value}`, $('chat-input').value);
  updateInputCount();
  if (state.pending && $('chat-input').value !== state.pending.text) $('retry-message').hidden = true;
  else if (state.pending && !state.generating) $('retry-message').hidden = false;
}
function updateInputCount() { $('input-count').textContent = `${$('chat-input').value.length} / ${inputLimit()}`; }
async function startSession(continued = false, { preserveDraft = true } = {}) {
  if (interfaceBusy() || !state.chapter) return null;
  const sceneId = $('scene-select').value;
  if (!sceneId) { toast('当前章节没有已开放的人物场景。'); return null; }
  const draft = $('chat-input').value;
  const draftBelongsToTarget = !state.session || state.session.sceneId === sceneId;
  persistDraft();
  const body = { chapterId: state.chapter.id, sceneId };
  if (continued) {
    body.sourceSessionId = $('source-session').value;
    if (!body.sourceSessionId) { toast('请先选择来源会话。'); return null; }
    if ($('source-snapshot').value) body.sourceSnapshotId = $('source-snapshot').value;
  }
  chatError(null); state.startingSession = true; updateSceneControls();
  const chapterId = state.chapter.id;
  try {
    const session = await api('/api/sessions', { method: 'POST', body });
    updateSessionIndex(session);
    if (state.chapter?.id !== chapterId) return null;
    applySession(session);
    setModelPhase('unverified');
    if (preserveDraft && draftBelongsToTarget && draft) { $('chat-input').value = draft; persistDraft(); }
    $('continue-details').open = false;
    toast(continued ? '已从来源快照创建独立子分支。' : '已从本章史实开始，旧演绎仍然保存。');
    return session;
  } catch (error) { chatError(error); return null; }
  finally { state.startingSession = false; updateSceneControls(); }
}
async function switchCharacter() {
  if (interfaceBusy()) return;
  const sceneId = $('scene-select').value;
  if (!state.session || sceneId === state.session.sceneId) { openCharacterPicker(); return; }
  await selectCharacter(sceneId);
}
async function adoptCondition(event) {
  event.preventDefault(); if (interfaceBusy()) return;
  const text = $('condition-text').value.trim();
  if (!text) { toast('请写下要明确采用的剧情条件。'); return; }
  if (!state.session && !await startSession(false)) return;
  state.adoptingCondition = true; updateSceneControls(); chatError(null);
  try {
    const type = $('condition-type').value;
    const character = currentCharacterScene();
    const session = await api(`/api/sessions/${encodeURIComponent(state.session.id)}/conditions`, { method: 'POST', body: { text, type, ...(['character_dead', 'character_status'].includes(type) ? { characterId: character.characterId } : {}), ...(type === 'character_status' ? { status: $('condition-status').value } : {}), knownToCurrent: $('condition-known').checked, operationId: crypto.randomUUID() } });
    applySession(session, { resetDraft: false, scrollBottom: false });
    $('condition-type').value = 'custom'; updateConditionPreset(); $('condition-known').checked = false; $('plot-settings').open = true;
    toast(type === 'character_status' ? `身体状态已保存。${character.characterName}能直接感知，其他人物仍按获知情况处理。` : '条件已明确保存为假设剧情。人物是否知情仍按获知情况处理。');
  } catch (error) { chatError(error); }
  finally { state.adoptingCondition = false; updateSceneControls(); }
}

function setBusy(busy) {
  state.generating = busy;
  // Keep Send in place while disabled so a second click cannot hit Stop.
  $('stop-message').hidden = !busy; $('send-message').hidden = false; $('retry-message').hidden = busy || !state.pending;
  updateSceneControls();
}
async function consumeSSE(response, onEvent) {
  if (!response.body) throw new Error('浏览器未提供流式响应，请重试。');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let complete = false;
  const dispatch = block => {
    let event = 'message'; const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    let value; try { value = JSON.parse(data.join('\n')); } catch { throw new Error('服务器返回了无法解析的流式消息，请重试。'); }
    if (event === 'done') complete = true;
    onEvent(event, value);
  };
  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value || new Uint8Array(), { stream: !result.done }).replace(/\r\n/g, '\n');
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) { const block = buffer.slice(0, index); buffer = buffer.slice(index + 2); dispatch(block); }
      if (result.done) { if (buffer.trim()) dispatch(buffer); break; }
    }
  } finally { if (!complete) { try { await reader.cancel(); } catch {} } reader.releaseLock(); }
  if (!complete) throw new Error('连接在完整回复前中断。输入已保留，可以重试同一条消息。');
}
async function sendMessage(retry = false) {
  if (interfaceBusy() || state.preparingMessage) return;
  const text = (retry && state.pending ? state.pending.text : $('chat-input').value).trim();
  if (!text) { $('chat-input').focus(); return; }
  if (text.length > inputLimit()) { chatError(new Error(`消息最多 ${inputLimit()} 字，请缩短后发送。`)); return; }
  state.preparingMessage = true;
  try { if (!state.session && !await startSession(false)) return; }
  finally { state.preparingMessage = false; }
  if (state.session.sceneId !== $('scene-select').value) { chatError(new Error('你选择了另一个场景，请先点击“选择人物”，或从本章史实开始。')); return; }
  const sessionId = state.session.id;
  const requestId = state.pending?.sessionId === sessionId && state.pending.text === text ? state.pending.id : crypto.randomUUID();
  state.pending = { id: requestId, text, sessionId }; store.set(`pending:${sessionId}`, state.pending);
  $('chat-input').value = text; persistDraft(); chatError(null); renderMessages(); setBusy(true);
  const pendingUser = messageNode({ role: 'user', content: text }); pendingUser.classList.add('pending');
  const pendingAssistant = messageNode({ role: 'assistant', content: '正在思考眼前的局势……' }); pendingAssistant.classList.add('pending');
  $('messages').append(pendingUser, pendingAssistant); $('messages').scrollTop = $('messages').scrollHeight;
  const content = pendingAssistant.querySelector('.message-content'); let accumulated = ''; let completed = false; let replayed = false; let evidenceOnly = false;
  const controller = new AbortController(); state.controller = controller;
  setModelPhase('generating');
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.boot.csrfToken, Accept: 'text/event-stream' }, body: JSON.stringify({ text, requestId }), signal: controller.signal });
    if (!response.ok) {
      let data; try { data = await response.json(); } catch { data = {}; }
      const details = data.error || {}; const error = new Error(details.message || `消息未发送成功（${response.status}）`); Object.assign(error, { code: details.code, details: details.details }); throw error;
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const result = await response.json();
      if (result.session) { applySession(result.session, { resetDraft: false }); completed = true; }
      else throw new Error('服务器未返回完整会话，输入已保留。');
    } else await consumeSSE(response, (event, value) => {
      if (state.session?.id !== sessionId) return;
      if (event === 'meta') { replayed = value.replayed === true; evidenceOnly = value.responseKind === 'evidence-gap'; setModelPhase(value.phase === 'reference-check' ? 'checking' : 'generating', value.mode); }
      if (event === 'reset') { accumulated = ''; content.textContent = ''; setModelPhase('checking'); }
      if (event === 'delta') { accumulated += value.text || ''; content.textContent = displayStreamingText(accumulated); $('messages').scrollTop = $('messages').scrollHeight; }
      if (event === 'done') {
        if (!value.session) throw new Error('完整回复缺少会话状态，请重试。');
        applySession(value.session, { resetDraft: false }); completed = true;
      }
      if (event === 'error') { const error = new Error(value.message || '生成未完成，请重试。'); Object.assign(error, { code: value.code, retryable: value.retryable }); throw error; }
    });
    if (completed) {
      setModelPhase(replayed ? 'restored' : evidenceOnly ? 'evidence' : 'complete');
      store.remove(`pending:${sessionId}`); store.remove(`draft:${sessionId}`); store.remove(`draft:chapter:${state.chapter.id}`); state.pending = null; $('chat-input').value = ''; updateInputCount();
      saveProgressNow();
    }
  } catch (error) {
    if (!completed) controller.abort();
    if (state.session?.id === sessionId && !completed) {
      setModelPhase(error.name === 'AbortError' ? 'cancelled' : 'failed');
      if (error.name === 'AbortError') { pendingAssistant.classList.add('incomplete'); content.textContent = accumulated ? displayStreamingText(accumulated) : '生成已停止。'; }
      else { pendingAssistant.classList.add('incomplete'); content.textContent = accumulated ? displayStreamingText(accumulated) : '本次未能获得完整回复。'; }
      pendingAssistant.append(node('p', { class: 'message-notice', text: '未完成回复 · 不作为已发生剧情保存。原输入已保留，可重试。' }));
      $('chat-input').value = text; persistDraft(); chatError(error);
    }
  } finally {
    if (state.controller === controller) { state.controller = null; setBusy(false); }
    if (state.session?.id === sessionId) $('chat-input').focus();
  }
}

$('bootstrap-retry').addEventListener('click', bootstrap);
window.addEventListener('hashchange', route);
$('reading-pane').addEventListener('scroll', scheduleProgress, { passive: true });
$('reading-pane').addEventListener('toggle', event => { if (event.target.matches('details')) scheduleProgress(); }, true);
$('read-tab').addEventListener('click', () => setMobileView('read'));
$('chat-tab').addEventListener('click', () => setMobileView('chat'));
matchMedia('(max-width: 760px)').addEventListener('change', () => setMobileView($('reading-layout').dataset.view || 'read', false));
$('show-sources').addEventListener('click', () => showSources());
$('chat-settings-toggle').addEventListener('click', () => setChatSettingsOpen($('chat-settings-toggle').getAttribute('aria-expanded') !== 'true'));
$('start-fresh').addEventListener('click', () => startSession(false));
$('start-continue').addEventListener('click', () => startSession(true));
$('return-source').addEventListener('click', () => {
  const session = sessionsList().find(s => s.id === $('source-session').value);
  if (!session || interfaceBusy()) return;
  persistDraft(); saveProgressNow();
  location.hash = `#/chapter/${encodeURIComponent(session.chapterId)}?session=${encodeURIComponent(session.id)}`;
});
$('source-session').addEventListener('change', () => loadSourceSnapshots().catch(chatError));
$('switch-character').addEventListener('click', switchCharacter);
$('scene-select').addEventListener('change', () => { if (!state.session) renderEmptyChat(); updateSceneControls(); });
$('close-character-picker').addEventListener('click', () => $('character-picker').close());
$('character-picker').addEventListener('click', event => {
  if (event.target !== $('character-picker')) return;
  const bounds = $('character-picker').getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $('character-picker').close();
});
$('character-picker').addEventListener('close', () => {
  const origin = state.characterPickerOrigin; state.characterPickerOrigin = null;
  if (origin?.isConnected && !origin.disabled) origin.focus();
});
$('condition-form').addEventListener('submit', adoptCondition);
function updateConditionPreset() {
  const type = $('condition-type').value;
  const name = currentCharacterScene()?.characterName || '当前人物';
  const bodilyStatus = type === 'character_status';
  for (const id of ['condition-status-label', 'condition-status', 'condition-status-help']) $(id).hidden = !bodilyStatus;
  if (bodilyStatus) $('condition-text').value = $('condition-status').value === 'normal' ? `本条演绎设定为${name}已经获救并恢复身体状态。` : $('condition-status').value === 'injured' ? `本条演绎设定为${name}已经受伤，但仍清醒并能交谈。` : `本条演绎设定为${name}身受重伤、处于濒死状态，但尚未死亡。`;
  else if (type === 'character_dead') $('condition-text').value = `本条演绎设定为${name}已经死亡。`;
  else if (type === 'not_unified') $('condition-text').value = '本条演绎设定为天下尚未完成统一。';
  else $('condition-text').value = '';
}
$('condition-type').addEventListener('change', updateConditionPreset);
$('condition-status').addEventListener('change', updateConditionPreset);
$('chat-form').addEventListener('submit', event => { event.preventDefault(); sendMessage(false); });
$('chat-input').addEventListener('input', persistDraft);
$('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state.generating) sendMessage(false); } });
$('retry-message').addEventListener('click', () => sendMessage(true));
$('stop-message').addEventListener('click', () => state.controller?.abort());
window.addEventListener('pagehide', () => { persistDraft(); if (state.generating) state.controller?.abort(); });
setupReadingSplit();
bootstrap();
