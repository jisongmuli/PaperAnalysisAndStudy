/**
 * 把 KaTeX 的运行时文件复制到 web/public/vendor/katex，
 * 供「打印 / 导出 PDF」页面（public/print.html，纯静态、不打包）离线使用。
 * 由 npm run build 与 postinstall 自动调用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'web', 'node_modules', 'katex', 'dist');
const dest = path.join(root, 'web', 'public', 'vendor', 'katex');

if (!fs.existsSync(src)) {
  console.warn('[copy-katex] 未找到 katex，请先执行 npm --prefix web install');
  process.exit(0);
}

fs.mkdirSync(path.join(dest, 'fonts'), { recursive: true });

for (const file of ['katex.min.css', 'katex.min.js']) {
  const from = path.join(src, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, file));
}

// 只复制 woff2（浏览器优先使用，体积最小）
const fontDir = path.join(src, 'fonts');
if (fs.existsSync(fontDir)) {
  for (const f of fs.readdirSync(fontDir)) {
    if (f.endsWith('.woff2')) {
      fs.copyFileSync(path.join(fontDir, f), path.join(dest, 'fonts', f));
    }
  }
}

const count = fs.readdirSync(path.join(dest, 'fonts')).length;
console.log(`[copy-katex] 已复制 KaTeX 运行时（${count} 个字体文件）→ web/public/vendor/katex`);
