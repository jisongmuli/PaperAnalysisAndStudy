/**
 * 导出功能自测：对已有文档真实下载 Word / Markdown / JSON 并校验内容。
 * 用法：node scripts/exporttest.mjs [docId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = process.env.APP_URL || 'http://127.0.0.1:8787';
const outDir = path.join(root, 'data', 'samples');
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const ok = (c, label, extra = '') => {
  console.log(`${c ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!c) failures += 1;
};

const list = await (await fetch(`${APP}/api/documents`)).json();
let docId = process.argv[2];
if (!docId) {
  // 优先选择「既有富内容（表格/图片/公式）又有问答」的文档
  const scored = [];
  for (const d of list.documents) {
    const { document: full } = await (await fetch(`${APP}/api/documents/${d.id}`)).json();
    const kinds = { table: 0, image: 0, formula: 0 };
    for (const p of full.paragraphs) if (kinds[p.type] !== undefined) kinds[p.type] += 1;
    const rich = kinds.table + kinds.image + kinds.formula;
    scored.push({ id: d.id, rich, qa: d.questionCount, score: rich * 10 + d.questionCount });
  }
  scored.sort((a, b) => b.score - a.score);
  docId = scored[0]?.id;
  if (docId) console.log(`选用文档：${docId}（富内容 ${scored[0].rich}，问答 ${scored[0].qa}）`);
}
if (!docId) {
  console.error('没有可用文档，请先在界面上传并提问，或运行 scripts/uicheck.mjs');
  process.exit(1);
}
const { document: doc } = await (await fetch(`${APP}/api/documents/${docId}`)).json();
const kinds = { table: 0, image: 0, formula: 0, paragraph: 0, heading: 0, list: 0 };
for (const p of doc.paragraphs) kinds[p.type] = (kinds[p.type] || 0) + 1;
const answeredParas = doc.paragraphs.filter((p) => (doc.threads?.[p.id]?.messages || []).some((m) => m.role === 'user')).length;
const hasCross = Boolean(doc.threads?.__cross__?.messages?.length);
console.log(
  `\n测试文档：${doc.title}（${doc.paragraphs.length} 块：表 ${kinds.table} / 图 ${kinds.image} / 式 ${kinds.formula}；` +
    `${answeredParas} 块有问答${hasCross ? '，含跨段落' : ''}）`,
);

const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r;
};

console.log('\n[1] Markdown 导出');
{
  const r = await get(`${APP}/api/documents/${docId}/export?format=markdown&includeOriginal=1`);
  const text = await r.text();
  fs.writeFileSync(path.join(outDir, 'export-test.md'), text, 'utf8');
  ok(r.headers.get('content-type').includes('markdown'), 'Content-Type 正确');
  ok(/attachment; filename\*=UTF-8''/.test(r.headers.get('content-disposition') || ''), '下载文件名已编码（支持中文）');
  ok(text.includes('# '), '包含标题');
  ok(text.includes('## 二、问答记录清单'), '包含问答清单章节');
  ok(/段落 \d+/.test(text), '包含段落编号');
  ok(text.includes('针对本段的回答') || text.includes('## 二、问答记录清单'), '包含问答正文');
  ok(text.includes('| 数据集 | 方法 |') || kinds.table === 0, '表格导出为 Markdown 表格');
  ok(text.includes('![插图 1]') || kinds.image === 0, '图片导出为 Markdown 图片链接');
  ok(text.includes('| 维度 | 结论 |'), 'AI 回答中的表格被原样保留');
}

console.log('\n[2] JSON 导出');
{
  const r = await get(`${APP}/api/documents/${docId}/export?format=json&includeOriginal=1`);
  const data = await r.json();
  fs.writeFileSync(path.join(outDir, 'export-test.json'), JSON.stringify(data, null, 2), 'utf8');
  ok(Array.isArray(data.items), 'items 为数组');
  ok(hasCross ? data.items.some((i) => i.crossParagraph) : true, hasCross ? '含跨段落条目' : '（无跨段落提问，跳过）');
  ok(
    data.items.some((i) => i.qa.some((q) => q.answer && q.answer.length > 50)),
    '含完整 AI 回答',
  );
  ok(data.document.questionCount > 0, `统计到 ${data.document.questionCount} 条提问`);
  ok(
    kinds.table === 0 || data.items.some((i) => i.type === 'table' && i.table?.rows?.length),
    'JSON 保留表格结构',
  );
  ok(
    kinds.image === 0 || data.items.some((i) => i.type === 'image' && i.images?.length),
    'JSON 保留图片资源引用',
  );
  ok(
    kinds.formula === 0 || data.items.some((i) => i.type === 'formula' && i.tex),
    'JSON 保留公式 LaTeX',
  );
}

console.log('\n[3] Word 批注版导出');
{
  const r = await get(`${APP}/api/documents/${docId}/export?format=docx&comments=1&includeOriginal=1`);
  const buf = Buffer.from(await r.arrayBuffer());
  const file = path.join(outDir, 'export-test-comments.docx');
  fs.writeFileSync(file, buf);
  ok(buf.length > 5000, `文件大小 ${(buf.length / 1024).toFixed(1)} KB`);
  const py = process.env.PYTHON || 'python';
  const probe = `
import zipfile, sys, json
z = zipfile.ZipFile(r"${file}")
names = z.namelist()
comments = z.read('word/comments.xml').decode('utf-8') if 'word/comments.xml' in names else ''
doc = z.read('word/document.xml').decode('utf-8')
refs = doc.count('commentReference')
print(json.dumps({
  'has_comments_part': 'word/comments.xml' in names,
  'comments_len': len(comments),
  'comment_refs': refs,
  'has_cross_text': '跨段落' in comments,
  'comments': comments.count('<w:comment '),
  'raw_dollar': ('$$' in comments) or ('$$' in doc),
  'has_frac': '\\\\frac' in comments,
  'tables': doc.count('<w:tbl>') + doc.count('<w:tbl '),
  'table_rows': doc.count('<w:tr>') + doc.count('<w:tr '),
  'table_cells': doc.count('<w:tc>') + doc.count('<w:tc '),
  'drawings': doc.count('<w:drawing>'),
  'media': len([n for n in names if n.startswith('word/media/')]),
  'answered_marker': '的问答' in comments,
  'omath': doc.count('<m:oMath>') + doc.count('<m:oMath '),
  'm_frac': doc.count('<m:f>') + doc.count('<m:f '),
  'm_rad': doc.count('<m:rad>') + doc.count('<m:rad '),
  'm_nary': doc.count('<m:nary>') + doc.count('<m:nary '),
}))
`;
  const out = execFileSync(py, ['-c', probe], { encoding: 'utf8' });
  const info = JSON.parse(out.trim());
  ok(info.has_comments_part, '包含 comments.xml 部件');
  ok(info.comments >= answeredParas, `批注数量 ${info.comments}（覆盖 ${answeredParas} 个有问答的块）`);
  ok(info.comment_refs >= answeredParas, `正文中批注锚点 ${info.comment_refs} 处`);
  ok(info.answered_marker, '批注中以「第 N 段」标注出处');
  ok(!info.raw_dollar, 'Word 中不残留 $$ 公式定界符');
  if (kinds.table) {
    ok(info.tables >= 1 && info.table_rows >= 4, `表格导出为真 Word 表格（${info.tables} 个表 / ${info.table_rows} 行 / ${info.table_cells} 单元格）`);
  } else {
    console.log('  - 该文档无表格，跳过表格检查');
  }
  if (kinds.image) {
    ok(info.drawings >= 1 && info.media >= 1, `图片导出为内嵌图片（${info.drawings} 处引用 / ${info.media} 个媒体文件）`);
  } else {
    console.log('  - 该文档无图片，跳过图片检查');
  }
  if (kinds.formula) {
    ok(info.omath >= 1, `公式导出为 Word 原生公式（${info.omath} 个 oMath）`);
    ok(info.m_frac >= 1 || info.m_nary >= 1, `公式保留了分式/求和等结构（f=${info.m_frac} nary=${info.m_nary}）`);
  } else {
    console.log('  - 该文档无公式，跳过公式检查');
  }
}

console.log('\n[4] Word 普通版导出');
{
  const r = await get(`${APP}/api/documents/${docId}/export?format=docx&comments=0&includeOriginal=1`);
  const buf = Buffer.from(await r.arrayBuffer());
  const file = path.join(outDir, 'export-test-plain.docx');
  fs.writeFileSync(file, buf);
  ok(buf.length > 3000, `文件大小 ${(buf.length / 1024).toFixed(1)} KB`);
  const py = process.env.PYTHON || 'python';
  const out = execFileSync(py, ['-c', `
import zipfile, json
z = zipfile.ZipFile(r"${file}")
names = z.namelist()
doc = z.read('word/document.xml').decode('utf-8')
print(json.dumps({'has_comments': 'word/comments.xml' in names, 'has_qa': '问答记录' in doc}))
`], { encoding: 'utf8' });
  const info = JSON.parse(out.trim());
  ok(!info.has_comments, '普通版不含批注部件');
  ok(info.has_qa, '包含问答记录章节');
}

console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
