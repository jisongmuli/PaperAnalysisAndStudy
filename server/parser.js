/**
 * 文档解析入口：DOCX / PDF / TXT / Markdown → 结构化块
 *
 * 块模型：
 *   { id, index, type: 'paragraph'|'heading'|'list'|'table'|'image'|'formula',
 *     text,                 // 纯文本（含 $LaTeX$，用于提问上下文 / 搜索 / 导出）
 *     rich?,                // 含行内公式，左侧需按 Markdown + KaTeX 渲染
 *     level?,               // heading 层级
 *     tex?, display?,       // formula 块
 *     table?: { rows, headerRow, cols },
 *     images?: [{ url, width, height, caption? }],
 *     page?, y? }           // PDF 才有
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { segmentText, normalizeWhitespace, splitLongParagraph, looksLikeHeading } from './segment.js';
import { parseDocxRich } from './docx.js';
import { parsePdfRich } from './pdfrich.js';

export { segmentText, normalizeWhitespace, splitLongParagraph, looksLikeHeading };

const assetUrl = (docId, name) =>
  `/api/documents/${encodeURIComponent(docId)}/assets/${encodeURIComponent(name)}`;

/** 文本里含行内/块级公式 → 需要按 Markdown + KaTeX 渲染 */
const INLINE_MATH_RE = /\$[^$\n]{1,300}\$|\\\([\s\S]{1,300}?\\\)|\$\$[\s\S]{1,600}?\$\$/;
export const hasMath = (text) => INLINE_MATH_RE.test(String(text || ''));

/** 直接调用解析器（非 HTTP 场景）时的兜底资源目录 */
function fallbackAssetsDir() {
  const dir = path.join(os.tmpdir(), `paperinsight-assets-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 统一编号 + 补全资源 URL + 生成用于提问的 text */
function finalize(blocks, meta, docId) {
  const out = [];
  let index = 0;

  const push = (b) => {
    const text = String(b.text ?? '').trim();
    if (b.type !== 'image' && !text) return;
    out.push({
      id: `p${index + 1}`,
      index,
      type: b.type || 'paragraph',
      text: text || '［图片］',
      // 只要含公式就标记为富文本，避免前端把 $...$ 原样显示
      ...(b.rich || hasMath(text) ? { rich: true } : {}),
      ...(b.level ? { level: b.level } : {}),
      ...(b.tex ? { tex: b.tex, display: b.display !== false } : {}),
      ...(b.table ? { table: b.table } : {}),
      ...(b.images ? { images: b.images } : {}),
      ...(b.page ? { page: b.page } : {}),
      ...(b.source ? { source: b.source } : {}),
      ...(b.texUncertain ? { texUncertain: true } : {}),
    });
    index += 1;
  };

  for (const b of blocks) {
    if (b.type === 'image') {
      const imgs = (b.images || []).map((im) => ({
        url: assetUrl(docId, im.asset),
        width: im.width || null,
        height: im.height || null,
      }));
      if (!imgs.length) continue;
      push({ ...b, type: 'image', images: imgs, text: b.text || '［图片］' });
      continue;
    }
    if (b.type === 'table') {
      push({ ...b, text: b.text });
      continue;
    }
    if (b.type === 'formula') {
      push({ ...b, type: 'formula', tex: b.tex || b.text, text: `$$${b.tex || b.text}$$`, display: true });
      continue;
    }
    for (const piece of splitLongParagraph(String(b.text || ''))) {
      push({ ...b, text: piece });
    }
  }

  return { blocks: out, meta: { ...meta, paragraphCount: out.length } };
}

/* ------------------------------ DOCX ------------------------------ */

async function parseDocx(buffer, filename, docId, assetsDir) {
  const rich = await parseDocxRich(buffer, { docId, assetsDir });
  const { blocks, meta } = finalize(rich.blocks, {}, docId);

  const warnings = [];
  if (rich.skippedImages) {
    warnings.push(
      `有 ${rich.skippedImages} 张 ${rich.unsupported.join('/').toUpperCase()} 矢量图无法在网页中显示，已跳过。`,
    );
  }
  if (!blocks.length) throw new Error('未能从该 .docx 中提取到任何内容。');

  return {
    paragraphs: blocks,
    assets: rich.assets,
    meta: {
      filename,
      format: 'docx',
      imageCount: rich.assets.length,
      ...meta,
      warning: warnings.join(' ') || undefined,
    },
  };
}

/* ------------------------------- PDF ------------------------------- */

async function parsePdf(buffer, filename, docId, assetsDir) {
  const rich = await parsePdfRich(buffer, { docId, assetsDir });
  const { blocks, meta } = finalize(rich.blocks, {}, docId);

  return {
    paragraphs: blocks,
    assets: rich.assets,
    pageImages: (rich.pageImages || []).map((p) => ({
      page: p.page,
      url: assetUrl(docId, p.asset),
      width: p.width,
      height: p.height,
    })),
    meta: {
      filename,
      format: 'pdf',
      pages: rich.pages,
      imageCount: (rich.assets || []).length,
      ...meta,
      warning: rich.warning,
      parserVersion: '2.0',
    },
  };
}

/* --------------------------- 纯文本 / 粘贴 --------------------------- */

function parseTextRich(raw, filename, docId) {
  // 走统一的 finalize，保证 rich / 编号 / 公式标记一致
  const { blocks } = finalize(segmentText(raw, { mode: 'txt' }), {}, docId || 'local');
  return {
    paragraphs: blocks,
    assets: [],
    pageImages: [],
    meta: { filename, format: 'text', chars: String(raw).length },
  };
}

/* ------------------------------ 统一入口 ------------------------------ */

/**
 * @param {{ buffer?: Buffer, filename?: string, mimetype?: string,
 *           pastedText?: string, docId?: string, assetsDir?: string }} input
 */
export async function parseDocument(input) {
  const { buffer, filename, mimetype, pastedText } = input;
  const docId = input.docId || 'local';
  const assetsDir = input.assetsDir || fallbackAssetsDir();

  if (pastedText != null && String(pastedText).trim()) {
    const res = parseTextRich(String(pastedText), filename || '粘贴的文本', docId);
    res.meta.format = 'paste';
    return res;
  }
  if (!buffer) throw new Error('没有收到文件内容');

  const ext = path.extname(filename || '').toLowerCase();
  const mime = String(mimetype || '');

  try {
    if (ext === '.docx' || mime.includes('officedocument.wordprocessingml')) {
      return await parseDocx(buffer, filename, docId, assetsDir);
    }
    if (ext === '.pdf' || mime === 'application/pdf') {
      return await parsePdf(buffer, filename, docId, assetsDir);
    }
    if (ext === '.doc') {
      throw new Error('不支持旧版 .doc 格式，请先用 Word 另存为 .docx 后再上传。');
    }
    if (
      ['.txt', '.md', '.markdown', '.text', '.log', '.csv', '.json', '.rtf'].includes(ext) ||
      mime.startsWith('text/')
    ) {
      return parseTextRich(buffer.toString('utf8'), filename, docId);
    }
    const guess = buffer.toString('utf8');
    if (/[\u0000-\u0008\u000e-\u001f]/.test(guess.slice(0, 2000))) {
      throw new Error(`无法识别的文件类型：${ext || mime || '未知'}，请上传 .docx / .pdf / .txt 文件。`);
    }
    return parseTextRich(guess, filename, docId);
  } catch (err) {
    err.statusCode = err.statusCode || 400;
    throw err;
  }
}

export { parseTextRich as parseText, parseDocx, parsePdf };
