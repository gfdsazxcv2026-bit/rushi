import { readFileSync } from 'node:fs';

// This registry belongs to the shared content configuration. Test API fixtures
// can supply a smaller catalog without changing the registered identities.
const catalog = JSON.parse(readFileSync(new URL('../content/catalog.json', import.meta.url), 'utf8'));
const legacy = new Map();
for (const scene of catalog.scenes || []) {
  if (!scene.characterId) continue;
  const item = legacy.get(scene.characterId) || { id: scene.characterId, name: scene.characterName || scene.characterId, aliases: [] };
  item.aliases.push(scene.characterName, scene.identity);
  legacy.set(scene.characterId, item);
}
const supplied = Array.isArray(catalog.characters) && catalog.characters.length ? catalog.characters : [...legacy.values()];
const ids = new Set();
export const characterEntries = Object.freeze(supplied.map(entry => {
  if (!entry || !/^[a-z][a-z0-9_-]{0,63}$/u.test(entry.id) || ids.has(entry.id) || typeof entry.name !== 'string' || !entry.name.trim()) throw new TypeError('人物登记配置含无效或重复的ID/姓名。');
  ids.add(entry.id);
  return Object.freeze({ ...entry, name: entry.name.trim(), aliases: Object.freeze([...new Set([entry.name, ...(entry.aliases || [])].filter(alias => typeof alias === 'string' && alias.trim()).map(alias => alias.trim()))]) });
}));
export const characterIds = Object.freeze(characterEntries.map(entry => entry.id));
const byId = new Map(characterEntries.map(entry => [entry.id, entry]));
export const aliases = new Map();
for (const entry of characterEntries) for (const alias of entry.aliases) {
  if (aliases.has(alias) && aliases.get(alias) !== entry.id) throw new TypeError('人物登记配置存在指向不同人物的重复别名。');
  aliases.set(alias, entry.id);
}
export const characterAliases = aliases;
export const characterMeta = id => byId.get(id);
export const characterName = id => characterMeta(id)?.name || String(id);
export const selfAddress = id => characterMeta(id)?.selfAddress || '我';
export const characterAvatar = id => characterMeta(id)?.avatar || characterName(id).slice(-1);
export const characterIdForAlias = alias => aliases.get(alias);
