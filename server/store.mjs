import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, getCharacterStatus } from './world.mjs';

const parse = (value, fallback = {}) => value ? JSON.parse(value) : fallback;
const now = () => new Date().toISOString();
function snapshotLabel(snapshot, session, messageIds, characterName) {
  // Use the frozen contents of this conversation, not its latest live state
  // or another character's private messages carried by the same branch.
  const memories = parse(snapshot.memories)[session.character_id] || [];
  const question = memories.findLast(message => message.role === 'user' && messageIds.has(message.id));
  const condition = parse(snapshot.state).conditions?.at(-1);
  const title = question?.content || (condition?.text ? `设定：${condition.text}` : `与${characterName}开始对话`);
  const characters = Array.from(String(title).replace(/\s+/gu, ' ').trim());
  return characters.length > 24 ? characters.slice(0, 24).join('') + '…' : characters.join('');
}
export class Store {
  constructor(directory, catalog) {
    this.catalog = catalog;
    mkdirSync(directory, { recursive: true });
    const secretPath = join(directory, 'session-secret');
    if (!existsSync(secretPath)) writeFileSync(secretPath, randomUUID() + randomUUID(), { mode: 0o600, flag: 'wx' });
    this.secret = readFileSync(secretPath, 'utf8');
    this.db = new DatabaseSync(join(directory, 'rushi.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS visitors(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS branches(id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL, state TEXT NOT NULL, inherited TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, source_session_id TEXT, source_snapshot_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL, branch_id TEXT NOT NULL REFERENCES branches(id), chapter_id TEXT NOT NULL, scene_id TEXT NOT NULL, character_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, citations TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL, branch_id TEXT NOT NULL, session_id TEXT NOT NULL, chapter_id TEXT NOT NULL, scene_id TEXT NOT NULL, year INTEGER NOT NULL, state TEXT NOT NULL, memories TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(session_id TEXT NOT NULL,id TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT,PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS conditions_ops(branch_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(branch_id,id));
      CREATE TABLE IF NOT EXISTS progress(visitor_id TEXT NOT NULL,chapter_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(visitor_id,chapter_id));
      CREATE TABLE IF NOT EXISTS analytics(id INTEGER PRIMARY KEY,visitor_id TEXT NOT NULL,type TEXT NOT NULL,chapter_id TEXT,session_id TEXT,value TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(day TEXT NOT NULL,visitor_id TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,visitor_id));
      CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(visitor_id);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,created_at);
      CREATE INDEX IF NOT EXISTS snapshots_session ON snapshots(session_id,created_at);
    `);
    this.db.prepare("UPDATE operations SET status='failed' WHERE status='pending'").run();
    this.db.prepare("UPDATE messages SET status='failed' WHERE status='pending'").run();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  addVisitor(id) { this.db.prepare('INSERT OR IGNORE INTO visitors VALUES(?,?)').run(id, now()); }
  hasVisitor(id) { return !!this.db.prepare('SELECT id FROM visitors WHERE id=?').get(id); }
  session(id, visitorId) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=? AND visitor_id=?').get(id, visitorId);
    if (!row) fail(404, 'NOT_FOUND', '会话不存在或不属于当前游客。');
    return row;
  }
  branch(id, visitorId) {
    const row = this.db.prepare('SELECT * FROM branches WHERE id=? AND visitor_id=?').get(id, visitorId);
    if (!row) fail(404, 'NOT_FOUND', '剧情分支不存在或不属于当前游客。');
    return { ...row, state: parse(row.state), inherited: parse(row.inherited) };
  }
  messages(sessionId, completeOnly = false) {
    return this.db.prepare(`SELECT * FROM messages WHERE session_id=? ${completeOnly ? "AND status='complete'" : ''} ORDER BY rowid`).all(sessionId).map(row => ({ id: row.id, role: row.role, content: row.content, status: row.status, citations: parse(row.citations, []), createdAt: row.created_at }));
  }
  memories(branchId, visitorId) {
    const branch = this.branch(branchId, visitorId);
    const result = structuredClone(branch.inherited);
    const origin = branch.source_snapshot_id ? this.db.prepare('SELECT year,scene_id,state FROM snapshots WHERE id=? AND visitor_id=?').get(branch.source_snapshot_id, visitorId) : null;
    const originScene = origin && this.catalog?.scenes.find(scene=>scene.id===origin.scene_id);
    const originState = origin ? parse(origin.state) : {};
    for (const [characterId,messages] of Object.entries(result)) result[characterId]=messages.map(message=>({...message,characterId:message.characterId || characterId,...(origin && !Number.isFinite(message.year)?{year:origin.year,sceneId:origin.scene_id}:{}),...(origin && (!Number.isFinite(message.year) || message.year===origin.year) && !message.momentId ? {momentId:originState.momentId || originScene?.momentId,momentOrder:originState.momentOrder ?? originScene?.momentOrder}:{} )}));
    for (const row of this.db.prepare('SELECT id,character_id,scene_id FROM sessions WHERE branch_id=? AND visitor_id=? ORDER BY rowid').all(branchId, visitorId)) {
      const scene = this.catalog?.scenes.find(item=>item.id===row.scene_id);
      result[row.character_id] = [...(result[row.character_id] || []), ...this.messages(row.id, true).map(message=>({...message,characterId:row.character_id,sessionId:row.id,year:branch.state.year,sceneId:row.scene_id,momentId:branch.state.momentId || scene?.momentId,momentOrder:branch.state.momentOrder ?? scene?.momentOrder}))];
    }
    return result;
  }
  snapshot(session) {
    const branch = this.branch(session.branch_id, session.visitor_id);
    const id = randomUUID();
    this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, session.visitor_id, branch.id, session.id, session.chapter_id, session.scene_id, branch.state.year, JSON.stringify(branch.state), JSON.stringify(this.memories(branch.id, session.visitor_id)), now());
    return id;
  }
  getSnapshot(id, session) {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id=? AND visitor_id=? AND branch_id=? AND session_id=?').get(id, session.visitor_id, session.branch_id, session.id);
    if (!row) fail(404, 'NOT_FOUND', '来源快照不存在或不可访问。');
    return { ...row, state: parse(row.state), memories: parse(row.memories) };
  }
  createSession(visitorId, scene, state, options = {}) {
    const stamp = now(), id = randomUUID();
    let branchId = options.branchId;
    if (!branchId) {
      branchId = randomUUID();
      this.db.prepare('INSERT INTO branches VALUES(?,?,?,?,0,?,?,?,?)').run(branchId, visitorId, JSON.stringify(state), JSON.stringify(options.memories || {}), options.sourceSessionId || null, options.sourceSnapshotId || null, stamp, stamp);
    }
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)').run(id, visitorId, branchId, scene.chapterId, scene.id, scene.characterId, stamp, stamp);
    const row = this.session(id, visitorId);
    this.snapshot(row);
    return row;
  }
  updateState(branchId, visitorId, state) {
    this.db.prepare('UPDATE branches SET state=?,version=version+1,updated_at=? WHERE id=? AND visitor_id=?').run(JSON.stringify(state), now(), branchId, visitorId);
    this.db.prepare('UPDATE sessions SET updated_at=? WHERE branch_id=? AND visitor_id=?').run(now(), branchId, visitorId);
  }
  view(session, catalog, includeMessages = true) {
    const branch = this.branch(session.branch_id, session.visitor_id);
    const scene = catalog.scenes.find(item => item.id === session.scene_id);
    const result = { id: session.id, branchId: branch.id, chapterId: session.chapter_id, sceneId: session.scene_id, characterId: session.character_id, characterName: scene?.characterName || session.character_id, identity: scene?.identity, momentId:scene?.momentId, momentOrder:scene?.momentOrder, momentLabel:scene?.momentLabel, mode: branch.state.mode, version: branch.version, sourceSessionId: branch.source_session_id, sourceSnapshotId: branch.source_snapshot_id, createdAt: session.created_at, updatedAt: session.updated_at };
    if (includeMessages) {
      const messages = this.messages(session.id);
      const messageIds = new Set(messages.map(message => message.id));
      Object.assign(result, { characterStatus: getCharacterStatus(branch.state, scene || {characterId:session.character_id}), messages, conditions: branch.state.conditions, events: branch.state.events, knowledge: branch.state.knowledge.filter(k => k.characterId === session.character_id), snapshots: this.db.prepare('SELECT id,chapter_id,scene_id,created_at,state,memories FROM snapshots WHERE session_id=? AND visitor_id=? ORDER BY rowid DESC LIMIT 30').all(session.id, session.visitor_id).map(s => ({ id: s.id, chapterId: s.chapter_id, sceneId: s.scene_id, createdAt: s.created_at, label: snapshotLabel(s, session, messageIds, result.characterName) })) });
    }
    return result;
  }
  sessions(visitorId, catalog) { return this.db.prepare('SELECT * FROM sessions WHERE visitor_id=? ORDER BY updated_at DESC').all(visitorId).map(s => this.view(s, catalog, false)); }
  getProgress(visitorId) { return Object.fromEntries(this.db.prepare('SELECT * FROM progress WHERE visitor_id=?').all(visitorId).map(row => [row.chapter_id, parse(row.value)])); }
  progress(visitorId, chapterId, value) { this.db.prepare('INSERT INTO progress VALUES(?,?,?) ON CONFLICT(visitor_id,chapter_id) DO UPDATE SET value=excluded.value').run(visitorId, chapterId, JSON.stringify(value)); }
  event(visitorId, type, chapterId, sessionId, value) { this.db.prepare('INSERT INTO analytics(visitor_id,type,chapter_id,session_id,value,created_at) VALUES(?,?,?,?,?,?)').run(visitorId, type, chapterId || null, sessionId || null, value == null ? null : String(value).slice(0,1000), now()); }
  usage(visitorId, daily, global) {
    const day = now().slice(0,10);
    const count = this.db.prepare('SELECT count FROM usage WHERE day=? AND visitor_id=?').get(day, visitorId)?.count || 0;
    const total = this.db.prepare('SELECT COALESCE(SUM(count),0) AS total FROM usage WHERE day=?').get(day).total;
    if (count >= daily || total >= global) fail(429, 'DAILY_LIMIT', '今日调用额度已用完，请明日再试或联系站点维护者。');
    this.db.prepare('INSERT INTO usage VALUES(?,?,1) ON CONFLICT(day,visitor_id) DO UPDATE SET count=count+1').run(day, visitorId);
  }
  close() { this.db.close(); }
}
