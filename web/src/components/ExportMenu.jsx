import React, { useEffect, useRef, useState } from 'react';
import { IconDownload } from './Icons.jsx';

const ITEMS = [
  {
    key: 'docx-comments',
    label: 'Word · 原文档 + 问答（批注版）',
    desc: '正文保持原样，每段问答以 Word 批注呈现，附完整问答清单',
    run: (api, id) => window.open(api.exportUrl(id, 'docx', { comments: '1', includeOriginal: '1' }), '_blank'),
  },
  {
    key: 'docx-plain',
    label: 'Word · 原文档 + 问答记录',
    desc: '正文 + 文末问答附录，不使用批注',
    run: (api, id) => window.open(api.exportUrl(id, 'docx', { comments: '0', includeOriginal: '1' }), '_blank'),
  },
  {
    key: 'pdf-print',
    label: 'PDF · 打印/另存为 PDF',
    desc: '打开排版好的页面，用浏览器「打印 → 另存为 PDF」导出',
    run: (api, id) => window.open(`/print.html?doc=${id}`, '_blank'),
  },
  {
    key: 'md',
    label: 'Markdown · 问答记录',
    desc: '纯问答记录，含段落编号与引用标注',
    run: (api, id) => window.open(api.exportUrl(id, 'markdown', { includeOriginal: '1' }), '_blank'),
  },
  {
    key: 'json',
    label: 'JSON · 问答记录',
    desc: '结构化数据，便于二次处理或导入其他系统',
    run: (api, id) => window.open(api.exportUrl(id, 'json', { includeOriginal: '1' }), '_blank'),
  },
  {
    key: 'original',
    label: '原始上传文件',
    desc: '下载最初上传的 .docx / .pdf / .txt 原文件',
    run: (api, id) => window.open(api.fileUrl(id), '_blank'),
    onlyWithFile: true,
  },
];

export default function ExportMenu({ api, docId, hasOriginalFile }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className="dropdown" ref={ref}>
      <button className="btn" onClick={() => setOpen((v) => !v)} disabled={!docId}>
        <IconDownload width={16} height={16} /> 导出
      </button>
      {open ? (
        <div className="dropdown-menu">
          {ITEMS.filter((it) => !it.onlyWithFile || hasOriginalFile).map((it) => (
            <button
              key={it.key}
              className="dropdown-item"
              onClick={() => {
                it.run(api, docId);
                setOpen(false);
              }}
            >
              <strong>{it.label}</strong>
              <small>{it.desc}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
