/**
 * 生成快捷方式图标 assets/icon.ico（纯几何绘制，不依赖字体）。
 * 用法：node scripts/make-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'assets');
fs.mkdirSync(outDir, { recursive: true });

const S = 256;
const canvas = createCanvas(S, S);
const ctx = canvas.getContext('2d');

// 圆角渐变底
const radius = 56;
const grad = ctx.createLinearGradient(0, 0, S, S);
grad.addColorStop(0, '#6366f1');
grad.addColorStop(0.55, '#4f46e5');
grad.addColorStop(1, '#7c3aed');
ctx.beginPath();
ctx.moveTo(radius, 0);
ctx.arcTo(S, 0, S, S, radius);
ctx.arcTo(S, S, 0, S, radius);
ctx.arcTo(0, S, 0, 0, radius);
ctx.arcTo(0, 0, S, 0, radius);
ctx.closePath();
ctx.fillStyle = grad;
ctx.fill();

// 纸张
const px = 74;
const py = 46;
const pw = 108;
const ph = 150;
ctx.beginPath();
ctx.moveTo(px, py + 10);
ctx.arcTo(px, py, px + 10, py, 10);
ctx.lineTo(px + pw - 34, py);
ctx.lineTo(px + pw, py + 34);
ctx.lineTo(px + pw, py + ph - 10);
ctx.arcTo(px + pw, py + ph, px + pw - 10, py + ph, 10);
ctx.lineTo(px + 10, py + ph);
ctx.arcTo(px, py + ph, px, py + ph - 10, 10);
ctx.closePath();
ctx.fillStyle = '#ffffff';
ctx.fill();

// 折角
ctx.beginPath();
ctx.moveTo(px + pw - 34, py);
ctx.lineTo(px + pw, py + 34);
ctx.lineTo(px + pw - 34, py + 34);
ctx.closePath();
ctx.fillStyle = 'rgba(79,70,229,0.22)';
ctx.fill();

// 文本行
ctx.fillStyle = 'rgba(79,70,229,0.55)';
const lines = [26, 46, 66, 96, 116];
lines.forEach((dy, i) => {
  const w = i === 3 ? 34 : i === 4 ? 54 : 72;
  ctx.beginPath();
  const r = 5;
  const x = px + 22;
  const y = py + 44 + dy;
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + 10, r);
  ctx.arcTo(x + w, y + 10, x, y + 10, r);
  ctx.arcTo(x, y + 10, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
});

// 右侧问号（提问的意象）
ctx.beginPath();
ctx.arc(196, 178, 42, 0, Math.PI * 2);
ctx.fillStyle = '#facc15';
ctx.fill();
ctx.lineWidth = 9;
ctx.strokeStyle = 'rgba(255,255,255,0.9)';
ctx.beginPath();
ctx.arc(196, 178, 42, 0, Math.PI * 2);
ctx.stroke();

ctx.fillStyle = '#3f2d00';
ctx.font = 'bold 54px sans-serif';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillText('?', 196, 182);

const png = canvas.toBuffer('image/png');
const ico = Buffer.alloc(22);
ico.writeUInt16LE(0, 0); // reserved
ico.writeUInt16LE(1, 2); // type: icon
ico.writeUInt16LE(1, 4); // count
ico.writeUInt8(0, 6); // width 0 = 256
ico.writeUInt8(0, 7); // height 0 = 256
ico.writeUInt8(0, 8); // palette
ico.writeUInt8(0, 9); // reserved
ico.writeUInt16LE(1, 10); // planes
ico.writeUInt16LE(32, 12); // bpp
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);

const icoPath = path.join(outDir, 'icon.ico');
fs.writeFileSync(icoPath, Buffer.concat([ico, png]));
console.log(`[make-icon] 已生成 ${icoPath}（${(png.length / 1024).toFixed(0)} KB PNG 内嵌）`);
