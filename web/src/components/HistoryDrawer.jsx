import React, { useEffect, useState } from 'react';
import { IconClose, IconTrash, IconFile, IconSearch } from './Icons.jsx';

export default function HistoryDrawer({ documents, currentId, loading, onClose, onOpen, onDelete, onRefresh }) {
  const [q, setQ] = useState('');

  useEffect(() => {
    onRefresh?.();
  }, [onRefresh]);

  const list = documents.filter(
    (d) =>
      !q.trim() ||
      d.title?.toLowerCase().includes(q.toLowerCase()) ||
      d.filename?.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="drawer-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer">
        <header className="drawer-head">
          <h3>历史记录</h3>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </header>

        <div className="drawer-search">
          <IconSearch width={15} height={15} />
          <input placeholder="搜索标题或文件名…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        <div className="drawer-body">
          {loading ? <div className="empty small">加载中…</div> : null}
          {!loading && list.length === 0 ? (
            <div className="empty small">还没有任何文档记录</div>
          ) : null}
          {list.map((d) => (
            <div key={d.id} className={`history-item ${d.id === currentId ? 'active' : ''}`}>
              <div className="history-main" onClick={() => onOpen(d.id)}>
                <div className="history-title">
                  <IconFile width={14} height={14} />
                  <span>{d.title}</span>
                </div>
                <div className="history-meta">
                  <span className="chip tiny">{String(d.format || '').toUpperCase()}</span>
                  <span>{d.paragraphCount} 段</span>
                  <span>{d.answeredParagraphs} 段有问答</span>
                  <span>{d.questionCount} 问</span>
                </div>
                <div className="history-time">{new Date(d.updatedAt).toLocaleString('zh-CN')}</div>
              </div>
              <button
                className="icon-btn danger"
                title="删除该文档及其问答记录"
                onClick={() => {
                  if (window.confirm(`确定删除「${d.title}」及其全部问答记录？`)) onDelete(d.id);
                }}
              >
                <IconTrash width={15} height={15} />
              </button>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
