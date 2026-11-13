import { DatabaseSync, backup } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=resolve(root,process.env.DATA_DIR || 'data');
if(!existsSync(resolve(dataDir,'rushi.sqlite'))) throw new Error('尚无运行数据，请先启动一次服务。');
const destination=resolve(root,process.env.BACKUP_DIR || 'backups',new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(destination,{recursive:true});
const db=new DatabaseSync(resolve(dataDir,'rushi.sqlite'),{readOnly:true});
try { await backup(db,resolve(destination,'rushi.sqlite')); } finally { db.close(); }
copyFileSync(resolve(dataDir,'session-secret'),resolve(destination,'session-secret'));
writeFileSync(resolve(destination,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),schemaVersion:1,files:['rushi.sqlite','session-secret'],note:'数据库与匹配签名密钥必须成对恢复。备份包含私聊和身份密钥，请妥善保存，不用于公开分发。'},null,2));
console.log(`一致性备份已保存：${destination}`);
