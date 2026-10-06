import React, { useEffect, useState } from 'react';
import { IconClose, IconZoom } from './Icons.jsx';

/** 图片放大查看 */
export function ImageLightbox({ src, caption, onClose }) {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    setScale(1);
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      if (e.key === '+' || e.key === '=') setScale((s) => Math.min(4, s + 0.25));
      if (e.key === '-') setScale((s) => Math.max(0.25, s - 0.25));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src, onClose]);

  return (
    <div className="lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="lightbox-bar">
        <span className="lightbox-caption">{caption}</span>
        <div className="lightbox-zoom">
          <button className="icon-btn small" onClick={() => setScale((s) => Math.max(0.25, s - 0.25))} title="缩小">
            −
          </button>
          <span className="zoom-value">{Math.round(scale * 100)}%</span>
          <button className="icon-btn small" onClick={() => setScale((s) => Math.min(4, s + 0.25))} title="放大">
            +
          </button>
          <button className="icon-btn small" onClick={() => setScale(1)} title="还原">
            <IconZoom width={15} height={15} />
          </button>
        </div>
        <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
          <IconClose />
        </button>
      </div>
      <div className="lightbox-body" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
        <img
          src={src}
          alt={caption || '图片'}
          style={{ transform: `scale(${scale})`, cursor: scale > 1 ? 'grab' : 'zoom-in' }}
          onClick={() => setScale((s) => (s >= 2 ? 1 : s + 0.5))}
        />
      </div>
    </div>
  );
}

/** PDF 原文页查看：交给浏览器内置阅读器渲染，所见即原文（公式/图表/表格都保真） */
export function PageViewer({ url, page, totalPages, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // url 形如 /api/documents/:id/file?inline=1，片段参数必须放在查询串之后
  const src = `${url}#page=${page}&view=FitH&toolbar=1`;

  return (
    <div className="lightbox page-viewer" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="lightbox-bar">
        <span className="lightbox-caption">
          原文 · 第 {page} 页{totalPages ? ` / 共 ${totalPages} 页` : ''}
        </span>
        <a className="btn small ghost" href={url} target="_blank" rel="noreferrer">
          在新窗口打开
        </a>
        <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
          <IconClose />
        </button>
      </div>
      <div className="lightbox-body page-body">
        <iframe src={src} title={`第 ${page} 页原文`} />
      </div>
    </div>
  );
}
