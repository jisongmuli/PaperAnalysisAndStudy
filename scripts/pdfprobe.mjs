/** 查看 PDF 中公式区域被抽取成什么样 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { parseDocument } = await import('../server/parser.js');

const file = process.argv[2] || path.join(root, 'data', 'samples', 'sample.pdf');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-probe-'));
const res = await parseDocument({
  buffer: fs.readFileSync(file),
  filename: path.basename(file),
  mimetype: 'application/pdf',
  docId: 'probe',
  assetsDir: dir,
});

for (const p of res.paragraphs) {
  const flag = /[√∑∫=]|\\frac/.test(p.text) ? '  <<< 公式相关' : '';
  console.log(`[${String(p.index).padStart(2)}] (p${p.page}) ${p.type.padEnd(9)} ${JSON.stringify(p.text)}${flag}`);
}
fs.rmSync(dir, { recursive: true, force: true });
