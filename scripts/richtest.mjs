/**
 * 富内容解析自测：DOCX（表格/图片/公式）与 PDF（图片/页面影像）
 * 用法：node scripts/richtest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { parseDocument } = await import('../server/parser.js');
const { ommlToLatex } = await import('../server/omml.js');

let failures = 0;
const ok = (c, label, extra = '') => {
  console.log(`${c ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!c) failures += 1;
};

const tmpFor = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `pi-${name}-`));
const sample = (f) => path.join(root, 'data', 'samples', f);

/* --------------------------- DOCX --------------------------- */
const docxPath = sample('sample.docx');
if (fs.existsSync(docxPath)) {
  console.log('\n[1] DOCX 富解析');
  const dir = tmpFor('docx');
  const res = await parseDocument({
    buffer: fs.readFileSync(docxPath),
    filename: 'sample.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    docId: 'testdoc',
    assetsDir: dir,
  });

  const kinds = res.paragraphs.reduce((m, p) => ((m[p.type] = (m[p.type] || 0) + 1), m), {});
  console.log('     块类型统计：', JSON.stringify(kinds));

  ok(kinds.table >= 1, `解析出表格块（${kinds.table || 0} 个）`);
  ok(kinds.image >= 1, `解析出图片块（${kinds.image || 0} 个）`);
  ok(kinds.formula >= 1, `解析出公式块（${kinds.formula || 0} 个）`);
  ok(kinds.heading >= 4, `识别出 ${kinds.heading || 0} 个标题`);

  const table = res.paragraphs.find((p) => p.type === 'table');
  ok(table?.table?.rows?.length === 5, `表格行数 = ${table?.table?.rows?.length}`);
  ok(table?.table?.rows?.[0]?.length === 4, `表格列数 = ${table?.table?.rows?.[0]?.length}`);
  ok(
    table?.text?.includes('LayoutLM') && table?.text?.includes('0.928'),
    '表格文本可用于提问上下文',
  );
  console.log('     表格首行：', table?.table?.rows?.[0]?.join(' | '));

  const image = res.paragraphs.find((p) => p.type === 'image');
  ok(Boolean(image?.images?.[0]?.url), '图片块带资源 URL', image?.images?.[0]?.url);
  const imgFile = path.join(dir, path.basename(image?.images?.[0]?.url || ''));
  ok(fs.existsSync(imgFile), `图片资源已落盘（${fs.existsSync(imgFile) ? (fs.statSync(imgFile).size / 1024).toFixed(0) + ' KB' : '缺失'}）`);
  ok(image?.images?.[0]?.width > 100, `图片宽度 = ${image?.images?.[0]?.width}`);

  const formula = res.paragraphs.find((p) => p.type === 'formula');
  ok(Boolean(formula?.tex), '公式块带 LaTeX', formula?.tex);
  ok(/\\frac/.test(formula?.tex || ''), '公式包含 \\frac（分数结构）');
  ok(/\\sum/.test(formula?.tex || ''), '公式包含 \\sum（求和结构）');
  ok(/\\ge/.test(formula?.tex || ''), '公式包含 ≥ 关系符');

  const inline = res.paragraphs.find((p) => p.rich && /\$/.test(p.text) && !p.tex);
  ok(Boolean(inline), '识别出行内公式段落（rich）');
  if (inline) console.log('     行内公式段：', inline.text.slice(0, 90));

  const outline = res.paragraphs
    .filter((p) => p.type === 'heading')
    .map((p) => `${p.level}:${p.text}`)
    .slice(0, 8);
  console.log('     标题结构：', outline.join(' / '));

  fs.rmSync(dir, { recursive: true, force: true });
} else {
  console.log('\n[1] DOCX 富解析 — 跳过（缺少 data/samples/sample.docx）');
}

/* --------------------------- PDF --------------------------- */
const pdfPath = sample('sample.pdf');
if (fs.existsSync(pdfPath)) {
  console.log('\n[2] PDF 富解析');
  const dir = tmpFor('pdf');
  const t0 = Date.now();
  const res = await parseDocument({
    buffer: fs.readFileSync(pdfPath),
    filename: 'sample.pdf',
    mimetype: 'application/pdf',
    docId: 'testpdf',
    assetsDir: dir,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const kinds = res.paragraphs.reduce((m, p) => ((m[p.type] = (m[p.type] || 0) + 1), m), {});
  console.log(`     耗时 ${secs}s，块类型统计：`, JSON.stringify(kinds));

  ok(res.paragraphs.length >= 8, `解析出 ${res.paragraphs.length} 个块`);
  ok((res.meta.pages || 0) >= 1, `页数 = ${res.meta.pages}`);
  ok((res.meta.imageCount || 0) >= 1, `提取到 ${res.meta.imageCount || 0} 张内嵌图片`);
  const imgs = res.paragraphs.filter((p) => p.type === 'image');
  if (imgs.length) {
    const f = path.join(dir, path.basename(imgs[0].images[0].url));
    ok(fs.existsSync(f), `内嵌图片已落盘（${(fs.statSync(f).size / 1024).toFixed(0)} KB）`);
    ok(imgs[0].images[0].width >= 100, `内嵌图片宽度 = ${imgs[0].images[0].width}px`);
    const idx = res.paragraphs.findIndex((p) => p.type === 'image');
    const page = res.paragraphs[idx].page;
    console.log(`     图片位于第 ${page} 页，正文块序位 ${idx}/${res.paragraphs.length}`);
    ok(
      res.paragraphs.slice(0, idx).some((p) => p.page === page) ||
        res.paragraphs.slice(idx).some((p) => p.page === page),
      '图片被插回对应页的正文流中',
    );
  } else {
    ok(false, '应至少提取到 1 张内嵌图片');
  }
  ok(
    res.paragraphs.some((p) => /深度学习/.test(p.text)),
    '正文提取正常',
  );

  // PDF 公式结构还原
  const formula = res.paragraphs.find((p) => p.type === 'formula');
  ok(Boolean(formula?.tex), '解析出公式块', formula?.tex);
  ok(/\\frac\{/.test(formula?.tex || ''), '分式还原为 \\frac（靠分数线判定）');
  ok(/\\sum_\{j=1\}\^\{17\}/.test(formula?.tex || ''), '求和号上下限还原为 \\sum_{j=1}^{17}');
  const inlineRich = res.paragraphs.find((p) => p.rich && /\\sqrt/.test(p.text));
  ok(Boolean(inlineRich), '行内根式还原为 \\sqrt', inlineRich?.text?.slice(0, 70));
  ok(/\\sqrt\[2\]\{ab\^\{2\}\}/.test(inlineRich?.text || ''), '根指数与被开方数还原正确');

  const withY = res.paragraphs.filter((p, i) => i > 0 && p.page !== res.paragraphs[i - 1].page);
  console.log('     跨页位置数：', withY.length);

  fs.rmSync(dir, { recursive: true, force: true });
} else {
  console.log('\n[2] PDF 富解析 — 跳过（缺少 data/samples/sample.pdf）');
}

/* ------------------------ OMML 单元测试 ------------------------ */
console.log('\n[3] OMML → LaTeX');
{
  const { DOMParser } = await import('@xmldom/xmldom');
  const cases = [
    [
      '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath>',
      '\\frac{a}{b}',
    ],
    [
      '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>',
      'x^{2}',
    ],
    [
      '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:rad><m:deg/><m:e><m:r><m:t>y</m:t></m:r></m:e></m:rad></m:oMath>',
      '\\sqrt{y}',
    ],
  ];
  for (const [xml, expect] of cases) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const tex = ommlToLatex(doc.documentElement);
    ok(tex === expect, `${expect}`, tex === expect ? '' : `实际得到 ${tex}`);
  }
}

console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
