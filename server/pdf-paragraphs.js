import { splitLongParagraph, looksLikeHeading } from './segment.js';
const median = (a) => { const b = a.filter((x) => x > 0).sort((x, y) => x-y); return b[Math.floor(b.length/2)] || 0; };
const CJK = /[\u3400-\u9fff]/;

// 中文与拉丁字体的基线可能不同；先合并横向互不重叠的近邻行，再按列锚点还原表格。
function readTableRun(lines, start, bodySize, avgGap) {
  const raw = [], rows = [];
  const shortCells = (l) => l && !l.isMath && !l.rich && l.cells?.length &&
    l.cells.length <= 14 && l.cells.every(c => c.text.length <= 60) &&
    !/[。；;!?！？]|\.{4,}|…{3,}/.test(l.text);
  for (let j=start; j<lines.length; j++) {
    const next=lines[j], last=raw.at(-1), row=rows.at(-1);
    if (!shortCells(next) || next.column !== lines[start].column) break;
    const gap=last ? last.y-next.y : 0;
    if (last && (gap<0 || gap>avgGap*2.2)) break;
    const sameRow=row && row.y-next.y<bodySize*.65 && next.cells.every(c =>
      row.cells.every(a => c.x >= a.x1+2 || c.x1 <= a.x-2));
    if (next.cells.length===1 && !sameRow) break;
    if (sameRow) row.cells.push(...next.cells);
    else rows.push({y:next.y,cells:[...next.cells]});
    raw.push(next);
  }
  if (rows.length<3 || rows.some(r=>r.cells.length<2)) return null;
  const anchors=[];
  for(const row of rows) for(const cell of row.cells) {
    if(!anchors.some(x=>Math.abs(x-cell.x)<bodySize*1.2)) anchors.push(cell.x);
  }
  anchors.sort((a,b)=>a-b);
  if(anchors.length>14 || anchors.some(x=>rows.filter(r=>r.cells.some(c=>Math.abs(c.x-x)<bodySize*1.2)).length<2)) return null;
  const values=rows.map(row=>anchors.map(x=>row.cells.filter(c=>Math.abs(c.x-x)<bodySize*1.2).map(c=>c.text).join(' ')));
  const headerRow=!values[0].some(c=>/^[-+]?\d+(?:\.\d+)?%?$/.test(c)) && values.slice(1).some(r=>r.some(c=>/^[-+]?\d+(?:\.\d+)?%?$/.test(c)));
  return {raw,table:{rows:values,cols:anchors.length,headerRow}};
}
export function linesToBlocks(lines, page) {
  const blocks = [];
  if (!lines.length) return blocks;
  const bodySize = median(lines.map((l) => l.h)) || 10;
  const avgGap = median(lines.slice(1).map((l,i) => lines[i].y-l.y).filter((g) => g > bodySize*.65 && g < bodySize*4)) || bodySize*1.35;
  let buf = '', bufLines = [], prev;
  const source = (group) => ({ x0:Math.min(...group.map((l) => l.x0)), x1:Math.max(...group.map((l) => l.x1)), y0:Math.min(...group.map((l) => l.y-l.h*.45)), y1:Math.max(...group.map((l) => l.y+l.h*1.35)) });
  const flush = () => {
    if (buf.trim()) for (const piece of splitLongParagraph(buf.trim())) blocks.push({ type:'paragraph', text:piece, page, y:bufLines[0].y, source:source(bufLines), ...(bufLines.some((l) => l.rich) ? { rich:true } : {}), column:bufLines[0].column });
    buf = ''; bufLines = [];
  };
  const mathNeighbor = (l) => l && !/[\u4e00-\u9fff]{2}/.test(l.text) && l.text.length < 160 && /[=≥≤∑∏∫√𝑎-𝑧𝛼-𝜔]|exp\s*\(/u.test(l.text);
  const tableCandidate = (l) => l && !l.isMath && l.cells?.length >= 2 && l.cells.length <= 14 && l.x1-l.x0 > bodySize*9 && !/\.{4,}|…{3,}/.test(l.text);
  for (let i=0; i<lines.length; i++) {
    const line = lines[i];
    if (/\.{4,}|…{3,}|·{5,}/.test(line.text)) { flush(); blocks.push({ type:'list', text:line.text, page, y:line.y, source:source([line]), column:line.column }); prev=line; continue; }
    if (tableCandidate(line)) {
      const run=readTableRun(lines,i,bodySize,avgGap);
      if (run) {
        flush();
        blocks.push({ type:'table', text:run.table.rows.map(r => r.join(' | ')).join('\n'), table:run.table, page, y:line.y, source:source(run.raw), column:line.column });
        i += run.raw.length-1; prev=run.raw.at(-1); continue;
      }
    }
    if (line.isMath || (mathNeighbor(line) && lines[i+1]?.isMath && line.y-lines[i+1].y < avgGap*2.4)) {
      flush(); const group=[line];
      while (i+1<lines.length && (lines[i+1].isMath || mathNeighbor(lines[i+1])) && lines[i+1].column === line.column && group.at(-1).y-lines[i+1].y < avgGap*2.5) group.push(lines[++i]);
      const tex=group.map((l) => l.tex).join(' \\quad ');
      const original = source(group); original.y0 -= bodySize*1.2; original.y1 += bodySize*.7;
      blocks.push({ type:'formula', text:'$$'+tex+'$$', tex, texUncertain:true, page, y:line.y, source:original, column:line.column });
      prev=group.at(-1); continue;
    }
    const numbered = /^(\d+(?:\.\d+)+)\s*\S/.test(line.text) || /^[一二三四五六七八九十]+[、．.]/.test(line.text);
    const isHeading = !line.isMath && line.text.length <= 90 && !/[。．.,，;；]$/.test(line.text) && ((numbered && line.text.length<60) || (looksLikeHeading(line.text) && !/^\d+[.、]\S/.test(line.text) && line.text.length<60) || ((line.h >= bodySize*1.16 || line.bold) && line.text.length<60));
    if (isHeading) { flush(); const level=/^(\d+(?:\.\d+)+)/.exec(line.text)?.[1].split('.').length || 1; blocks.push({ type:'heading', text:line.text, level, page, y:line.y, source:source([line]), column:line.column }); prev=line; continue; }
    if (prev && buf) { const gap=prev.y-line.y; const sentenceEnd=/[。！？.!?；;:：]\s*$/.test(buf); const indent=line.x0>prev.x0+bodySize*.9; if (prev.isMath || gap>avgGap*1.6 || gap < -bodySize || line.column !== prev.column || (indent && sentenceEnd)) flush(); }
    if (!buf) buf=line.text;
    else if (CJK.test(buf.slice(-1)) && CJK.test(line.text.charAt(0))) buf+=line.text;
    else if (/-$/.test(buf) && /^[a-z]/.test(line.text)) buf=buf.slice(0,-1)+line.text;
    else buf+=' '+line.text;
    bufLines.push(line); prev=line;
  }
  flush(); return blocks;
}
