/**
 * DOCX 富解析：直接遍历 OOXML（word/document.xml），完整保留
 *   段落 / 标题 / 列表 / 表格 / 内嵌图片 / 公式（OMML → LaTeX）
 * 相比纯文本转换，能拿到公式与图片在文中的真实位置。
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { ommlToLatex } from './omml.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const V_NS = 'urn:schemas-microsoft-com:vml';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';

const IMAGE_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};
const UNSUPPORTED_IMG = new Set(['emf', 'wmf', 'eps']);

const el = (n) => n && n.nodeType === 1;
const local = (n) => (n.localName || n.nodeName || '').replace(/^.*:/, '');
const kids = (n) => {
  const out = [];
  if (!n || !n.childNodes) return out;
  for (let i = 0; i < n.childNodes.length; i++) if (el(n.childNodes[i])) out.push(n.childNodes[i]);
  return out;
};
const child = (n, name) => kids(n).find((c) => local(c) === name);
const children = (n, name) => kids(n).filter((c) => local(c) === name);
const attr = (n, name) => {
  if (!n || !n.attributes) return null;
  for (let i = 0; i < n.attributes.length; i++) {
    if (local(n.attributes[i]) === name) return n.attributes[i].value;
  }
  return null;
};
const textOf = (n) => {
  let s = '';
  if (!n) return '';
  if (n.nodeType === 3 || n.nodeType === 4) return n.nodeValue || '';
  if (!n.childNodes) return '';
  for (let i = 0; i < n.childNodes.length; i++) s += textOf(n.childNodes[i]);
  return s;
};
const findDeep = (n, name) => {
  if (!n) return null;
  for (const c of kids(n)) {
    if (local(c) === name) return c;
    const r = findDeep(c, name);
    if (r) return r;
  }
  return null;
};
const findAllDeep = (n, name, acc = []) => {
  if (!n) return acc;
  for (const c of kids(n)) {
    if (local(c) === name) acc.push(c);
    findAllDeep(c, name, acc);
  }
  return acc;
};

/* ------------------------------ 关系表 ------------------------------ */

function parseRels(xml) {
  const map = new Map();
  if (!xml) return map;
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const rels = doc.getElementsByTagName('Relationship');
  for (let i = 0; i < rels.length; i++) {
    const r = rels[i];
    const id = r.getAttribute('Id');
    const target = r.getAttribute('Target');
    const mode = r.getAttribute('TargetMode');
    if (id && target) map.set(id, { target, external: mode === 'External' });
  }
  return map;
}

/* ------------------------------ 主入口 ------------------------------ */

/**
 * @param {Buffer} buffer
 * @param {{ docId: string, assetsDir: string }} opts
 */
export async function parseDocxRich(buffer, opts) {
  const zip = await JSZip.loadAsync(buffer);

  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('不是有效的 .docx 文件（缺少 word/document.xml）');

  const docXml = await docFile.async('string');
  const relsXml = (await zip.file('word/_rels/document.xml.rels')?.async('string')) || '';
  const rels = parseRels(relsXml);

  const doc = new DOMParser().parseFromString(docXml, 'text/xml');
  const body = findDeep(doc.documentElement, 'body') || doc.documentElement;

  const assetsDir = opts.assetsDir;
  fs.mkdirSync(assetsDir, { recursive: true });

  const state = {
    zip,
    rels,
    assetsDir,
    pending: [], // 待写盘的图片记录
    counter: 0,
    skippedImages: 0,
    unsupported: new Set(),
  };

  const blocks = [];
  walkBlockContainer(body, blocks, state);

  // JSZip 解压是异步的：遍历结束后统一写盘
  const assets = [];
  for (const rec of state.pending) {
    const f = zip.file(rec.zipPath);
    if (!f) continue;
    const data = await f.async('nodebuffer');
    if (!data || !data.length) continue;
    const target = path.join(assetsDir, rec.name);
    fs.writeFileSync(target, data);
    let { width, height } = rec;
    if (!width || !height) {
      const dim = await probeImageSize(data, rec.mime);
      width = width || dim.width;
      height = height || dim.height;
    }
    assets.push({ name: rec.name, mime: rec.mime, width, height, bytes: data.length });
  }

  return {
    blocks,
    assets,
    skippedImages: state.skippedImages,
    unsupported: [...state.unsupported],
  };
}

/** 读取图片真实像素尺寸（用于前端等比缩放） */
async function probeImageSize(data, mime) {
  if (mime === 'image/svg+xml') return { width: null, height: null };
  try {
    const { loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(data);
    return { width: img.width || null, height: img.height || null };
  } catch {
    return { width: null, height: null };
  }
}

/* --------------------------- 块级遍历 --------------------------- */

function walkBlockContainer(container, blocks, state) {
  for (const node of kids(container)) {
    const name = local(node);
    if (name === 'p') {
      blocks.push(...paragraphBlocks(node, state));
    } else if (name === 'tbl') {
      blocks.push(tableBlock(node, state));
    } else if (name === 'sdt' || name === 'sdtContent') {
      const content = findDeep(node, 'sdtContent') || node;
      walkBlockContainer(content, blocks, state);
    } else if (name === 'customXml' || name === 'smartTag' || name === 'ins' || name === 'del') {
      walkBlockContainer(node, blocks, state);
    }
  }
}

/* ----------------------------- 表格 ----------------------------- */

function tableRows(tbl) {
  const out = [];
  for (const node of kids(tbl)) {
    const name = local(node);
    if (name === 'tr') out.push(node);
    else if (name === 'sdt' || name === 'sdtContent' || name === 'customXml') {
      for (const tr of findAllDeep(node, 'tr')) {
        if (!out.includes(tr)) out.push(tr);
      }
    }
  }
  return out;
}

function paragraphText(p, state) {
  const blocks = paragraphBlocks(p, state);
  return blocks
    .map((b) => b.text)
    .filter(Boolean)
    .join(' ')
    .trim();
}

function tableBlock(tbl, state) {
  const rows = [];
  let headerRow = false;

  for (const tr of tableRows(tbl)) {
    const trPr = child(tr, 'trPr');
    if (trPr && child(trPr, 'tblHeader')) headerRow = true;
    const cells = [];
    for (const tc of children(tr, 'tc')) {
      const tcPr = child(tc, 'tcPr');
      const spanEl = tcPr ? child(tcPr, 'gridSpan') : null;
      const span = spanEl ? Math.max(1, Number(attr(spanEl, 'val')) || 1) : 1;

      const parts = [];
      for (const node of kids(tc)) {
        const name = local(node);
        if (name === 'p') {
          const t = paragraphText(node, state);
          if (t) parts.push(t);
        } else if (name === 'tbl') {
          const nested = tableBlock(node, state);
          parts.push(nested.table.rows.map((r) => r.join(' | ')).join(' ／ '));
        }
      }
      cells.push(parts.join('\n').trim());
      for (let i = 1; i < span; i++) cells.push('');
    }
    if (cells.length) rows.push(cells);
  }

  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  for (const r of rows) while (r.length < cols) r.push('');
  if (!headerRow && rows.length > 1) headerRow = true;

  const body = rows.map((r) => r.map((c) => c.replace(/\n+/g, ' ')).join(' | ')).join('\n');
  return {
    type: 'table',
    text: `［表格 ${rows.length} 行 × ${cols} 列］\n${body}`,
    table: { rows, headerRow, cols },
  };
}

/* ----------------------------- 段落 ----------------------------- */

function paragraphStyle(p) {
  const pPr = child(p, 'pPr');
  if (!pPr) return { heading: 0, list: false, headingText: '' };
  const styleEl = child(pPr, 'pStyle');
  const style = styleEl ? attr(styleEl, 'val') || '' : '';
  const numPr = child(pPr, 'numPr');
  const outline = child(pPr, 'outlineLvl');

  let heading = 0;
  const s = String(style);
  let m =
    /^heading\s*([1-9])$/i.exec(s) ||
    /^标题\s*([1-9])$/.exec(s) ||
    /^([1-9])$/.exec(s) ||
    /^berschrift\s*([1-9])$/i.exec(s);
  if (m) heading = Number(m[1]);
  if (!heading && /^(title|标题|文档标题)$/i.test(s)) heading = 1;

  if (!heading && outline) {
    const lvl = Number(attr(outline, 'val'));
    if (Number.isFinite(lvl) && lvl >= 0 && lvl <= 5) heading = lvl + 1;
  }
  // 段落本身加粗且很短时，作为疑似标题由前端呈现
  return { heading, list: Boolean(numPr), style };
}

function paragraphBlocks(p, state) {
  const { heading, list } = paragraphStyle(p);
  const segs = [];
  const images = [];

  for (const node of kids(p)) {
    const name = local(node);
    if (name === 'pPr' || name === 'rPr' || name === 'bookmarkStart' || name === 'bookmarkEnd') continue;

    if (name === 'oMathPara') {
      const tex = ommlToLatex(node, { display: true });
      if (tex) segs.push({ k: 'tex', v: tex, display: true });
      continue;
    }
    if (name === 'oMath') {
      const tex = ommlToLatex(node, { display: false });
      if (tex) segs.push({ k: 'tex', v: tex, display: false });
      continue;
    }
    if (name === 'r') {
      walkRun(node, segs, images, state);
      continue;
    }
    if (name === 'hyperlink') {
      for (const r of children(node, 'r')) walkRun(r, segs, images, state);
      continue;
    }
    if (name === 'ins' || name === 'smartTag' || name === 'sdt') {
      for (const r of findAllDeep(node, 'r')) walkRun(r, segs, images, state);
      continue;
    }
    if (name === 'tbl') {
      // 段落里嵌套表格：极少见，退化为文字
      const t = tableBlock(node, state);
      const flat = t.table.rows.map((r) => r.join(' | ')).join(' / ');
      if (flat) segs.push({ k: 'text', v: flat });
      continue;
    }
  }

  // 整理文本
  let text = '';
  let hasTex = false;
  for (const s of segs) {
    if (s.k === 'text') text += s.v;
    else if (s.k === 'tex') {
      hasTex = true;
      text += s.display ? `$$${s.v}$$` : `$${s.v}$`;
    }
  }
  text = text.replace(/[ \t]{2,}/g, ' ').trim();

  const out = [];

  // 整段就是一个块级公式
  if (hasTex && segs.length === 1 && segs[0].display && !images.length) {
    out.push({ type: 'formula', text: segs[0].v, tex: segs[0].v, display: true });
    return out;
  }

  for (const img of images) {
    out.push({
      type: 'image',
      text: '［图片］',
      images: [img],
      rich: false,
    });
  }

  if (!text) return out;

  const type = heading ? 'heading' : list ? 'list' : 'paragraph';
  out.push({
    type,
    text: list && !heading ? `• ${text}` : text,
    level: heading || undefined,
    rich: hasTex,
  });
  return out;
}

function walkRun(r, segs, images, state) {
  for (const node of kids(r)) {
    const name = local(node);
    if (name === 'rPr') continue;
    if (name === 't') {
      pushText(segs, textOf(node));
      continue;
    }
    if (name === 'br') {
      pushText(segs, '\n');
      continue;
    }
    if (name === 'tab') {
      pushText(segs, ' ');
      continue;
    }
    if (name === 'drawing') {
      images.push(...extractDrawingImages(node, state));
      continue;
    }
    if (name === 'pict') {
      images.push(...extractVmlImages(node, state));
      continue;
    }
    if (name === 'object') {
      // OLE 对象（例如旧版公式），尝试取 VML 回退图
      images.push(...extractVmlImages(node, state));
      continue;
    }
    if (name === 'oMath' || name === 'oMathPara') {
      const tex = ommlToLatex(node, { display: name === 'oMathPara' });
      if (tex) segs.push({ k: 'tex', v: tex, display: name === 'oMathPara' });
      continue;
    }
    if (name === 'AlternateContent') {
      // mc:AlternateContent：优先 Choice，其次 Fallback
      const choice = findDeep(node, 'Choice') || findDeep(node, 'Fallback') || node;
      for (const d of findAllDeep(choice, 'drawing')) images.push(...extractDrawingImages(d, state));
      for (const v of findAllDeep(choice, 'pict')) images.push(...extractVmlImages(v, state));
      continue;
    }
  }
}

function pushText(segs, v) {
  if (!v) return;
  const last = segs[segs.length - 1];
  if (last && last.k === 'text') last.v += v;
  else segs.push({ k: 'text', v });
}

/* ----------------------------- 图片 ----------------------------- */

function emuToPx(emu) {
  const n = Number(emu);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n / 914400) * 96);
}

function drawingSize(drawing) {
  const extent = findDeep(drawing, 'extent');
  if (extent) {
    const cx = emuToPx(attr(extent, 'cx'));
    const cy = emuToPx(attr(extent, 'cy'));
    if (cx && cy) return { width: cx, height: cy };
  }
  const ext = findDeep(drawing, 'ext');
  if (ext) {
    const cx = emuToPx(attr(ext, 'cx'));
    const cy = emuToPx(attr(ext, 'cy'));
    if (cx && cy) return { width: cx, height: cy };
  }
  return { width: null, height: null };
}

function extractDrawingImages(drawing, state) {
  const out = [];
  const size = drawingSize(drawing);
  for (const blip of findAllDeep(drawing, 'blip')) {
    const rid = attr(blip, 'embed') || attr(blip, 'link');
    if (!rid) continue;
    const saved = saveImageByRid(rid, size, state);
    if (saved) out.push(saved);
  }
  return out;
}

function extractVmlImages(pict, state) {
  const out = [];
  for (const imgData of findAllDeep(pict, 'imagedata')) {
    const rid = attr(imgData, 'id') || attr(imgData, 'relid');
    if (!rid) continue;
    const style = attr(imgData, 'style') || '';
    const w = /width:\s*([\d.]+)pt/.exec(style);
    const h = /height:\s*([\d.]+)pt/.exec(style);
    const size = {
      width: w ? Math.round(Number(w[1]) * (96 / 72)) : null,
      height: h ? Math.round(Number(h[1]) * (96 / 72)) : null,
    };
    const saved = saveImageByRid(rid, size, state);
    if (saved) out.push(saved);
  }
  return out;
}

function saveImageByRid(rid, size, state) {
  const rel = state.rels.get(rid);
  if (!rel || rel.external) return null;
  const target = rel.target.replace(/^\.?\//, '');
  const zipPath = target.startsWith('word/') ? target : `word/${target}`;
  const file = state.zip.file(zipPath) || state.zip.file(target);
  if (!file) return null;

  const ext = (path.extname(zipPath).slice(1) || 'png').toLowerCase();
  if (UNSUPPORTED_IMG.has(ext)) {
    state.unsupported.add(ext);
    state.skippedImages += 1;
    return null;
  }

  const name = `img-${++state.counter}.${ext}`;
  state.pending.push({ name, zipPath, mime: IMAGE_EXT[ext] || 'image/png', width: size.width, height: size.height });
  return { asset: name, width: size.width, height: size.height, mime: IMAGE_EXT[ext] || 'image/png' };
}
