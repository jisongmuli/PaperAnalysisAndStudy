import React, { useMemo, useState } from 'react';
import { IconSearch, IconClose, IconFile } from './Icons.jsx';
export default function ReadingNav({ paragraphs, threads, activeId, query, onQuery, onLocate, onClose }) {
  const [tab, setTab] = useState('outline');
  const normalized = query.trim().toLowerCase();
  const headings = useMemo(() => paragraphs.filter((p) => p.type === 'heading'), [paragraphs]);
  const items = normalized ? paragraphs.filter((p) => p.text.toLowerCase().includes(normalized)) : tab === 'asked' ? paragraphs.filter((p) => threads[p.id]?.messages?.some((m) => m.role === 'user')) : headings.length ? headings : paragraphs;
  const snippet = (p) => { if (!normalized) return p.text; const start = Math.max(0, p.text.toLowerCase().indexOf(normalized) - 18); return (start ? '…' : '') + p.text.slice(start, start + 100); };
  return <aside className="reading-nav" aria-label="论文目录与搜索">
    <div className="nav-head"><span><IconFile width={15} /> 阅读导航</span><button className="icon-btn small" onClick={onClose} aria-label="收起论文目录"><IconClose width={14} /></button></div>
    <label className="paper-search"><IconSearch width={14} /><input aria-label="搜索论文原文" placeholder="搜索原文内容…" value={query} onChange={(e) => onQuery(e.target.value)} />{query ? <button className="mini" onClick={() => onQuery('')} aria-label="清除原文搜索">×</button> : null}</label>
    <div className="nav-tabs"><button className={tab === 'outline' ? 'active' : ''} onClick={() => { setTab('outline'); onQuery(''); }}>目录</button><button className={tab === 'asked' ? 'active' : ''} onClick={() => { setTab('asked'); onQuery(''); }}>已提问</button></div>
    <div className="nav-caption">{normalized ? `找到 ${items.length} 个段落` : tab === 'asked' ? `${items.length} 个段落有问题` : headings.length ? `${headings.length} 个章节标题` : '未检测到标题，按段落导航'}</div>
    <div className="nav-items">{items.slice(0, 250).map((p) => <button key={p.id} className={`nav-item ${activeId === p.id ? 'active' : ''}`} onClick={() => onLocate(p)} style={{ paddingLeft: 12 + Math.min(3, (p.level || 1) - 1) * 10 }}><span className="nav-number">{String(p.index + 1).padStart(2, '0')}</span><span>{snippet(p)}</span>{p.page ? <em>p{p.page}</em> : null}</button>)}{!items.length ? <p className="nav-empty">{normalized ? '没有匹配的原文，换个关键词试试。' : '还没有提问。先在段落右侧写下问题。'}</p> : null}</div>
    <div className="nav-foot">{paragraphs.length} 个内容段落 · 自动保留问答</div>
  </aside>;
}
