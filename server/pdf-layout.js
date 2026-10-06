import { buildMathAwareLines } from './pdfmath.js';

const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] || 0; };
export function orderColumns(lines, pageWidth) {
  const mid = pageWidth / 2;
  const left = lines.filter((l) => l.column === 0 || (l.column == null && l.x1 < mid + 10));
  const right = lines.filter((l) => l.column === 1 || (l.column == null && l.x0 > mid - 10));
  const spanning = lines.filter((l) => !left.includes(l) && !right.includes(l));
  if (left.length < 4 || right.length < 4) return [...lines].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const pending = [...left, ...right];
  const ordered = [];
  const section = (above) => {
    const picked = pending.filter((l) => l.y > above);
    for (const group of [picked.filter((l) => left.includes(l)), picked.filter((l) => right.includes(l))]) ordered.push(...group.sort((a, b) => b.y - a.y));
    for (const l of picked) pending.splice(pending.indexOf(l), 1);
  };
  for (const l of spanning.sort((a, b) => b.y - a.y)) { section(l.y); ordered.push(l); }
  section(-Infinity);
  return ordered;
}

// Find the actual gutter before math reconstruction can join text across columns.
export function buildPageLines(items, rules, width) {
  const mainH = median(items.map((i) => i.h).filter((n) => n > 0)) || 10;
  const rows = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let row = rows.find((r) => Math.abs(r.y - item.y) < mainH * 0.28);
    if (!row) { row = { y: item.y, items: [] }; rows.push(row); }
    row.items.push(item);
  }
  const gutters = [];
  for (const row of rows) {
    const sorted = row.items.sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      const end = sorted[i - 1].x + sorted[i - 1].w;
      const gap = sorted[i].x - end;
      const center = (end + sorted[i].x) / 2;
      if (gap > mainH * 1.8 && center > width * 0.35 && center < width * 0.65) gutters.push(center);
    }
  }
  const cut = median(gutters);
  const dual = gutters.length >= 6 && gutters.length >= rows.length * 0.35;
  if (!dual) return buildMathAwareLines(items, rules);
  const groups = [[], [], []];
  for (const row of rows) {
    const gapAtCut = row.items.some((a, i) => i && a.x - (row.items[i - 1].x + row.items[i - 1].w) > mainH * 1.5 && a.x > cut && row.items[i - 1].x < cut);
    const spans = row.items.some((a) => a.x < cut - 5 && a.x + a.w > cut + 5);
    const crosses = row.items[0]?.x < cut - 5 && row.items.at(-1)?.x + row.items.at(-1)?.w > cut + 5;
    for (const item of row.items) groups[(spans || (crosses && !gapAtCut)) ? 2 : item.x >= cut ? 1 : 0].push(item);
  }
  const lines = groups.flatMap((group, column) => buildMathAwareLines(group, rules.filter((r) => column === 2 || (column === 0 ? r.x1 <= cut + 4 : r.x0 >= cut - 4))).map((l) => ({ ...l, column: column === 2 ? 'full' : column })));
  return orderColumns(lines, width);
}
