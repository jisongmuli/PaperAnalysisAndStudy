/**
 * OMML（Office Math Markup Language）→ LaTeX
 * 覆盖 Word 公式编辑器中最常用的结构：分数、上下标、根式、求和/积分、
 * 括号定界、函数、极限、重音、上划线、矩阵、方程组等。
 */

const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/* ------------------------------ 工具 ------------------------------ */

const el = (n) => n && n.nodeType === 1;
const local = (n) => (n.localName || n.nodeName || '').replace(/^.*:/, '');
const kids = (n) => {
  const out = [];
  if (!n || !n.childNodes) return out;
  for (let i = 0; i < n.childNodes.length; i++) {
    if (el(n.childNodes[i])) out.push(n.childNodes[i]);
  }
  return out;
};
const child = (n, name) => kids(n).find((c) => local(c) === name);
const childAll = (n, name) => kids(n).filter((c) => local(c) === name);
const textOf = (n) => {
  let s = '';
  if (!n) return s;
  if (n.nodeType === 3 || n.nodeType === 4) return n.nodeValue || '';
  for (let i = 0; i < n.childNodes.length; i++) s += textOf(n.childNodes[i]);
  return s;
};
const attr = (n, name) => {
  if (!n || !n.attributes) return null;
  for (let i = 0; i < n.attributes.length; i++) {
    const a = n.attributes[i];
    if (local(a) === name) return a.value;
  }
  return null;
};
/** 取 m:val（属性名在 OMML 里写作 m:val，xmldom 会暴露为 val） */
const mval = (n) => attr(n, 'val');

/* --------------------------- 字符映射 --------------------------- */

const SYMBOLS = {
  '∑': '\\sum',
  '∏': '\\prod',
  '∐': '\\coprod',
  '∫': '\\int',
  '∬': '\\iint',
  '∭': '\\iiint',
  '∮': '\\oint',
  '≤': '\\le',
  '≥': '\\ge',
  '≠': '\\ne',
  '≈': '\\approx',
  '≡': '\\equiv',
  '≃': '\\simeq',
  '∼': '\\sim',
  '∝': '\\propto',
  '±': '\\pm',
  '∓': '\\mp',
  '×': '\\times',
  '÷': '\\div',
  '⋅': '\\cdot',
  '∗': '\\ast',
  '⋆': '\\star',
  '∘': '\\circ',
  '⊕': '\\oplus',
  '⊗': '\\otimes',
  '∞': '\\infty',
  '∂': '\\partial',
  '∇': '\\nabla',
  '∈': '\\in',
  '∉': '\\notin',
  '∋': '\\ni',
  '⊂': '\\subset',
  '⊆': '\\subseteq',
  '⊃': '\\supset',
  '⊇': '\\supseteq',
  '∪': '\\cup',
  '∩': '\\cap',
  '∅': '\\emptyset',
  '∀': '\\forall',
  '∃': '\\exists',
  '¬': '\\neg',
  '∧': '\\wedge',
  '∨': '\\vee',
  '→': '\\to',
  '←': '\\leftarrow',
  '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow',
  '⇐': '\\Leftarrow',
  '⇔': '\\Leftrightarrow',
  '↦': '\\mapsto',
  '↑': '\\uparrow',
  '↓': '\\downarrow',
  '…': '\\dots',
  '⋯': '\\cdots',
  '⋮': '\\vdots',
  '⋱': '\\ddots',
  '′': "'",
  '″': "''",
  '√': '\\sqrt ',
  '∛': '\\sqrt[3] ',
  '∠': '\\angle',
  '⊥': '\\perp',
  '∥': '\\parallel',
  '≅': '\\cong',
  '≪': '\\ll',
  '≫': '\\gg',
  'ℝ': '\\mathbb{R}',
  'ℕ': '\\mathbb{N}',
  'ℤ': '\\mathbb{Z}',
  'ℚ': '\\mathbb{Q}',
  'ℂ': '\\mathbb{C}',
  'α': '\\alpha',
  'β': '\\beta',
  'γ': '\\gamma',
  'δ': '\\delta',
  'ε': '\\varepsilon',
  'ϵ': '\\epsilon',
  'ζ': '\\zeta',
  'η': '\\eta',
  'θ': '\\theta',
  'ι': '\\iota',
  'κ': '\\kappa',
  'λ': '\\lambda',
  'μ': '\\mu',
  'ν': '\\nu',
  'ξ': '\\xi',
  'π': '\\pi',
  'ρ': '\\rho',
  'σ': '\\sigma',
  'ς': '\\varsigma',
  'τ': '\\tau',
  'υ': '\\upsilon',
  'φ': '\\varphi',
  'ϕ': '\\phi',
  'χ': '\\chi',
  'ψ': '\\psi',
  'ω': '\\omega',
  'Γ': '\\Gamma',
  'Δ': '\\Delta',
  'Θ': '\\Theta',
  'Λ': '\\Lambda',
  'Ξ': '\\Xi',
  'Π': '\\Pi',
  'Σ': '\\Sigma',
  'Υ': '\\Upsilon',
  'Φ': '\\Phi',
  'Ψ': '\\Psi',
  'Ω': '\\Omega',
  '\u2212': '-',
  '\u00a0': ' ',
  '\u2009': '\\,',
  '\u200b': '',
};

const escapeTex = (s) =>
  String(s)
    .split('')
    .map((ch) => {
      if (SYMBOLS[ch] !== undefined) return SYMBOLS[ch];
      if (ch === '\\') return '\\backslash ';
      if ('{}'.includes(ch)) return `\\${ch}`;
      if ('$&#%'.includes(ch)) return `\\${ch}`;
      if (ch === '_') return '\\_';
      if (ch === '^') return '\\^{}';
      if (ch === '~') return '\\sim ';
      return ch;
    })
    .join('');

const NAMED_OPS = new Set([
  'lim',
  'max',
  'min',
  'sup',
  'inf',
  'log',
  'ln',
  'lg',
  'exp',
  'sin',
  'cos',
  'tan',
  'cot',
  'sec',
  'csc',
  'arcsin',
  'arccos',
  'arctan',
  'sinh',
  'cosh',
  'tanh',
  'det',
  'dim',
  'ker',
  'deg',
  'gcd',
  'arg',
  'Pr',
]);

const ACCENTS = {
  '\u0302': '\\hat',
  '^': '\\hat',
  '\u0303': '\\tilde',
  '~': '\\tilde',
  '\u0304': '\\bar',
  '\u00af': '\\bar',
  '\u0305': '\\bar',
  '\u0307': '\\dot',
  '\u02d9': '\\dot',
  '\u0308': '\\ddot',
  '\u0301': '\\acute',
  '\u0300': '\\grave',
  '\u030c': '\\check',
  '\u0306': '\\breve',
  '\u20d7': '\\vec',
  '\u20db': '\\dddot',
};

/* --------------------------- 主转换器 --------------------------- */

/**
 * 把一个 OMML 片段（m:oMath / m:oMathPara 或任意子节点）转成 LaTeX
 * @param {Node} node
 * @param {{ display?: boolean }} [opts]
 */
export function ommlToLatex(node, opts = {}) {
  const body = convert(node).replace(/\s+/g, ' ').trim();
  if (!body) return '';
  return opts.display ? body : body;
}

/** 判断节点是否属于 OMML 命名空间 */
export function isOmml(node) {
  return el(node) && (node.namespaceURI === M_NS || local(node).startsWith('oMath'));
}

function convert(node) {
  if (!node) return '';
  return kids(node).map(convertNode).join('');
}

function convertNode(n) {
  const name = local(n);

  if (n.namespaceURI === W_NS) {
    // Word 普通 run 混排进公式
    if (name === 'r') return escapeTex(runText(n));
    if (name === 't') return escapeTex(textOf(n));
    if (name === 'br') return ' ';
    if (name === 'tab') return '\\quad ';
    return '';
  }

  switch (name) {
    case 'oMath':
    case 'oMathPara':
    case 'e':
    case 'num':
    case 'den':
    case 'sup':
    case 'sub':
    case 'fName':
    case 'lim':
    case 'deg':
    case 'box':
    case 'borderBox':
    case 'sdt':
    case 'sdtContent':
    case 'argPr':
      return convert(n);

    case 'r':
      return escapeTex(runText(n));

    case 't':
      return escapeTex(textOf(n));

    case 'f':
      return frac(n);

    case 'sSup':
      return `${wrap(child(n, 'e'))}^{${convert(child(n, 'sup'))}}`;

    case 'sSub':
      return `${wrap(child(n, 'e'))}_{${convert(child(n, 'sub'))}}`;

    case 'sSubSup':
      return `${wrap(child(n, 'e'))}_{${convert(child(n, 'sub'))}}^{${convert(child(n, 'sup'))}}`;

    case 'sPre': {
      const e = convert(child(n, 'e'));
      const sub = convert(child(n, 'sub'));
      const sup = convert(child(n, 'sup'));
      return `{}_{${sub}}^{${sup}}${wrap2(e)}`;
    }

    case 'rad':
      return rad(n);

    case 'd':
      return delimiters(n);

    case 'nary':
      return nary(n);

    case 'func':
      return func(n);

    case 'limLow': {
      const base = convert(child(n, 'e'));
      const lim = convert(child(n, 'lim'));
      const bare = base.trim();
      if (NAMED_OPS.has(bare)) return `\\${bare}_{${lim}}`;
      return `${wrap2(base)}_{${lim}}`;
    }

    case 'limUpp': {
      const base = convert(child(n, 'e'));
      const lim = convert(child(n, 'lim'));
      return `\\overset{${lim}}{${base}}`;
    }

    case 'acc':
      return accent(n);

    case 'bar':
      return bar(n);

    case 'groupChr':
      return groupChr(n);

    case 'm':
      return matrix(n);

    case 'eqArr':
      return eqArr(n);

    case 'phant':
      return `\\phantom{${convert(child(n, 'e'))}}`;

    case 'box':
      return convert(n);

    case 'brk':
      return '';

    case 'aln':
      return '&';

    // 控制属性，一律忽略
    case 'rPr':
    case 'ctrlPr':
    case 'fPr':
    case 'dPr':
    case 'naryPr':
    case 'radPr':
    case 'funcPr':
    case 'limLowPr':
    case 'limUppPr':
    case 'accPr':
    case 'barPr':
    case 'groupChrPr':
    case 'mPr':
    case 'eqArrPr':
    case 'sSupPr':
    case 'sSubPr':
    case 'sSubSupPr':
    case 'sPrePr':
    case 'phantPr':
    case 'boxPr':
    case 'borderBoxPr':
    case 'argPr':
      return '';

    default:
      // 未知元素：继续向下转换，尽量不丢内容
      return convert(n);
  }
}

/* --------------------------- 子结构实现 --------------------------- */

function runText(r) {
  let s = '';
  for (const c of kids(r)) {
    const nm = local(c);
    if (nm === 'rPr' || nm === 'ctrlPr') continue;
    if (nm === 't') s += textOf(c);
    else if (nm === 'br') s += ' ';
    else if (nm === 'tab') s += '\t';
  }
  return s;
}

/** 单符号子表达式加花括号，避免结合优先级出错 */
function wrap(n) {
  const s = convert(n);
  if (!s) return '{}';
  return /^[A-Za-z0-9]$/.test(s) ? s : `{${s}}`;
}

function wrap2(s) {
  const t = String(s || '').trim();
  if (!t) return '{}';
  return /^\\[A-Za-z]+$/.test(t) || /^[A-Za-z0-9]$/.test(t) ? t : `{${t}}`;
}

function frac(n) {
  const num = convert(child(n, 'num'));
  const den = convert(child(n, 'den'));
  if (!num && !den) {
    // Word 偶发把行内分数写成 num/den 缺失，退回斜杠形式
    return '';
  }
  return `\\frac{${num}}{${den}}`;
}

function rad(n) {
  const deg = child(n, 'deg');
  const e = convert(child(n, 'e'));
  const degTex = deg ? convert(deg).trim() : '';
  return degTex ? `\\sqrt[${degTex}]{${e}}` : `\\sqrt{${e}}`;
}

function delimiters(n) {
  const pr = child(n, 'dPr');
  let beg = '(';
  let end = ')';
  if (pr) {
    const b = child(pr, 'begChr');
    const e2 = child(pr, 'endChr');
    if (b) beg = mval(b) ?? '(';
    if (e2) end = mval(e2) ?? ')';
  }
  const parts = childAll(n, 'e').map((e) => convert(e));
  const open = beg ? `\\left${latexDelim(beg)}` : '\\left.';
  const close = end ? `\\right${latexDelim(end)}` : '\\right.';
  return `${open} ${parts.join(' \\middle| ')} ${close}`;
}

function latexDelim(ch) {
  if (!ch) return '.';
  if ('()[]|/'.includes(ch)) return ch;
  if (ch === '{') return '\\{';
  if (ch === '}') return '\\}';
  if (ch === '⟨' || ch === '〈') return '\\langle';
  if (ch === '⟩' || ch === '〉') return '\\rangle';
  if (ch === '‖' || ch === '||') return '\\|';
  if (ch === '⌊') return '\\lfloor';
  if (ch === '⌋') return '\\rfloor';
  if (ch === '⌈') return '\\lceil';
  if (ch === '⌉') return '\\rceil';
  return '\\' + ch;
}

function nary(n) {
  const pr = child(n, 'naryPr');
  let chr = '∫';
  let limLoc = null;
  if (pr) {
    const c = child(pr, 'chr');
    if (c) chr = mval(c) ?? '∫';
    const l = child(pr, 'limLoc');
    if (l) limLoc = mval(l);
  }
  const sub = child(n, 'sub');
  const sup = child(n, 'sup');
  const e = convert(child(n, 'e'));
  const op = SYMBOLS[chr] || escapeTex(chr);
  const limits = limLoc === 'undOvr' ? '\\limits' : '';
  let out = op + limits;
  if (sub) out += `_{${convert(sub)}}`;
  if (sup) out += `^{${convert(sup)}}`;
  return `${out} ${e}`;
}

function func(n) {
  const nameTex = convert(child(n, 'fName')).trim();
  const arg = convert(child(n, 'e'));
  if (NAMED_OPS.has(nameTex)) {
    return `\\${nameTex} ${arg}`;
  }
  return `${nameTex}${arg.startsWith('(') ? '' : ' '}${arg}`;
}

function accent(n) {
  const pr = child(n, 'accPr');
  let chr = '\u0302';
  if (pr) {
    const c = child(pr, 'chr');
    if (c) chr = mval(c) ?? chr;
  }
  const cmd = ACCENTS[chr] || '\\hat';
  return `${cmd}{${convert(child(n, 'e'))}}`;
}

function bar(n) {
  const pr = child(n, 'barPr');
  let pos = 'top';
  if (pr) {
    const p = child(pr, 'pos');
    if (p) pos = mval(p) ?? 'top';
  }
  const e = convert(child(n, 'e'));
  return pos === 'bot' ? `\\underline{${e}}` : `\\overline{${e}}`;
}

function groupChr(n) {
  const pr = child(n, 'groupChrPr');
  let chr = '⏟';
  let pos = 'bot';
  if (pr) {
    const c = child(pr, 'chr');
    if (c) chr = mval(c) ?? chr;
    const p = child(pr, 'pos');
    if (p) pos = mval(p) ?? pos;
  }
  const e = convert(child(n, 'e'));
  if (chr === '⏞' || pos === 'top') return `\\overbrace{${e}}`;
  return `\\underbrace{${e}}`;
}

function matrix(n) {
  const rows = childAll(n, 'mr');
  if (!rows.length) return convert(n);
  const body = rows
    .map((r) => childAll(r, 'e').map((c) => convert(c)).join(' & '))
    .join(' \\\\ ');
  return `\\begin{matrix} ${body} \\end{matrix}`;
}

function eqArr(n) {
  const rows = childAll(n, 'e');
  if (!rows.length) return convert(n);
  const body = rows.map((r) => convert(r)).join(' \\\\ ');
  return `\\begin{aligned} ${body} \\end{aligned}`;
}
