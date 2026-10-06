/**
 * PDF 文本 / 公式行重建
 *
 * PDF 里没有「公式」概念：一个分数被拆成分子行、横线、分母行；上下标靠更小的字号
 * 与基线偏移表达；求和号的上下限是独立文字。
 *
 * 经验教训：靠启发式去「猜」分数 / 求和结构，在真实论文 PDF 上错得比原样提取还离谱。
 * 因此默认只做**可靠且可验证**的两件事：
 *   1. 上下标还原（字小 + 与左侧大字部件基线错位 + 水平紧邻）→ x_ri、QK^T
 *   2. 按基线重建行，保留原始阅读顺序与间距
 * 分数 / 根式 / 求和号的结构还原是实验特性，默认关闭，需要时用 PDF_MATH_STRUCT=1 打开。
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const NARY_CHARS = '∑∏∐∫∬∭∮';

/** 实验性的结构还原（\frac / \sqrt）默认开启，可用 PDF_MATH_STRUCT=0 关闭 */
const STRUCT_ENABLED = process.env.PDF_MATH_STRUCT !== '0';
/** 求和号上下限的吸收：判定条件严格，默认开启 */
const NARY_ENABLED = process.env.PDF_MATH_NARY !== '0';
const DEBUG = process.env.PDF_MATH_DEBUG === '1';

const TEX_ESCAPE = {
  '\\': '\\backslash ',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  '%': '\\%',
  _: '\\_',
  '^': '\\^{}',
  '~': '\\sim ',
};

const CHAR_NORMALIZE = {
  '−': '-',
  '\u2009': ' ',
  '\u00a0': ' ',
  '\u200b': '',
  '\uf0b7': '·',
};

function escapeTex(s) {
  let out = '';
  for (const raw of String(s)) {
    const ch = CHAR_NORMALIZE[raw] !== undefined ? CHAR_NORMALIZE[raw] : raw;
    if (TEX_ESCAPE[ch] !== undefined) out += TEX_ESCAPE[ch];
    else out += ch;
  }
  return out;
}

const plainText = (s) => {
  let out = '';
  for (const ch of String(s)) out += CHAR_NORMALIZE[ch] !== undefined ? CHAR_NORMALIZE[ch] : ch;
  return out;
};

/* --------------------------- 绘图指令里的横线 --------------------------- */

const RULE_MAX_THICKNESS = 4;
const RULE_MIN_WIDTH = 8;

/**
 * 从 pdfjs 的 OperatorList 中提取细横线（分数线、表格框线等）
 * @returns {Array<{x0:number,x1:number,y0:number,y1:number}>}
 */
export function collectRules(opList, OPS) {
  const rules = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let pending = [];

  const mul = (a, b) => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const apply = (mm, x, y) => [mm[0] * x + mm[2] * y + mm[4], mm[1] * x + mm[3] * y + mm[5]];

  const fns = opList.fnArray;
  const args = opList.argsArray;
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i];
    const a = args[i];
    if (fn === OPS.save) stack.push(m.slice());
    else if (fn === OPS.restore) m = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform && Array.isArray(a) && a.length >= 6) m = mul(m, a);
    else if (fn === OPS.constructPath) {
      const [opListInner, coords] = a;
      pending = [];
      let k = 0;
      for (const op of opListInner) {
        if (op === OPS.rectangle) {
          const [x, y, w, h] = coords.slice(k, k + 4);
          k += 4;
          const p1 = apply(m, x, y);
          const p2 = apply(m, x + w, y + h);
          pending.push({
            x0: Math.min(p1[0], p2[0]),
            x1: Math.max(p1[0], p2[0]),
            y0: Math.min(p1[1], p2[1]),
            y1: Math.max(p1[1], p2[1]),
          });
        } else if (op === OPS.moveTo || op === OPS.lineTo) k += 2;
        else if (op === OPS.curveTo) k += 6;
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) k += 4;
      }
    } else if (
      fn === OPS.fill ||
      fn === OPS.eoFill ||
      fn === OPS.stroke ||
      fn === OPS.fillStroke ||
      fn === OPS.eoFillStroke
    ) {
      for (const r of pending) {
        const w = r.x1 - r.x0;
        const h = r.y1 - r.y0;
        if (w >= RULE_MIN_WIDTH && h <= RULE_MAX_THICKNESS) rules.push(r);
      }
      pending = [];
    }
  }
  return rules;
}

/* ------------------------------ 部件 ------------------------------ */

function textParts(items) {
  return items.map((it) => ({
    kind: 'text',
    x0: it.x,
    x1: it.x + it.w,
    y: it.y,
    h: it.h,
    font: it.font,
    raw: it.str,
    plain: plainText(it.str),
    tex: escapeTex(it.str),
  }));
}

function wrapBase(tex) {
  const t = String(tex);
  if (/^[A-Za-z0-9]$/.test(t)) return t;
  if (/^\\[A-Za-z]+$/.test(t.trim())) return t.trim();
  return `{${t}}`;
}

/* --------------------- 上下标：字小 + 基线错位 --------------------- */

function attachScripts(parts, mainH) {
  const sorted = [...parts].sort((a, b) => a.x0 - b.x0);
  const big = sorted.filter((p) => (p.h || 0) >= mainH * 0.86);
  const consumed = new Set();

  // 先标记根指数（位于 √ 上方的小部件），避免被误挂到左边的运算符上
  const degreeSet = new Set();
  for (const p of sorted) {
    if (p.raw !== '√') continue;
    for (const q of sorted) {
      if (q === p || consumed.has(q)) continue;
      if ((q.h || 0) >= mainH * 0.86) continue;
      const qcx = (q.x0 + q.x1) / 2;
      if (qcx < p.x0 - p.h * 0.1 || qcx > p.x1 + p.h * 0.15) continue;
      const dy = q.y - p.y;
      if (dy > p.h * 0.18 && dy < p.h * 1.4) {
        degreeSet.add(q);
        p.degreeParts = p.degreeParts || [];
        p.degreeParts.push(q);
      }
    }
  }

  for (const p of sorted) {
    if ((p.h || 0) >= mainH * 0.86) continue;
    if (degreeSet.has(p) || consumed.has(p)) continue;

    let best = null;
    let bestGap = Infinity;
    for (const b of big) {
      if (b === p || consumed.has(b)) continue;
      // 运算符/分隔符不做上下标的底数（真实数学里不会出现 =_{17} 这种）
      if (/^[=+\-*/<>≥≤≠≈(),，;；:：[\]{}]+$/.test(b.raw || '')) continue;
      if (b.kind !== 'text') continue;
      // A superscript reference after prose is a citation, not a mathematical
      // exponent attached to an entire Chinese phrase.
      if (CJK_RE.test(b.raw || '') && !/^(?:\[\d+\])+$/.test(p.raw || '')) continue;
      const gap = p.x0 - b.x1;
      if (gap < -mainH * 0.2 || gap > mainH * 0.75) continue;
      const dy = p.y - b.y;
      if (dy > mainH * 0.95 || dy < -mainH * 0.95) continue;
      if (Math.abs(dy) < mainH * 0.12) continue; // 同一基线，不是上下标
      if (gap < bestGap) {
        best = b;
        bestGap = gap;
      }
    }
    if (!best) continue;

    const dy = p.y - best.y;
    if (CJK_RE.test(best.raw || '') && /^(?:\[\d+\])+$/.test(p.raw || '')) {
      best.tex += p.tex;
      best.plain += p.plain;
    } else if (dy > 0) {
      best.tex = `${wrapBase(best.tex)}^{${p.tex}}`;
      best.plain = `${best.plain}^${p.plain}`;
    } else {
      best.tex = `${wrapBase(best.tex)}_{${p.tex}}`;
      best.plain = `${best.plain}_${p.plain}`;
    }
    if (!CJK_RE.test(best.raw || '')) best.math = true;
    best.x1 = Math.max(best.x1, p.x1);
    consumed.add(p);
  }

  const rest = sorted.filter((p) => !consumed.has(p));
  for (const p of rest) if (degreeSet.has(p)) consumed.add(p);
  const kept = sorted.filter((p) => !consumed.has(p));
  return kept;
}

/* ------------------------ ∑ / ∏ / ∫ 的吸收 ------------------------ */

function absorbNary(parts, mainH) {
  const out = [];
  const consumed = new Set();

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.kind !== 'text' || !NARY_CHARS.includes(p.raw)) {
      out.push(p);
      continue;
    }
    const glyphH = p.h || 12;
    const lower = [];
    const upper = [];

    for (let j = 0; j < parts.length; j++) {
      if (i === j || consumed.has(j)) continue;
      const q = parts[j];
      if (q.kind !== 'text') continue;
      // 只有「比正文小」的部件才可能是上下限
      if ((q.h || 0) > mainH * 1.02) continue;
      const qcx = (q.x0 + q.x1) / 2;
      if (qcx < p.x0 - glyphH * 0.1 || qcx > p.x1 + glyphH * 0.1) continue;
      const dy = q.y - p.y;
      const qBottom = q.y - 0.6 * (q.h || 10);
      if (dy > glyphH * 0.18 && dy < glyphH * 1.9 && qBottom >= p.y + glyphH * 0.45) {
        upper.push({ j, q });
      } else if (dy < -glyphH * 0.18 && dy > -glyphH * 1.5) {
        lower.push({ j, q });
      }
    }

    const collect = (list) =>
      list
        .sort((a, b) => a.q.x0 - b.q.x0)
        .map(({ j, q }) => {
          consumed.add(j);
          return q;
        });

    const lowerParts = collect(lower);
    const upperParts = collect(upper);
    const cmd = p.raw === '∑' ? '\\sum' : p.raw === '∏' ? '\\prod' : '\\int';
    const subTex = lowerParts.map((q) => q.tex).join('');
    const supTex = upperParts.map((q) => q.tex).join('');
    const subPlain = lowerParts.map((q) => q.plain).join('');
    const supPlain = upperParts.map((q) => q.plain).join('');

    const xs = [p.x0, ...lowerParts.map((q) => q.x0), ...upperParts.map((q) => q.x0)];
    const xe = [p.x1, ...lowerParts.map((q) => q.x1), ...upperParts.map((q) => q.x1)];

    out.push({
      kind: 'nary',
      math: true,
      x0: Math.min(...xs),
      x1: Math.max(...xe),
      y: p.y,
      h: glyphH,
      plain: `${p.raw}${subPlain ? `_${subPlain}` : ''}${supPlain ? `^${supPlain}` : ''}`,
      tex: `${cmd}${subTex ? `_{${subTex}}` : ''}${supTex ? `^{${supTex}}` : ''}`,
    });
  }

  return out.filter((_, idx) => !consumed.has(idx));
}

/* ---------------------------- √ 的吸收 ---------------------------- */

/** √ 的吸收（按行内处理，避免跨行误吞） */
function absorbRadicalsInRow(parts, mainH) {
  const out = [...parts].sort((a, b) => a.x0 - b.x0);
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    if (p.raw !== '√') continue;

    const radicand = [];
    const radH = p.h || mainH;
    let j = i + 1;
    let prevEnd = p.x1;
    while (j < out.length) {
      const q = out[j];
      if (q.kind !== 'text') break;
      if (CJK_RE.test(q.raw) || /^[=,，。；;:：]$/.test(q.raw)) break;
      if (q.x0 - prevEnd > radH * 0.42) break;
      radicand.push(q);
      prevEnd = Math.max(prevEnd, q.x1);
      j += 1;
    }
    if (!radicand.length) continue;

    const degTex = (p.degreeParts || []).map((q) => q.tex).join('');
    const bodyTex = radicand.map((q) => q.tex).join('');
    const bodyPlain = radicand.map((q) => q.plain).join('');
    out[i] = {
      ...p,
      kind: 'sqrt',
      math: true,
      plain: `√(${bodyPlain})`,
      tex: `\\sqrt${degTex ? `[${degTex}]` : ''}{${bodyTex}}`,
    };
    out.splice(i + 1, radicand.length);
  }
  return out;
}

/* ------------------------------ 行 ------------------------------ */

function clusterRows(parts) {
  const sorted = [...parts].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const rows = [];
  let cur = null;
  for (const p of sorted) {
    const tol = Math.max(1.6, 0.34 * Math.max(p.h || 0, cur ? cur.h : 0));
    if (!cur || Math.abs(p.y - cur.y) > tol) {
      cur = { y: p.y, h: p.h || 0, parts: [p] };
      rows.push(cur);
    } else {
      cur.parts.push(p);
      if ((p.h || 0) > cur.h) {
        cur.h = p.h || 0;
        cur.y = p.y;
      }
    }
  }
  for (const r of rows) normalizeRow(r);
  return rows;
}

function normalizeRow(r) {
  r.parts.sort((a, b) => a.x0 - b.x0);
  r.x0 = Math.min(...r.parts.map((p) => p.x0));
  r.x1 = Math.max(...r.parts.map((p) => p.x1));
}

/** 行渲染：正文原样，数学部件用 $...$ 包裹 */
function renderRow(row, mainH) {
  let text = '';
  let tex = '';
  let prev = null;
  for (const p of row.parts) {
    const isMathPart = p.math === true || p.kind !== 'text';
    if (prev) {
      const gap = p.x0 - prev.x1;
      const needSpace =
        gap > Math.max(1.0, 0.22 * mainH) && !CJK_RE.test(prev.plain.slice(-1)) && !CJK_RE.test(p.plain.charAt(0));
      if (needSpace) {
        text += ' ';
        tex += ' ';
      }
    }
    text += isMathPart ? `$${p.tex}$` : p.plain;
    tex += p.tex;
    prev = p;
  }
  return {
    text: text.replace(/\s{2,}/g, ' ').trim(),
    tex: tex.replace(/\s{2,}/g, ' ').trim(),
  };
}

/* ------------------------- 分数线 → \frac ------------------------- */

function applyFractions(rows, rules, mainH) {
  let list = rows.filter((r) => r.parts.length);
  const used = new Set();

  const sortedRules = [...rules].sort((a, b) => b.y0 - a.y0);
  for (const rule of sortedRules) {
    const rw = rule.x1 - rule.x0;
    if (rw < 6) continue;
    const alive = list.filter((r) => !used.has(r));
    // 真正的分式：上下两行都落在横线跨度内，且宽度与横线相当（不是一整行正文）
    const inside = (r) => r.x0 >= rule.x0 - rw * 0.3 && r.x1 <= rule.x1 + rw * 0.3;
    const narrow = (r) => r.x1 - r.x0 <= rw * 1.8;

    const above = alive
      .filter((r) => r.y > rule.y1 && r.y - rule.y1 < mainH * 2.6 && inside(r) && narrow(r))
      .sort((a, b) => a.y - b.y)[0];
    const below = alive
      .filter((r) => r.y < rule.y0 && rule.y0 - r.y < mainH * 2.8 && inside(r) && narrow(r))
      .sort((a, b) => b.y - a.y)[0];
    if (!above || !below || above === below) continue;
    const fractionText = [...above.parts, ...below.parts].map((p) => p.plain).join('');
    if ((fractionText.match(/[\u4e00-\u9fff]/g) || []).length >= 2) continue;
    if (rw > mainH * 20) continue; // table borders and underlines are not fraction bars

    const host = alive
      .filter(
        (r) =>
          r !== above &&
          r !== below &&
          r.y <= above.y + mainH * 0.5 &&
          r.y >= below.y - mainH * 0.5 &&
          r.x0 < rule.x0 + rw * 0.2 &&
          r.x1 > rule.x1 - rw * 0.2,
      )
      .sort((a, b) => Math.abs(a.y - rule.y0) - Math.abs(b.y - rule.y0))[0];

    const numTex = renderRow(above, mainH).tex;
    const denTex = renderRow(below, mainH).tex;
    const frac = {
      kind: 'frac',
      math: true,
      x0: Math.min(rule.x0, above.x0, below.x0),
      x1: Math.max(rule.x1, above.x1, below.x1),
      y: host ? host.y : rule.y0,
      h: mainH,
      plain: `(${above.parts.map((p) => p.plain).join('')})/(${below.parts.map((p) => p.plain).join('')})`,
      tex: `\\frac{${numTex}}{${denTex}}`,
    };

    used.add(above);
    used.add(below);
    if (host) host.parts.push(frac);
    else list.push({ y: rule.y0, h: mainH, parts: [frac], x0: frac.x0, x1: frac.x1 });
  }

  list = list.filter((r) => !used.has(r));
  for (const r of list) {
    if (r.parts.some((p) => p.kind === 'frac')) normalizeRow(r);
  }
  return list;
}

/* --------------------------- 数学行判定 --------------------------- */

const MATHY = /[=≥≤≠≈±×÷∑∏∫√^_]/;

function isMathRow(row) {
  const plain = row.parts.map((p) => p.plain).join('').trim();
  if (!plain) return false;
  const cjk = (plain.match(/[\u4e00-\u9fff]/g) || []).length;
  // 中文占比高 → 是正文（可能含行内公式），不是整行公式
  if (cjk / plain.length > 0.22) return false;
  const tex = row.parts.map((p) => p.tex).join('');
  if (/\\frac|\\sqrt|\\sum|\\prod|\\int/.test(tex)) return true;
  if (cjk >= 2) return false;
  const mathChars = (plain.match(/[0-9A-Za-z_^()[\]{}=+\-*/<>.,]/g) || []).length;
  return mathChars / plain.length > 0.75 && MATHY.test(plain);
}

/* ------------------------------ 入口 ------------------------------ */

/**
 * @param {Array} items  文字项 {str,x,y,w,h,font}
 * @param {Array} rules  细横线 {x0,x1,y0,y1}
 * @param {{ mainH?: number }} [opts]
 * @returns {Array<{text,tex,rich,isMath,x0,x1,y,h,bold}>}
 */
export function buildMathAwareLines(items, rules = [], opts = {}) {
  if (!items.length) return [];
  const heights = items.map((i) => i.h).filter((h) => h > 0).sort((a, b) => a - b);
  const mainH = opts.mainH || heights[Math.floor(heights.length / 2)] || 10;

  let parts = textParts(items);

  // 可靠：上下标还原
  parts = attachScripts(parts, mainH);

  // 求和号上下限吸收（严格判定，默认开启）
  if (NARY_ENABLED) parts = absorbNary(parts, mainH);

  let rows = clusterRows(parts);

  // 实验：根式 / 分式结构还原（行内 / 行间判定，默认开启，可用 PDF_MATH_STRUCT=0 关闭）
  if (STRUCT_ENABLED) {
    for (const r of rows) {
      r.parts = absorbRadicalsInRow(r.parts, mainH);
      normalizeRow(r);
    }
    if (rules.length) rows = applyFractions(rows, rules, mainH);
  }
  rows.sort((a, b) => b.y - a.y || a.x0 - b.x0);

  const lines = [];
  for (const row of rows) {
    const rendered = renderRow(row, mainH);
    if (!rendered.text) continue;
    lines.push({
      text: rendered.text,
      tex: rendered.tex,
      rich: /\$/.test(rendered.text),
      isMath: isMathRow(row),
      x0: row.x0,
      x1: row.x1,
      y: row.y,
      h: row.h,
      bold: row.parts.some((p) => /bold|heavy|black|semibold/i.test(p.font || '')),
      cells: (() => {
        const cells = [];
        let cell;
        for (const part of row.parts) {
          if (!cell || part.x0 - cell.x1 > Math.max(10, mainH * 1.1)) {
            cell = { x: part.x0, x1: part.x1, text: part.plain };
            cells.push(cell);
          } else { cell.text += part.plain; cell.x1 = part.x1; }
        }
        return cells;
      })(),
    });
  }
  return lines;
}
