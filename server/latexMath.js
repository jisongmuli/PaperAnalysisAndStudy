/**
 * LaTeX 子集 → docx 数学组件（OMML）
 * 覆盖本项目的 OMML→LaTeX 反向输出：分数、上下标、根式、求和/积分、括号、
 * 以及常用符号与希腊字母。解析失败时安全退化为纯文本 MathRun。
 */
import {
  MathRun,
  MathFraction,
  MathSuperScript,
  MathSubScript,
  MathSubSuperScript,
  MathRadical,
  MathSum,
  MathIntegral,
  MathRoundBrackets,
  MathSquareBrackets,
  MathCurlyBrackets,
} from 'docx';

const SYMBOLS = {
  ge: '≥',
  le: '≤',
  ne: '≠',
  approx: '≈',
  equiv: '≡',
  simeq: '≃',
  sim: '∼',
  propto: '∝',
  pm: '±',
  mp: '∓',
  times: '×',
  div: '÷',
  cdot: '⋅',
  ast: '∗',
  star: '⋆',
  circ: '∘',
  oplus: '⊕',
  otimes: '⊗',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  in: '∈',
  notin: '∉',
  ni: '∋',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  supseteq: '⊇',
  cup: '∪',
  cap: '∩',
  emptyset: '∅',
  forall: '∀',
  exists: '∃',
  neg: '¬',
  wedge: '∧',
  vee: '∨',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  mapsto: '↦',
  uparrow: '↑',
  downarrow: '↓',
  dots: '…',
  ldots: '…',
  cdots: '⋯',
  vdots: '⋮',
  ddots: '⋱',
  angle: '∠',
  perp: '⊥',
  parallel: '∥',
  cong: '≅',
  ll: '≪',
  gg: '≫',
  backslash: '\\',
  lbrace: '{',
  rbrace: '}',
  '%': '%',
  '&': '&',
  '#': '#',
  _: '_',
  $: '$',
  '{': '{',
  '}': '}',
  quad: ' ',
  qquad: ' ',
  ',': ' ',
  ';': ' ',
  ':': ' ',
  '!': '',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  varepsilon: 'ε',
  epsilon: 'ϵ',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  varphi: 'φ',
  phi: 'ϕ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
};

const BLACKBOARD = {
  R: 'ℝ',
  N: 'ℕ',
  Z: 'ℤ',
  Q: 'ℚ',
  C: 'ℂ',
};

class Parser {
  constructor(src) {
    this.s = String(src || '');
    this.i = 0;
    this.depth = 0;
  }

  eof() {
    return this.i >= this.s.length;
  }

  peek() {
    return this.s[this.i];
  }

  skipWs() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i += 1;
  }

  /** 解析到 stop 集合中的字符为止 */
  parseSeq(stop) {
    const out = [];
    this.depth += 1;
    if (this.depth > 40) return out;
    while (true) {
      this.skipWs();
      if (this.eof()) break;
      const ch = this.peek();
      if (stop && stop.includes(ch)) break;
      if (this.s.startsWith('\\right', this.i)) break;
      const unit = this.parseUnit(stop);
      if (!unit.length) {
        if (this.i < this.s.length) this.i += 1;
        continue;
      }
      out.push(...unit);
    }
    this.depth -= 1;
    return out;
  }

  parseUnit(stop) {
    const base = this.parseAtom(stop);
    let sub = null;
    let sup = null;
    while (true) {
      this.skipWs();
      const ch = this.peek();
      if (ch === '_' || ch === '^') {
        this.i += 1;
        this.skipWs();
        const arg = this.parseAtom(stop);
        if (ch === '_') sub = arg;
        else sup = arg;
      } else if (this.s.startsWith('\\limits', this.i)) {
        this.i += '\\limits'.length;
      } else {
        break;
      }
    }
    if (sub && sup) {
      return [new MathSubSuperScript({ children: base, subScript: sub, superScript: sup })];
    }
    if (sub) return [new MathSubScript({ children: base, subScript: sub })];
    if (sup) return [new MathSuperScript({ children: base, superScript: sup })];
    return base;
  }

  parseAtom(stop) {
    this.skipWs();
    if (this.eof()) return [];
    const ch = this.peek();

    if (ch === '{') {
      this.i += 1;
      const inner = this.parseSeq('}');
      if (this.peek() === '}') this.i += 1;
      return inner;
    }
    if (ch === '\\') return this.parseCommand(stop);
    if (ch === '}') return [];

    // 连续普通字符
    let str = '';
    while (!this.eof()) {
      const c = this.peek();
      if ('\\{}_^'.includes(c)) break;
      if (stop && stop.includes(c)) break;
      str += c;
      this.i += 1;
    }
    const text = str.replace(/\s+/g, ' ').trim();
    return text ? [new MathRun(text)] : [];
  }

  readGroupOrAtom(stop) {
    return this.parseAtom(stop);
  }

  parseCommand(stop) {
    this.i += 1; // 跳过反斜杠
    let name = '';
    while (!this.eof() && /[A-Za-z]/.test(this.peek())) {
      name += this.peek();
      this.i += 1;
    }
    if (!name) {
      // \,  \;  \{  \}  \%
      const ch = this.peek();
      this.i += 1;
      const mapped = SYMBOLS[ch];
      return [new MathRun(mapped !== undefined ? mapped : ch)];
    }

    switch (name) {
      case 'frac': {
        const num = this.readGroupOrAtom(stop);
        this.skipWs();
        const den = this.readGroupOrAtom(stop);
        return [new MathFraction({ numerator: num, denominator: den })];
      }
      case 'sqrt': {
        this.skipWs();
        let degree = null;
        let degreeText = '';
        if (this.peek() === '[') {
          this.i += 1;
          const start = this.i;
          degree = this.parseSeq(']');
          degreeText = this.s.slice(start, this.i).trim();
          if (this.peek() === ']') this.i += 1;
        }
        const body = this.readGroupOrAtom(stop);
        // 二次根式的「2」在 Word/LibreOffice 中会多渲染一个占位框，直接省略
        const useDegree = Boolean(degree && degreeText && degreeText !== '2');
        return [new MathRadical(useDegree ? { children: body, degree } : { children: body })];
      }
      case 'sum':
      case 'prod':
      case 'coprod': {
        const { sub, sup } = this.readLimits(stop);
        const operand = this.readOperand(stop);
        // MathSum 自身绘制 ∑/∏，children 即被求和的项（对应 OMML 的 m:e）
        return [
          new MathSum({
            children: operand,
            ...(sub ? { subScript: sub } : {}),
            ...(sup ? { superScript: sup } : {}),
          }),
        ];
      }
      case 'int':
      case 'iint':
      case 'iiint':
      case 'oint': {
        const { sub, sup } = this.readLimits(stop);
        const operand = this.readOperand(stop);
        return [
          new MathIntegral({
            children: operand,
            ...(sub ? { subScript: sub } : {}),
            ...(sup ? { superScript: sup } : {}),
          }),
        ];
      }
      case 'left': {
        this.skipWs();
        const open = this.peek();
        this.i += 1;
        const inner = this.parseSeq(null);
        // 跳过 \right 与闭合符
        if (this.s.startsWith('\\right', this.i)) {
          this.i += '\\right'.length;
          this.skipWs();
          if (!this.eof()) this.i += 1;
        }
        if (open === '.' || open === '') return inner;
        if (open === '(') return [new MathRoundBrackets({ children: inner })];
        if (open === '[') return [new MathSquareBrackets({ children: inner })];
        if (open === '{' || open === '\\') return [new MathCurlyBrackets({ children: inner })];
        return [new MathRun(delimChar(open)), ...inner, new MathRun(delimChar(open, true))];
      }
      case 'operatorname':
      case 'mathrm':
      case 'text':
      case 'mathbf':
      case 'mathit': {
        this.skipWs();
        const inner = this.readGroupOrAtom(stop);
        return inner;
      }
      case 'mathbb': {
        this.skipWs();
        const inner = this.readGroupOrAtom(stop);
        // 尝试把 R/N/Z/Q/C 变成黑板体字符
        const plain = inner.map((c) => (c && c.text ? c.text : '')).join('');
        if (plain.length === 1 && BLACKBOARD[plain]) return [new MathRun(BLACKBOARD[plain])];
        return inner;
      }
      case 'hat':
      case 'tilde':
      case 'bar':
      case 'vec':
      case 'dot':
      case 'ddot':
      case 'overline':
      case 'underline':
      case 'underbrace':
      case 'overbrace':
      case 'phantom':
      case 'overset': {
        // 装饰结构：保留内容，忽略装饰
        this.skipWs();
        const first = this.readGroupOrAtom(stop);
        if (name === 'overset') {
          this.skipWs();
          return this.readGroupOrAtom(stop);
        }
        return first;
      }
      case 'begin':
      case 'end': {
        // 矩阵/方程组：读掉环境名，内容按顺序展开
        this.skipWs();
        const env = this.parseSeq('}');
        void env;
        return [];
      }
      default: {
        if (SYMBOLS[name] !== undefined) return [new MathRun(SYMBOLS[name])];
        // 未知命令：按普通文本输出命令名，避免整条公式丢失
        return [new MathRun(name)];
      }
    }
  }

  readLimits(stop) {
    let sub = null;
    let sup = null;
    while (true) {
      this.skipWs();
      if (this.s.startsWith('\\limits', this.i)) {
        this.i += '\\limits'.length;
        continue;
      }
      const ch = this.peek();
      if (ch === '_' || ch === '^') {
        this.i += 1;
        this.skipWs();
        const arg = this.readGroupOrAtom(stop);
        if (ch === '_') sub = arg;
        else sup = arg;
      } else break;
    }
    return { sub, sup };
  }

  /** 取紧随其后的一个「单元」作为 nary 的被运算项（与 OMML 的 m:e 对应） */
  readOperand(stop) {
    this.skipWs();
    if (this.eof()) return [];
    const ch = this.peek();
    if (ch === '}' || (stop && stop.includes(ch))) return [];
    if (this.s.startsWith('\\right', this.i) || this.s.startsWith('\\end', this.i)) return [];
    try {
      return this.parseUnit(stop);
    } catch {
      return [];
    }
  }
}

function delimChar(ch, closing = false) {
  if (ch === '.') return '';
  if (ch === '\\') return closing ? '}' : '{';
  return ch;
}

/**
 * LaTeX → docx Math 组件数组
 * @param {string} tex
 * @returns {Array} MathComponent[]
 */
export function latexToMathComponents(tex) {
  const source = String(tex || '').trim();
  if (!source) return [new MathRun('')];
  try {
    const p = new Parser(source);
    const out = p.parseSeq(null);
    return out.length ? out : [new MathRun(source)];
  } catch {
    return [new MathRun(source)];
  }
}
