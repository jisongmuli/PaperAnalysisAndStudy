import React, { useLayoutEffect, useRef, useState } from 'react';
import Markdown from '../markdown.jsx';

const COLLAPSE_HEIGHT = 320;

/**
 * 可折叠的回答正文：
 * - 内容超过阈值时在底部提供「收起 / 展开全文」
 * - 可通过 collapsed / onToggle 受控（用于「全部折叠」），也可独立自控
 */
export default function FoldableAnswer({
  text,
  streaming = false,
  collapsed,
  onToggle,
  className = '',
  allowedParagraphIds,
}) {
  const [internal, setInternal] = useState(false);
  const controlled = typeof collapsed === 'boolean';
  const folded = controlled ? collapsed : internal;

  const innerRef = useRef(null);
  const [tall, setTall] = useState(false);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    // scrollHeight 不受父级 max-height 影响，折叠状态下同样能量出完整高度
    setTall(el.scrollHeight > COLLAPSE_HEIGHT);
  }, [text]);

  const toggle = () => {
    if (controlled) onToggle?.();
    else setInternal((v) => !v);
  };

  const chars = String(text || '').length;

  return (
    <div className={`answer ${folded ? 'folded' : ''} ${className}`.trim()}>
      <div className="answer-body">
        <div className="answer-inner" ref={innerRef}>
          <Markdown text={text} allowedParagraphIds={allowedParagraphIds} />
        </div>
      </div>
      {(tall || folded) && !streaming ? (
        <button type="button" className="fold-btn" onClick={toggle}>
          {folded ? (
            <>
              展开全文 <span className="fold-hint">{chars} 字</span>
            </>
          ) : (
            <>收起</>
          )}
        </button>
      ) : null}
    </div>
  );
}
