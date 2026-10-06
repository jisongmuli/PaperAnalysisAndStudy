import React, { useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import Markdown from '../markdown.jsx';
import FoldableAnswer from './FoldableAnswer.jsx';
import { IconSearch, IconSend, IconStop, IconSpark, IconChevron } from './Icons.jsx';

/** 跨段落关联提问：引用多个段落作为上下文 */
export default function CrossDialog({ paragraphs, messages, pending, initialSelected, onClose, onAsk, onStop, onClear }) {
  const [selected, setSelected] = useState(() => new Set(initialSelected || []));
  const [q, setQ] = useState('');
  const [kw, setKw] = useState('');
  const [folded, setFolded] = useState(() => new Set());

  const toggleFold = (id) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const list = useMemo(() => {
    const k = kw.trim().toLowerCase();
    if (!k) return paragraphs;
    return paragraphs.filter((p) => p.text.toLowerCase().includes(k));
  }, [paragraphs, kw]);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const send = () => {
    if (!q.trim() || pending) return;
    onAsk([...selected], q.trim());
    setQ('');
  };

  const byId = useMemo(() => new Map(paragraphs.map((p) => [p.id, p])), [paragraphs]);

  /** 助手消息本身不带引用信息，向上回溯到最近的一条用户提问 */
  const citedOf = (msg, idx) => {
    if (msg.citedParagraphIds?.length) return msg.citedParagraphIds;
    for (let i = (idx ?? messages.indexOf(msg)) - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return messages[i].citedParagraphIds || [];
    }
    return [];
  };

  const citeLabel = (ids) =>
    ids.map((id) => (byId.get(id) ? `第 ${byId.get(id).index + 1} 段` : id)).join('、');

  return (
    <Modal
      title="跨段落关联提问"
      subtitle="勾选多个段落后提问，系统会把这几段原文一起作为上下文发送给 DeepSeek"
      onClose={onClose}
      width={1000}
      className="cross-modal"
      footer={
        <>
          <span className="muted small">已选 {selected.size} 段</span>
          {messages.length ? (
            <button className="btn ghost" onClick={onClear}>
              清空跨段落记录
            </button>
          ) : null}
          <button className="btn primary" onClick={send} disabled={!q.trim() || Boolean(pending)}>
            <IconSend width={15} height={15} /> 发送
          </button>
        </>
      }
    >
      <div className="cross-layout">
        <div className="cross-left">
          <div className="drawer-search">
            <IconSearch width={15} height={15} />
            <input placeholder="搜索段落内容…" value={kw} onChange={(e) => setKw(e.target.value)} />
          </div>
          <div className="cross-list">
            {list.map((p) => (
              <label key={p.id} className={`cross-item ${selected.has(p.id) ? 'checked' : ''}`}>
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                <div>
                  <div className="cross-item-head">
                    第 {p.index + 1} 段{p.page ? ` · 第 ${p.page} 页` : ''}
                  </div>
                  <div className="cross-item-text">{p.text}</div>
                </div>
              </label>
            ))}
            {list.length === 0 ? <div className="empty small">没有匹配的段落</div> : null}
          </div>
        </div>

        <div className="cross-right">
          <div className="cross-thread">
            {messages.length === 0 && !pending ? (
              <div className="empty small">
                <IconSpark width={18} height={18} />
                <div>还没有跨段落提问记录。左侧勾选段落，然后在下方输入问题。</div>
              </div>
            ) : null}
            {messages.map((m, i) => (
              <div key={m.id || i} className={`bubble ${m.role}`}>
                <div className="bubble-head">
                  <span className="who">{m.role === 'user' ? '我' : 'AI'}</span>
                  {citedOf(m, i).length ? <span className="cite">引用：{citeLabel(citedOf(m, i))}</span> : null}
                  {m.role === 'assistant' && m.content ? (
                    <button
                      type="button"
                      className="fold-toggle"
                      onClick={() => toggleFold(m.id || i)}
                      title={folded.has(m.id || i) ? '展开这条回答' : '折叠这条回答'}
                    >
                      <IconChevron width={13} height={13} open={!folded.has(m.id || i)} />
                      {folded.has(m.id || i) ? '展开' : '折叠'}
                    </button>
                  ) : null}
                </div>
                {m.role === 'assistant' ? (
                  m.error ? (
                    <div className="msg-error">{m.error}</div>
                  ) : (
                    <FoldableAnswer
                      text={m.content}
                      collapsed={folded.has(m.id || i)}
                      onToggle={() => toggleFold(m.id || i)}
                    />
                  )
                ) : (
                  <div className="user-text">{m.content}</div>
                )}
              </div>
            ))}
            {pending ? (
              <div className="bubble assistant">
                <div className="bubble-head">
                  <span className="who">AI</span>
                  <span className="cite">引用：{citeLabel(pending.citedParagraphIds || [])}</span>
                </div>
                <Markdown text={pending.text} />
                {!pending.text ? (
                  <div className="typing">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : (
                  <span className="caret" />
                )}
              </div>
            ) : null}
          </div>

          <div className="cross-ask">
            <textarea
              rows={3}
              value={q}
              placeholder="例如：这几段之间的逻辑关系是什么？作者的论证是否一致？"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {pending ? (
              <button className="btn danger" onClick={onStop}>
                <IconStop width={15} height={15} /> 停止
              </button>
            ) : (
              <button className="btn primary" onClick={send} disabled={!q.trim()}>
                <IconSend width={15} height={15} /> 发送
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
