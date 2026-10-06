/**
 * 数据持久化：文档 + 段落 + 全部问答历史
 * 存储于 data/store.json（原子写入 + 防抖），原始上传文件存于 data/uploads/
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, UPLOAD_DIR } from './config.js';

const STORE_FILE = path.join(DATA_DIR, 'store.json');
const MAX_DOCS = 200;

/**
 * 修复文件名乱码：multipart 上传时 busboy 默认按 latin1 解码文件名，
 * 中文文件名会变成 "ä¸æ–‡" 这种形式。这里做一次还原。
 */
export function fixFilename(name) {
  const s = String(name || '');
  if (!s || !/[\u0080-\u00ff]/.test(s)) return s; // 纯 ASCII，无需处理
  try {
    const utf8 = Buffer.from(s, 'latin1').toString('utf8');
    return utf8.includes('\uFFFD') ? s : utf8;
  } catch {
    return s;
  }
}

/** 看起来像被 latin1 误解码的中文 */
const looksMojibake = (s) => /[\u00c0-\u00ff]{2,}/.test(String(s || ''));

/** 载入时顺手修复历史数据里的乱码文件名/标题 */
function migrate(data) {
  let fixed = 0;
  for (const doc of Object.values(data.documents || {})) {
    const nf = fixFilename(doc.filename);
    if (nf !== doc.filename) {
      doc.filename = nf;
      fixed += 1;
    }
    if (looksMojibake(doc.title)) {
      const nt = fixFilename(doc.title);
      if (!looksMojibake(nt)) {
        doc.title = nt;
        fixed += 1;
      }
    }
    // 含公式的正文块补上 rich 标记
    for (const p of doc.paragraphs || []) {
      const hasMath = /\$[^$\n]{1,300}\$|\\\([\s\S]{1,300}?\\\)|\$\$[\s\S]{1,600}?\$\$/.test(p.text || '');
      if (hasMath && !p.rich) {
        p.rich = true;
        fixed += 1;
      }
    }
  }
  if (fixed) {
    console.log(`[store] 已修复 ${fixed} 处历史数据（文件名乱码 / 公式标记）`);
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(data), 'utf8');
    } catch (err) {
      console.warn('[store] 迁移结果写回失败：', err.message);
    }
  }
  return data;
}

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.documents) return migrate(parsed);
    }
  } catch (err) {
    console.warn('[store] 读取失败，重建存储：', err.message);
  }
  return { version: 1, documents: {} };
}

let state = load();
let writeTimer = null;

function persistNow() {
  try {
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
  } catch (err) {
    console.error('[store] 写入失败：', err.message);
  }
}

function persist() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    persistNow();
  }, 250);
}

export function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  persistNow();
}

export function newId(prefix = 'doc') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

/* ------------------------------ 文档 ------------------------------ */

export function createDocument({ id, title, filename, format, size, meta, paragraphs, assets, pageImages, filePath }) {
  const docId = id || newId('doc');
  const now = new Date().toISOString();
  const doc = {
    id: docId,
    title: title || filename || '未命名文档',
    filename: filename || '',
    format: format || 'text',
    size: size || 0,
    filePath: filePath || null,
    createdAt: now,
    updatedAt: now,
    meta: meta || {},
    paragraphs: paragraphs || [],
    assets: assets || [],
    pageImages: pageImages || [],
    threads: {},
  };
  state.documents[docId] = doc;

  // 超过上限时清理最旧的文档（含其上传文件）
  const ids = Object.keys(state.documents);
  if (ids.length > MAX_DOCS) {
    ids
      .map((k) => ({ k, t: state.documents[k].updatedAt || state.documents[k].createdAt || '' }))
      .sort((a, b) => (a.t < b.t ? -1 : 1))
      .slice(0, ids.length - MAX_DOCS)
      .forEach(({ k }) => deleteDocument(k));
  }
  persist();
  return doc;
}

export function getDocument(id) {
  return state.documents[id] || null;
}

export function listDocuments() {
  return Object.values(state.documents)
    .map((d) => ({
      id: d.id,
      title: d.title,
      filename: d.filename,
      format: d.format,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      paragraphCount: d.paragraphs?.length || 0,
      questionCount: countQuestions(d),
      aiParsed: Boolean(d.aiParse?.enabled),
      aiParseTokens: d.aiParse?.usage?.totalTokens || 0,
      answeredParagraphs: Object.values(d.threads || {}).filter((t) =>
        t.messages?.some((m) => m.role === 'user'),
      ).length,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function countQuestions(doc) {
  let n = 0;
  for (const t of Object.values(doc.threads || {})) {
    n += (t.messages || []).filter((m) => m.role === 'user').length;
  }
  return n;
}

export function updateDocumentTitle(id, title) {
  const doc = state.documents[id];
  if (!doc) return null;
  doc.title = String(title || '').slice(0, 200) || doc.title;
  doc.updatedAt = new Date().toISOString();
  persist();
  return doc;
}

/**
 * 修正单个块的内容（解析出来的公式/表格常需人工订正）
 * 首次修正时自动留存原始内容，方便一键还原。
 */
export function updateParagraph(id, pid, patch = {}) {
  const doc = state.documents[id];
  if (!doc) return null;
  const block = (doc.paragraphs || []).find((p) => p.id === pid);
  if (!block) return null;

  if (!doc.paragraphOriginals) doc.paragraphOriginals = {};
  if (!doc.paragraphOriginals[pid]) {
    doc.paragraphOriginals[pid] = { text: block.text, tex: block.tex, type: block.type };
  }

  if (typeof patch.text === 'string') {
    const text = patch.text.trim();
    if (!text) return null;
    block.text = text;
    // 含公式的文本必须标记 rich，否则前端会把 $...$ 原样显示
    block.rich = /\$[^$\n]{1,300}\$|\\\([\s\S]{1,300}?\\\)|\$\$[\s\S]{1,600}?\$\$/.test(text);
    block.edited = true;
  }
  if (typeof patch.tex === 'string') {
    const tex = patch.tex.trim();
    if (tex) block.tex = tex;
    block.edited = true;
  }
  if (patch.type && ['paragraph', 'heading', 'list', 'formula'].includes(patch.type)) {
    block.type = patch.type;
    if (patch.type === 'formula') block.display = true;
    block.edited = true;
  }
  block.editedAt = new Date().toISOString();
  doc.updatedAt = block.editedAt;
  persist();
  return block;
}

/** 还原某个块到解析时的原始内容 */
export function resetParagraph(id, pid) {  const doc = state.documents[id];
  if (!doc) return null;
  const idx = (doc.paragraphs || []).findIndex((p) => p.id === pid);
  if (idx < 0) return null;
  const original = doc.paragraphOriginals?.[pid];
  if (!original) return null;
  doc.paragraphs[idx] = {
    ...doc.paragraphs[idx],
    ...original,
    edited: false,
    editedAt: undefined,
  };
  delete doc.paragraphOriginals[pid];
  doc.updatedAt = new Date().toISOString();
  persist();
  return doc.paragraphs[idx];
}

export function deleteDocument(id) {
  const doc = state.documents[id];
  if (!doc) return false;
  if (doc.filePath && fs.existsSync(doc.filePath)) {
    try {
      fs.unlinkSync(doc.filePath);
    } catch {
      /* ignore */
    }
  }
  // 解析出的图片资源目录
  const assetDir = path.join(UPLOAD_DIR, id);
  if (fs.existsSync(assetDir)) {
    try {
      fs.rmSync(assetDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete state.documents[id];
  persist();
  return true;
}

/** 资源目录（每个文档一个） */
export function assetDirFor(id) {
  return path.join(UPLOAD_DIR, id);
}

/* ------------------------------ 问答 ------------------------------ */

export function getThread(docId, paragraphId) {
  const doc = state.documents[docId];
  if (!doc) return null;
  return doc.threads?.[paragraphId] || { paragraphId, messages: [] };
}

export function appendMessage(docId, paragraphId, message) {
  const doc = state.documents[docId];
  if (!doc) return null;
  if (!doc.threads) doc.threads = {};
  const thread = doc.threads[paragraphId] || { paragraphId, messages: [], createdAt: new Date().toISOString() };
  const entry = {
    id: newId('msg'),
    role: message.role,
    content: message.content,
    createdAt: new Date().toISOString(),
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    ...(message.citedParagraphIds ? { citedParagraphIds: message.citedParagraphIds } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
    ...(message.error ? { error: message.error } : {}),
    ...(message.includedParagraphIds ? { includedParagraphIds:message.includedParagraphIds } : {}),
    ...(message.contextMode ? { contextMode:message.contextMode } : {}),
    ...(message.truncated ? { truncated:true } : {}),
    ...(message.outputTruncated ? { outputTruncated:true } : {}),
    ...(message.imageProvided ? { imageProvided:true } : {}),
    ...(message.interrupted ? { interrupted:true } : {}),
  };
  thread.messages.push(entry);
  doc.threads[paragraphId] = thread;
  doc.updatedAt = entry.createdAt;
  persist();
  return entry;
}

export function clearThread(docId, paragraphId) {
  const doc = state.documents[docId];
  if (!doc?.threads?.[paragraphId]) return false;
  delete doc.threads[paragraphId];
  doc.updatedAt = new Date().toISOString();
  persist();
  return true;
}

export function saveUpload(docId, filename, buffer) {
  const ext = path.extname(filename || '').toLowerCase() || '.bin';
  const safe = `${docId}${ext}`;
  const full = path.join(UPLOAD_DIR, safe);
  fs.writeFileSync(full, buffer);
  return full;
}

export function getStorePath() {
  return STORE_FILE;
}

/* ---------------------- AI 精修解析 ---------------------- */

/** 首次 AI 精修前，留一份本地解析结果的备份，便于还原 */
export function ensureLocalBackup(id) {
  const doc = state.documents[id];
  if (!doc) return null;
  if (!doc.localParsedBackup) {
    doc.localParsedBackup = JSON.parse(JSON.stringify(doc.paragraphs || []));
  }
  return doc;
}

/**
 * 写回 AI 精修结果并记录消耗（结果持久化，之后打开不会再花 token）
 * @param {string} id
 * @param {{ patches: Map<number, object>, usage: object, model: string, chunks: number, errors: string[], startedAt: string }} payload
 */
export function applyAiRefine(id, payload) {
  const doc = state.documents[id];
  if (!doc) return null;
  const { patches, usage, model, chunks, errors, startedAt } = payload;

  for (const block of doc.paragraphs || []) {
    const patch = patches?.get?.(block.index) ?? patches?.[block.index];
    if (!patch) continue;
    Object.assign(block, patch);
    block.aiRefined = true;
  }

  doc.aiParse = {
    enabled: true,
    at: new Date().toISOString(),
    startedAt: startedAt || null,
    model: model || null,
    chunks: chunks || 0,
    blocksRefined: patches?.size ?? Object.keys(patches || {}).length,
    usage: {
      promptTokens: usage?.promptTokens || 0,
      completionTokens: usage?.completionTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      calls: usage?.calls || 0,
    },
    errors: errors || [],
  };
  doc.updatedAt = doc.aiParse.at;
  persist();
  return doc.aiParse;
}

/** 还原为本地解析结果（丢弃 AI 精修内容，但保留消耗记录以便追溯） */
export function restoreLocalParsed(id) {
  const doc = state.documents[id];
  if (!doc || !doc.localParsedBackup) return null;
  const logs = doc.aiParseLog || [];
  if (doc.aiParse) logs.push(doc.aiParse);
  doc.aiParseLog = logs.slice(-5);
  doc.paragraphs = JSON.parse(JSON.stringify(doc.localParsedBackup));
  doc.localParsedBackup = null;
  doc.aiParse = null;
  doc.updatedAt = new Date().toISOString();
  persist();
  return doc;
}
