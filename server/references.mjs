/** IDs establish traceability only. Whether an excerpt supports a claim needs review. */
export function replyCitations(content, sources = [], mode = 'openai-compatible', policy) {
  const allowed = new Set(sources.map(source => source.id));
  // The demo's old deterministic replies show retrieved references, not model citations.
  if (mode === 'mock') return [...allowed];
  const cited = [];
  for (const match of String(content).matchAll(/\[资料\s*[:：]\s*([^\]\r\n]*)\]/gu)) {
    const id = match[1].trim();
    if (!allowed.has(id)) {
      const error = new Error('回复引用了本轮未提供的资料，本次未保存；输入已保留，可以重试。');
      error.code = 'MODEL_INVALID_CITATION';
      error.retryable = true;
      throw error;
    }
    if (policy === 'source-quotes-v1') {
      const before = String(content).slice(0, match.index);
      const notesStart = before.lastIndexOf('资料说明：');
      const line = before.slice(before.lastIndexOf('\n') + 1);
      const quote = line.match(/(?:“([^”\r\n]+)”|「([^」\r\n]+)」|"([^"\r\n]+)")\s*$/u);
      const excerpt = sources.find(source => source.id === id)?.excerpt || '';
      const canonical = value => String(value).normalize('NFKC').replace(/\s+/gu, '');
      const quoted = canonical(quote?.slice(1).find(Boolean) || '');
      if (notesStart < 0 || !quote || quoted.length < 6 || !canonical(excerpt).includes(quoted)) {
        const error = new Error('引用摘录与本轮资料不一致，本次未保存；输入已保留，可以重试。');
        error.code = 'MODEL_CITATION_UNSUPPORTED';
        error.retryable = true;
        throw error;
      }
    }
    if (!cited.includes(id)) cited.push(id);
  }
  return cited;
}
