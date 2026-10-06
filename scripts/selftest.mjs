/**
 * 后端自测：解析 / 导出 / 接口（不依赖 DeepSeek 密钥）
 * 用法：node scripts/selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.PORT = process.env.TEST_PORT || '8791';
process.env.PAPERINSIGHT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paperinsight-selftest-'));

const { parseDocument } = await import('../server/parser.js');
const store = await import('../server/store.js');
const { buildMarkdown, buildJson, buildDocx } = await import('../server/export.js');

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

console.log('\n[1] 纯文本分段');
const txt = `论文标题：深度学习综述

摘要

本文综述了深度学习在自然语言处理领域的进展。首先介绍背景。

1. 引言

近年来，随着算力的提升，深度学习模型规模不断扩大。Transformer 架构成为主流。

结论：未来仍有很大空间。`;
const t1 = await parseDocument({ pastedText: txt, filename: 'demo.txt' });
ok(t1.paragraphs.length >= 5, `段落数 = ${t1.paragraphs.length}`);
ok(
  t1.paragraphs.some((p) => p.type === 'heading'),
  '识别出标题段',
  t1.paragraphs.filter((p) => p.type === 'heading').map((p) => p.text).join(' / '),
);

console.log('\n[2] 长段落二次切分');
const long = '这是一个很长的句子，用来测试切分逻辑。'.repeat(120);
const t2 = await parseDocument({ pastedText: long, filename: 'long.txt' });
ok(t2.paragraphs.length > 1, `超长文本被切成 ${t2.paragraphs.length} 段`);

console.log('\n[3] DOCX 解析');
const docxPath = path.join(root, 'data', 'samples', 'sample.docx');
if (fs.existsSync(docxPath)) {
  const buf = fs.readFileSync(docxPath);
  const t3 = await parseDocument({
    buffer: buf,
    filename: 'sample.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  ok(t3.paragraphs.length > 3, `DOCX 段落数 = ${t3.paragraphs.length}`);
  console.log(`     首段：${t3.paragraphs[0]?.text?.slice(0, 60)}`);
} else {
  console.log('  - 跳过（缺少 data/samples/sample.docx）');
}

console.log('\n[4] PDF 解析');
const pdfPath = path.join(root, 'data', 'samples', 'sample.pdf');
if (fs.existsSync(pdfPath)) {
  const buf = fs.readFileSync(pdfPath);
  const t4 = await parseDocument({ buffer: buf, filename: 'sample.pdf', mimetype: 'application/pdf' });
  ok(t4.paragraphs.length > 3, `PDF 段落数 = ${t4.paragraphs.length}（${t4.meta.pages} 页）`);
  ok(
    t4.paragraphs.map((p) => p.text).join('').length > 100,
    `PDF 提取字符数 = ${t4.paragraphs.map((p) => p.text).join('').length}`,
  );
  console.log(`     首段：${t4.paragraphs[0]?.text?.slice(0, 80)}`);
  if (t4.meta.warning) console.log(`     提示：${t4.meta.warning}`);
} else {
  console.log('  - 跳过（缺少 data/samples/sample.pdf）');
}

console.log('\n[5] 存储 + 导出');
const doc = store.createDocument({
  title: '测试文档',
  filename: 'demo.txt',
  format: 'text',
  paragraphs: t1.paragraphs,
  meta: t1.meta,
});
store.appendMessage(doc.id, 'p1', { role: 'user', content: '这段话在说什么？' });
store.appendMessage(doc.id, 'p1', { role: 'assistant', content: '这是在介绍深度学习综述的背景。\n第二行答案。' });
store.appendMessage(doc.id, 'p3', { role: 'user', content: 'Transformer 是什么？', citedParagraphIds: ['p1'] });
store.appendMessage(doc.id, 'p3', { role: 'assistant', content: '一种主流架构。' });
store.appendMessage(doc.id, '__cross__', { role: 'user', content: '第1段和第3段有什么联系？', citedParagraphIds: ['p1', 'p3'] });
store.appendMessage(doc.id, '__cross__', { role: 'assistant', content: '它们共同描述了研究背景与动机。' });

const fresh = store.getDocument(doc.id);
const md = buildMarkdown(fresh);
ok(md.includes('这段话在说什么'), 'Markdown 含提问');
ok(md.includes('跨段落'), 'Markdown 含跨段落实录');
const js = buildJson(fresh);
ok(js.items.length >= 3, `JSON 条目数 = ${js.items.length}（含未提问的块）`);
ok(js.items.length >= fresh.paragraphs.length, 'JSON 覆盖全部文档块（另有跨段落条目）');
ok(js.items.some((i) => i.crossParagraph), 'JSON 含跨段落条目');
ok(
  js.items.some((i) => i.qa.some((q) => q.citedParagraphIds.length > 0)),
  'JSON 保留引用段落 id',
);

const docxBuf = await buildDocx(fresh, { asComments: true });
ok(docxBuf.length > 4000, `DOCX 批注版生成 ${(docxBuf.length / 1024).toFixed(1)} KB`);
fs.writeFileSync(path.join(process.env.PAPERINSIGHT_DATA_DIR, 'selftest-export.docx'), docxBuf);

const docxBuf2 = await buildDocx(fresh, { asComments: false });
ok(docxBuf2.length > 2000, `DOCX 普通版生成 ${(docxBuf2.length / 1024).toFixed(1)} KB`);

store.deleteDocument(doc.id);

console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
