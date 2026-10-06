/**
 * 真实 API 端到端验证：上传 PDF → 提问公式 → 切换全文模式提问
 * 用法：node scripts/livetest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = 'http://127.0.0.1:8787';

async function api(pathname, options = {}) {
  const res = await fetch(APP + pathname, {
    headers: options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

async function ask(docId, payload, { onEvent } = {}) {
  const res = await fetch(`${APP}/api/documents/${docId}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let answer = '';
  let reasoning = '';
  const events = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const p of parts) {
      const line = p.trim();
      if (!line.startsWith('data:')) continue;
      const evt = JSON.parse(line.slice(5));
      events[evt.type] = (events[evt.type] || 0) + 1;
      if (evt.type === 'delta') answer += evt.text;
      if (evt.type === 'reasoning') reasoning += evt.text;
      if (evt.type === 'context') events.__context = evt;
      if (evt.type === 'error') throw new Error(evt.message);
      onEvent?.(evt);
    }
  }
  return { answer, reasoning, events };
}

console.log('=== 1. 健康检查与配置 ===');
const cfg = await api('/api/config');
console.log('  密钥:', cfg.data.apiKeyMasked, '来源:', cfg.data.apiKeySource);
console.log('  模型:', cfg.data.model, '｜ 上下文模式:', cfg.data.contextMode, '｜ 上下文上限:', cfg.data.maxContextTokens);

console.log('\n=== 2. 上传 sample.pdf（含分式/求和公式）===');
const form = new FormData();
form.append('file', new Blob([fs.readFileSync(path.join(root, 'data', 'samples', 'sample.pdf'))]), 'sample.pdf');
form.append('title', 'PDF 公式测试');
const up = await api('/api/documents', { method: 'POST', body: form });
if (up.status !== 200) {
  console.error('  上传失败:', JSON.stringify(up.data).slice(0, 300));
  process.exit(1);
}
const doc = up.data.document;
console.log(`  文档 id=${doc.id}，共 ${doc.paragraphs.length} 块`);
const formulaBlock = doc.paragraphs.find((p) => p.type === 'formula');
console.log('  识别到的公式块:', formulaBlock ? JSON.stringify(formulaBlock.text).slice(0, 160) : '（无）');

console.log('\n=== 3. 针对公式块提问（真实 API，流式）===');
const target = formulaBlock || doc.paragraphs[5];
const t0 = Date.now();
const r1 = await ask(doc.id, {
  paragraphId: target.id,
  question: '这个公式的完整形式是什么？各符号代表什么？',
  useStoredHistory: true,
});
console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，事件: ${JSON.stringify(r1.events)}`);
console.log('  回答:\n' + r1.answer.split('\n').map((l) => '    ' + l).join('\n').slice(0, 1800));
if (r1.reasoning) console.log(`  （思考过程 ${r1.reasoning.length} 字，已单独保存）`);

console.log('\n=== 4. 多轮追问 ===');
const r2 = await ask(doc.id, {
  paragraphId: target.id,
  question: '分母里的求和是对哪个下标求和？',
  useStoredHistory: true,
});
console.log('  回答:\n' + r2.answer.split('\n').map((l) => '    ' + l).join('\n').slice(0, 900));

console.log('\n=== 5. 切换到「全文」模式并提问 ===');
await api('/api/config', { method: 'POST', body: JSON.stringify({ contextMode: 'full' }) });
const budget = await api(`/api/documents/${doc.id}/context-budget`);
console.log(`  文档 ${budget.data.totalChars} 字 ≈ ${budget.data.totalTokens} tokens（上限 ${budget.data.budgetTokens}）`);
const t1 = Date.now();
const r3 = await ask(doc.id, {
  paragraphId: doc.paragraphs[2].id,
  question: '这篇文档整体讲了什么？主要结论有哪些？',
  useStoredHistory: true,
});
console.log(`  用时 ${((Date.now() - t1) / 1000).toFixed(1)}s，context 事件: ${JSON.stringify(r3.events.__context)}`);
console.log('  回答:\n' + r3.answer.split('\n').map((l) => '    ' + l).join('\n').slice(0, 1500));

console.log('\n=== 6. 修正公式块 + 使用修正后的内容提问 ===');
const fix = await api(`/api/documents/${doc.id}/paragraphs/${target.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ text: '$$p_{ri}=\\frac{x_{ri}}{\\sum_{j=1}^{17} x_{rj}},\\quad p_{ri}\\ge 0$$', tex: 'p_{ri}=\\frac{x_{ri}}{\\sum_{j=1}^{17} x_{rj}},\\quad p_{ri}\\ge 0' }),
});
console.log('  修正结果:', fix.status === 200 ? '成功' : JSON.stringify(fix.data).slice(0, 200));
const r4 = await ask(doc.id, {
  paragraphId: target.id,
  question: '用一句话说明这个公式在做什么。',
  useStoredHistory: false,
});
console.log('  回答:\n' + r4.answer.split('\n').map((l) => '    ' + l).join('\n').slice(0, 700));

await api('/api/config', { method: 'POST', body: JSON.stringify({ contextMode: 'paragraph' }) });
await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
console.log('\n完成，测试文档已清理。');
