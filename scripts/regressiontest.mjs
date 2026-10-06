/**
 * 回归测试：中文文件名乱码、正文公式渲染标记（rich）
 * 需要服务已在运行（npm run serve）
 * 用法：node scripts/regressiontest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = process.env.APP_URL || 'http://127.0.0.1:8787';

let failures = 0;
const ok = (c, label, extra = '') => {
  console.log(`${c ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!c) failures += 1;
};

const CN_NAME = 'RobustBench_中文精读总结.pdf';

console.log('\n[1] 中文文件名不再乱码');
{
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(path.join(root, 'data', 'samples', 'sample.pdf'))]), CN_NAME);
  const { document: doc } = await (await fetch(`${APP}/api/documents`, { method: 'POST', body: form })).json();
  ok(doc.filename === CN_NAME, `文件名正确：${doc.filename}`);
  ok(doc.title === CN_NAME, `未填标题时用文件名：${doc.title}`);
  await fetch(`${APP}/api/documents/${doc.id}`, { method: 'DELETE' });
}

console.log('\n[2] 含行内公式的正文必须标记 rich（否则 $...$ 会原样显示）');
{
  const pasted = [
    '成员判对率是 $a_{train}$，非成员判对率是 $1-a_{test}$。',
    '第一节标题',
    '普通正文，没有任何公式。',
  ].join('\n\n');
  const { document: doc } = await (
    await fetch(`${APP}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pastedText: pasted, title: 'rich 标记测试' }),
    })
  ).json();

  const withMath = doc.paragraphs.filter((p) => /\$[^$\n]+\$/.test(p.text));
  const withoutMath = doc.paragraphs.filter((p) => !/\$/.test(p.text));
  ok(withMath.length >= 1, `识别出 ${withMath.length} 个含公式的块`);
  ok(
    withMath.every((p) => p.rich),
    '含公式的块都已标记 rich',
    withMath.map((p) => `rich=${p.rich}`).join(','),
  );
  ok(
    withoutMath.every((p) => !p.rich),
    '不含公式的块不会误标记',
    withoutMath.map((p) => `rich=${p.rich}`).join(','),
  );

  // 人工修正成含公式的文本，也应自动补上 rich
  const target = withoutMath[0];
  if (target) {
    const r = await (
      await fetch(`${APP}/api/documents/${doc.id}/paragraphs/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '修正后的文本，含公式 $E = mc^2$。' }),
      })
    ).json();
    ok(r.block?.rich === true, '人工修正成含公式的文本后自动补 rich');
  }
  await fetch(`${APP}/api/documents/${doc.id}`, { method: 'DELETE' });
}

console.log('\n[3] 历史数据迁移（store 载入时修复乱码与 rich）');
{
  const { fixFilename } = await import('../server/store.js');
  const mangled = Buffer.from(CN_NAME, 'utf8').toString('latin1');
  ok(fixFilename(mangled) === CN_NAME, '乱码文件名可还原');
  ok(fixFilename('plain.pdf') === 'plain.pdf', 'ASCII 名不受影响');
  ok(fixFilename(CN_NAME) === CN_NAME, '正确的中文名不会被破坏');
}

console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
