/**
 * PDF 富解析：
 *   - 文本 → 段落（按坐标重建，识别双栏、标题）
 *   - 内嵌位图 → PNG 资源（按绘制位置插回正文流）
 *   - 整页渲染图 → PNG 资源（用于「查看原页」）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeWhitespace, splitLongParagraph, looksLikeHeading } from './segment.js';
import { collectRules } from './pdfmath.js';
import { buildPageLines } from './pdf-layout.js';
import { linesToBlocks } from './pdf-paragraphs.js';

const require = createRequire(import.meta.url);

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const PAGE_RENDER_SCALE = 1.45;
const MAX_PAGE_IMAGES = 80;
const MIN_IMAGE_PX = 56;
const MIN_IMAGE_AREA = 9000;

let pdfjsMod = null;
async function getPdfjs() {
  if (!pdfjsMod) pdfjsMod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsMod;
}
let canvasMod = null;
async function getCanvas() {
  if (!canvasMod) canvasMod = await import('@napi-rs/canvas');
  return canvasMod;
}

/* ------------------------------ 文本行 ------------------------------ */

function median(arr) {
  const a = arr.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* ---------------------------- 内嵌图片 ---------------------------- */

/** 绘制指令常量：直接用 pdfjs 的真实枚举，不要手写子集 */
let OPS = null;
async function getOps() {
  if (!OPS) {
    const pdfjs = await getPdfjs();
    OPS = pdfjs.OPS;
  }
  return OPS;
}

function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** 遍历绘图指令，找出每个被绘制图片的 objId 与版面位置 */
function collectImageOps(opList, OPS) {
  const found = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const fns = opList.fnArray;
  const args = opList.argsArray;

  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i];
    const a = args[i];
    if (fn === OPS.save) {
      stack.push(m.slice());
    } else if (fn === OPS.restore) {
      m = stack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.transform && Array.isArray(a) && a.length >= 6) {
      m = mul(m, a);
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintJpegXObject ||
      fn === OPS.paintImageXObjectRepeat ||
      fn === OPS.paintInlineImageXObject
    ) {
      const objId = typeof a?.[0] === 'string' ? a[0] : null;
      const corners = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
      const ys = corners.map((c) => c[1]);
      const xs = corners.map((c) => c[0]);
      found.push({
        objId,
        inline: fn === OPS.paintInlineImageXObject ? a?.[0] : null,
        x: Math.min(...xs),
        yTop: Math.max(...ys),
        yBottom: Math.min(...ys),
        w: Math.abs(Math.max(...xs) - Math.min(...xs)),
        h: Math.abs(Math.max(...ys) - Math.min(...ys)),
      });
    }
  }
  return found;
}

function getObj(page, objId) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const direct = page.objs.get(objId);
      if (direct !== undefined) return done(direct);
    } catch {
      /* 需要回调 */
    }
    try {
      page.objs.get(objId, done);
    } catch {
      done(null);
    }
    setTimeout(() => done(null), 4000);
  });
}

async function encodePng(obj) {
  try {
    const { createCanvas } = await getCanvas();
    const w = obj.width;
    const h = obj.height;
    const data = obj.data;
    if (!w || !h || !data || !data.length) return null;

    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const px = w * h;

    if (data.length >= px * 4) {
      img.data.set(data.subarray(0, px * 4));
    } else if (data.length >= px * 3) {
      for (let i = 0; i < px; i++) {
        img.data[i * 4] = data[i * 3];
        img.data[i * 4 + 1] = data[i * 3 + 1];
        img.data[i * 4 + 2] = data[i * 3 + 2];
        img.data[i * 4 + 3] = 255;
      }
    } else if (data.length >= px) {
      for (let i = 0; i < px; i++) {
        const v = data[i];
        img.data[i * 4] = v;
        img.data[i * 4 + 1] = v;
        img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
    } else {
      return null;
    }

    ctx.putImageData(img, 0, 0);
    return { buffer: canvas.toBuffer('image/png'), width: w, height: h };
  } catch {
    return null;
  }
}

/* ------------------------------ 主入口 ------------------------------ */

export async function parsePdfRich(buffer, opts) {
  const pdfjs = await getPdfjs();
  const opsEnum = await getOps();
  const assetsDir = opts.assetsDir;
  fs.mkdirSync(assetsDir, { recursive: true });

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
      // 让 pdfjs 把图片解码为 RGBA，便于导出
      isOffscreenCanvasSupported: false,
    }).promise;
  } catch (err) {
    throw new Error(`PDF 打开失败：${err.message}`);
  }

  const blocks = [];
  const images = []; // 已写盘的图片资源
  const pages = []; // 页面渲染图
  const seenObj = new Set();
  let emptyPages = 0;
  let imageCount = 0;
  let renderFailed = false;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const pageHeight = viewport.height;

    // 绘图指令（图片位置 + 分数线）
    let opList = null;
    try {
      opList = await page.getOperatorList();
    } catch {
      /* 忽略 */
    }
    const rules = opList ? collectRules(opList, opsEnum) : [];

    // ---------- 文本 + 公式重构 ----------
    let textBlocks = [];
    try {
      const tc = await page.getTextContent();
      const items = (tc.items || [])
        .filter((it) => it && typeof it.str === 'string' && it.str.trim() !== '')
        .map((it) => {
          const tr = it.transform || [1, 0, 0, 1, 0, 0];
          return {
            str: it.str,
            x: tr[4],
            y: tr[5],
            w: it.width || 0,
            h: Math.abs(tr[3]) || it.height || 10,
            font: (tc.styles?.[it.fontName]?.fontFamily || '') + ' ' + (it.fontName || ''),
          };
        });
      const lines = buildPageLines(items, rules, viewport.width).filter((l) => !(l.y < pageHeight * .07 && /^\s*[-–—]?\s*\d{1,4}\s*[-–—]?\s*$/.test(l.text)));
      if (!lines.length) emptyPages += 1;
      textBlocks = linesToBlocks(lines, p);
      for (const block of textBlocks) if (block.source) block.source = { ...block.source, pageWidth: viewport.width, pageHeight };
    } catch (err) {
      emptyPages += 1;
    }

    // ---------- 内嵌图片 ----------
    const pageImages = [];
    if (opList && imageCount < MAX_PAGE_IMAGES) {
      try {
        const ops = collectImageOps(opList, opsEnum);
        const cache = new Map();
        for (const op of ops) {
          if (imageCount >= MAX_PAGE_IMAGES) break;
          const obj = op.inline || (op.objId ? await getObj(page, op.objId) : null);
          if (!obj || !obj.width || !obj.height) continue;
          if (obj.width < MIN_IMAGE_PX || obj.height < MIN_IMAGE_PX) continue;
          if (obj.width * obj.height < MIN_IMAGE_AREA) continue;

          const key = op.objId || `${obj.width}x${obj.height}:${p}`;
          let asset = cache.get(key);
          if (!asset) {
            const png = await encodePng(obj);
            if (!png) continue;
            const name = `fig-p${p}-${images.length + 1}.png`;
            fs.writeFileSync(path.join(assetsDir, name), png.buffer);
            asset = { name, width: png.width, height: png.height, bytes: png.buffer.length };
            images.push({ ...asset, page: p, mime: 'image/png' });
            cache.set(key, asset);
            imageCount += 1;
          }
          if (seenObj.has(key)) continue;
          seenObj.add(key);
          pageImages.push({
            asset: asset.name,
            width: asset.width,
            height: asset.height,
            // 转成与文本一致的 PDF 用户坐标（y 向上）
            y: pageHeight - op.yBottom,
            w: op.w,
            h: op.h,
          });        }
      } catch {
        /* 该页没有可提取的位图 */
      }
    }

    // ---------- 整页渲染（默认关闭）----------
    // 说明：pdfjs 把解码后的位图画进 @napi-rs/canvas 时会在部分 PDF 上触发
    // 原生访问冲突（进程级崩溃，无法 try/catch）。因此默认不渲染整页影像，
    // 原文页改由浏览器内置 PDF 阅读器内联查看（/api/documents/:id/file?inline=1）。
    // 如需服务端页面影像，可显式设置环境变量 PDF_RENDER_PAGES=1（自行承担崩溃风险）。
    if (process.env.PDF_RENDER_PAGES === '1') {
      try {
        const { createCanvas } = await getCanvas();
        const rv = page.getViewport({ scale: PAGE_RENDER_SCALE });
        const canvas = createCanvas(Math.ceil(rv.width), Math.ceil(rv.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: rv }).promise;
        const png = canvas.toBuffer('image/png');
        const name = `page-${String(p).padStart(3, '0')}.png`;
        fs.writeFileSync(path.join(assetsDir, name), png);
        pages.push({ page: p, asset: name, width: canvas.width, height: canvas.height });
      } catch {
        renderFailed = true;
      }
    }

    // ---------- 按纵向位置合并文本与图片 ----------
    const merged = [
      ...textBlocks,
      ...pageImages.map((im) => ({
        type: 'image',
        text: '［图片］',
        page: p,
        y: im.y,
        images: [{ asset: im.asset, width: im.width, height: im.height }],
      })),
    ];
    const ordered = [...textBlocks];
    for (const image of merged.filter((b) => b.type === "image")) {
      const at = ordered.findIndex((b) => (b.y ?? 0) < image.y);
      ordered.splice(at < 0 ? ordered.length : at, 0, image);
    }
    blocks.push(...ordered);

    page.cleanup?.();
  }

  const totalChars = blocks.reduce((s, b) => s + (b.text?.length || 0), 0);
  const warnings = [];
  if (totalChars < 30) {
    warnings.push('未能从该 PDF 中提取到文字，可能是扫描件/纯图片 PDF。请先 OCR 后上传，或粘贴识别后的文字。');
  } else if (emptyPages > 0) {
    warnings.push(`共 ${doc.numPages} 页，其中 ${emptyPages} 页未提取到文字（可能含图片/扫描页）。`);
  }
  if (renderFailed) warnings.push('部分页面未能生成整页影像。');
  if (images.length) warnings.push(`已提取 ${images.length} 张内嵌图片。`);

  return {
    blocks,
    assets: images,
    pageImages: pages,
    pages: doc.numPages,
    warning: warnings.join(' ') || undefined,
  };
}
