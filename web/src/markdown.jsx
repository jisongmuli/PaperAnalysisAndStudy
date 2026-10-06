import React, { createContext, useContext, useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

/** 轻量 Markdown 渲染（无第三方依赖，输出 React 节点，不注入 HTML）；
 *  数学公式用 KaTeX 渲染，支持 $...$、$$...$$、\(...\)、\[...\]。 */

const INLINE_RE =
  /(`[^`]+`|\$\$[^$]+\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;

export const CitationContext = createContext(null);

/** 用 KaTeX 渲染 TeX；失败时回退为等宽原文 */
function renderTex(tex, displayMode) {
  const source = String(tex || '').trim();
  if (!source) return null;
  try {
    return katex.renderToString(source, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      errorColor: '#dc2626',
      macros: { '\\RR': '\\mathbb{R}' },
    });
  } catch {
    return null;
  }
}

function MathSpan({ tex, display }) {
  const html = useMemo(() => renderTex(tex, display), [tex, display]);
  if (!html) {
    return <code className="math-fallback">{tex}</code>;
  }
  return (
    <span
      className={display ? 'math-display' : 'math-inline'}
      // 内容由 KaTeX 从本地方案生成，不接受外部 HTML
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function renderInlineBase(text, keyPrefix = 'i') {
  const nodes = [];
  let last = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${m.index}`;
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('$$')) {
      nodes.push(<MathSpan key={key} tex={token.slice(2, -2)} display />);
    } else if (token.startsWith('$')) {
      nodes.push(<MathSpan key={key} tex={token.slice(1, -1)} display={false} />);
    } else if (token.startsWith('\\(')) {
      nodes.push(<MathSpan key={key} tex={token.slice(2, -2)} display={false} />);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (mm && /^(https?:|mailto:)/i.test(mm[2])) {
        nodes.push(
          <a key={key} href={mm[2]} target="_blank" rel="noreferrer noopener">
            {mm[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export default function Markdown({ text, className = '', allowedParagraphIds }) {
  const citation = useContext(CitationContext);
  const renderInline = (value, prefix) => {
    if (!citation) return renderInlineBase(value, prefix);
    // Parse citations only in plain text nodes, never inside code or math.
    return renderInlineBase(value, prefix).flatMap((node, i) => {
      if (typeof node !== 'string') return [node];
      return node.split(/(\[第\s*\d+\s*段\])/g).map((piece, j) => {
        const match = /^\[第\s*(\d+)\s*段\]$/.exec(piece);
        if (!match) return piece;
        const number = Number(match[1]);
        const p = citation.allParagraphs?.[number - 1];
        if (!p || !allowedParagraphIds?.includes(p.id)) return piece;
        return <button key={`${prefix}-${i}-${j}`} className="source-citation" onClick={() => citation.onCitation(number)} title={`定位原文第 ${number} 段`}>{piece}</button>;
      });
    });
  };
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const blocks = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块（优先，内部不做任何解析）
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={`b${k++}`} className="md-code">
          {lang ? <span className="md-code-lang">{lang}</span> : null}
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // 块级公式 $$ ... $$（可跨行）
    if (/^\s*\$\$/.test(line)) {
      const buf = [];
      let rest = line.replace(/^\s*\$\$/, '');
      if (/\$\$\s*$/.test(rest)) {
        buf.push(rest.replace(/\$\$\s*$/, ''));
        i += 1;
      } else {
        buf.push(rest);
        i += 1;
        while (i < lines.length && !/\$\$\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) {
          buf.push(lines[i].replace(/\$\$\s*$/, ''));
          i += 1;
        }
      }
      blocks.push(
        <div key={`b${k++}`} className="md-math-block">
          <MathSpan tex={buf.join('\n')} display />
        </div>,
      );
      continue;
    }

    // 块级公式 \[ ... \]
    if (/^\s*\\\[/.test(line)) {
      const buf = [];
      let rest = line.replace(/^\s*\\\[/, '');
      if (/\\\]\s*$/.test(rest)) {
        buf.push(rest.replace(/\\\]\s*$/, ''));
        i += 1;
      } else {
        buf.push(rest);
        i += 1;
        while (i < lines.length && !/\\\]\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) {
          buf.push(lines[i].replace(/\\\]\s*$/, ''));
          i += 1;
        }
      }
      blocks.push(
        <div key={`b${k++}`} className="md-math-block">
          <MathSpan tex={buf.join('\n')} display />
        </div>,
      );
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <div className="md-table-wrap" key={`b${k++}`}>
          <table className="md-table">
            <thead>
              <tr>
                {head.map((c, ci) => (
                  <th key={ci}>{renderInline(c, `th${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{renderInline(c, `td${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = `h${Math.min(6, h[1].length + 2)}`;
      blocks.push(React.createElement(Tag, { key: `b${k++}`, className: 'md-h' }, renderInline(h[2], `h${k}`)));
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={`b${k++}`} />);
      i += 1;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push(<blockquote key={`b${k++}`}>{renderInline(buf.join(' '), `q${k}`)}</blockquote>);
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        i += 1;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        React.createElement(
          Tag,
          { key: `b${k++}`, className: 'md-list' },
          items.map((t, idx) => <li key={idx}>{renderInline(t, `li${k}-${idx}`)}</li>),
        ),
      );
      continue;
    }

    // 空行
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // 普通段落（连续行合并）
    const buf = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\$\$|\\\[)/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={`b${k++}`} className="md-p">
        {buf.map((t, idx) => (
          <React.Fragment key={idx}>
            {idx > 0 ? <br /> : null}
            {renderInline(t, `p${k}-${idx}`)}
          </React.Fragment>
        ))}
      </p>,
    );
  }

  return <div className={`markdown ${className}`.trim()}>{blocks}</div>;
}
