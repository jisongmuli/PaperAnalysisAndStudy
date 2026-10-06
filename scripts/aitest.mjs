/**
 * AI 精修解析验证（真实 API）
 * 用法：node scripts/aitest.mjs [文件名]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = 'http://127.0.0.1:8787';
const file = process.argv[2] || 'sample.pdf';

const form = new FormData();
form.append('file', new Blob([fs.readFileSync(path.join(root, 'data', 'samples', file))]), file);
form.append('title', `AI 精修测试 · ${file}`);
const up = await (await fetch(`${APP}/api/documents`, { method: 'POST', body: form })).json();
const doc = up.document;
console.log(`上传完成：${doc.id}，${doc.paragraphs.length} 块\n`);

console.log('=== 精修前 ===');
doc.paragraphs.forEach((p) => {
  const tag = p.type === 'formula' ? '公式' : p.type === 'table' ? '表格' : p.type === 'image' ? '图片' : '段落';
  console.log(`[${String(p.index).padStart(2)}] ${tag} ${JSON.stringify(p.text).slice(0, 110)}`);
});

console.log('\n=== 开始 AI 精修（SSE）===');
const t0 = Date.now();
const res = await fetch(`${APP}/api/documents/${doc.id}/ai-parse`, { method: 'POST' });
if (!res.ok) {
  console.log('失败：', await res.text());
  process.exit(1);
}
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let final = null;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split('\n\n');
  buf = parts.pop();
  for (const part of parts) {
    const line = part.trim();
    if (!line.startsWith('data:')) continue;
    const evt = JSON.parse(line.slice(5));
    if (evt.type === 'progress' && evt.phase === 'chunk-done') {
      console.log(`  第 ${evt.index}/${evt.total} 批完成，已修正 ${evt.applied} 块，累计 ${evt.usage.totalTokens} tokens`);
    } else if (evt.type === 'done') {
      final = evt;
    } else if (evt.type === 'error') {
      console.log('  错误：', evt.message);
    }
  }
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n=== 精修后（用时 ${secs}s）===`);
const fresh = await (await fetch(`${APP}/api/documents/${doc.id}`)).json();
fresh.document.paragraphs.forEach((p) => {
  const tag = p.type === 'formula' ? '公式' : p.type === 'table' ? '表格' : p.type === 'image' ? '图片' : p.type === 'heading' ? '标题' : '段落';
  const mark = p.aiRefined ? '✦' : ' ';
  console.log(`${mark}[${String(p.index).padStart(2)}] ${tag} ${JSON.stringify(p.text).slice(0, 110)}`);
});

console.log('\n=== 消耗统计（已随文档保存）===');
console.log(JSON.stringify(fresh.document.aiParse, null, 2));

console.log('\n=== 重新打开文档（应复用已保存结果，不再消耗 token）===');
const again = await (await fetch(`${APP}/api/documents/${doc.id}`)).json();
console.log('  aiParse 仍在：', Boolean(again.document.aiParse));
console.log('  已精修块数：', again.document.paragraphs.filter((p) => p.aiRefined).length);

console.log('\n=== 还原为本地解析 ===');
const restored = await (await fetch(`${APP}/api/documents/${doc.id}/ai-parse`, { method: 'DELETE' })).json();
console.log('  还原成功：', restored.ok, '｜ 剩余精修块：', restored.document.paragraphs.filter((p) => p.aiRefined).length);

await fetch(`${APP}/api/documents/${doc.id}`, { method: 'DELETE' });
console.log('\n完成，测试文档已清理。');
