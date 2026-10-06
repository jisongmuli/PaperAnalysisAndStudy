import React, { useEffect, useRef, useState } from 'react';
const documents = new Map();
let engine;
async function getPdf(url) {
  if (!engine) engine = Promise.all([import('pdfjs-dist/build/pdf.mjs'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([pdf, worker]) => { pdf.GlobalWorkerOptions.workerSrc = worker.default; return pdf; });
  const pdf = await engine;
  if (!documents.has(url)) documents.set(url, pdf.getDocument({ url, isEvalSupported:false }).promise);
  return documents.get(url);
}
export default function PdfSnippet({ url, page, source, onZoom }) {
  const host = useRef(null), canvas = useRef(null);
  const [visible, setVisible] = useState(false), [status, setStatus] = useState('loading');
  useEffect(() => { const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } }, { rootMargin:'150px' }); observer.observe(host.current); return () => observer.disconnect(); }, []);
  useEffect(() => {
    if (!visible) return;
    let alive = true, task;
    (async () => {
      try {
        const doc = await getPdf(url), original = await doc.getPage(page);
        if (!alive || !canvas.current) return;
        const scale = 1.7;
        const viewport = original.getViewport({ scale });
        const x = Math.max(0, source.x0-12), y = Math.max(0, source.pageHeight-source.y1-8);
        const w = Math.min(source.pageWidth-x, source.x1-x+14), h = Math.min(source.pageHeight-y, source.y1-source.y0+18);
        const c = canvas.current; c.width = Math.ceil(w*scale); c.height = Math.ceil(h*scale);
        task = original.render({ canvasContext:c.getContext('2d'), viewport, transform:[1,0,0,1,-x*scale,-y*scale] });
        await task.promise; if (alive) setStatus('ready');
      } catch { if (alive) setStatus('error'); }
    })();
    return () => { alive = false; task?.cancel(); };
  }, [visible, url, page, source]);
  return <div className="pdf-snippet" ref={host}><div className="snippet-label"><span>原 PDF 截图 · 第 {page} 页</span>{status === 'ready' ? <button className="mini" onClick={() => onZoom?.(canvas.current.toDataURL(), '第 '+page+' 页原始内容')}>放大</button> : null}</div>{status === 'loading' ? <span className="muted small">正在载入原文…</span> : status === 'error' ? <span className="muted small">原文预览暂不可用，请点击「原页」核对。</span> : null}<canvas ref={canvas} aria-label={'第 '+page+' 页原始公式或表格'} style={{ display:status === 'ready' ? 'block' : 'none' }} /></div>;
}
