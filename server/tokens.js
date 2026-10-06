/**
 * 粗略 token 估算（用于控制上下文预算）
 * DeepSeek 分词器下：中文约 0.7 token/字，英文约 0.3 token/字符。
 * 只用于预算控制，宁可高估也不要低估。
 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.75 + other * 0.3) + 4;
}

/** 消息数组的 token 估算 */
export function estimateMessagesTokens(messages) {
  let n = 0;
  for (const m of messages || []) n += estimateTokens(m.content) + 6;
  return n + 8;
}

/** 把问题切成检索词：中文二元组 + 英文/数字单词 */
export function tokenizeQuery(question) {
  const q = String(question || '');
  const terms = new Set();
  for (const w of q.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) || []) terms.add(w.toLowerCase());
  for (const n of q.match(/\d+(?:\.\d+)?/g) || []) terms.add(n);
  const cjk = q.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) terms.add(cjk.slice(i, i + 2));
  if (cjk.length === 1) terms.add(cjk);
  return [...terms].filter((t) => t.length > 0);
}

/** 块与问题的相关性打分（命中数 / 长度惩罚） */
export function scoreBlock(text, terms) {
  if (!terms.length) return 0;
  const s = String(text || '').toLowerCase();
  let hits = 0;
  const seen = new Set();
  for (const t of terms) {
    if (s.includes(t) && !seen.has(t)) {
      seen.add(t);
      hits += /[A-Za-z0-9]/.test(t) ? 1.6 : 1;
    }
  }
  if (!hits) return 0;
  return hits / Math.sqrt(Math.max(40, s.length) / 40);
}
