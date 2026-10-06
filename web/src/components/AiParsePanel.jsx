import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { IconSpark, IconStop, IconCheck, IconAlert } from './Icons.jsx';

const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');

/**
 * AI 精修解析面板
 * mode: 'confirm'（询问是否开始，说明会消耗 token）| 'running'（进度）| 'done'
 */
export default function AiParsePanel({ mode, blockCount, progress, usage, errors, aiParse, onStart, onStop, onClose }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (mode !== 'running') return undefined;
    const t = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [mode]);

  const total = progress?.total || 0;
  const done = progress?.index || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const tokens = usage?.totalTokens || aiParse?.usage?.totalTokens || 0;

  return (
    <Modal
      title={mode === 'confirm' ? 'AI 精修解析' : mode === 'running' ? '正在用 AI 精修解析…' : 'AI 精修完成'}
      subtitle={
        mode === 'confirm'
          ? '让 AI 修正提取结果里的公式、表格与断词问题'
          : mode === 'running'
            ? '结果会实时保存，即使中断也不会白花 token'
            : '已保存到文档，之后打开或重新提问都不会再消耗 token'
      }
      onClose={mode === 'running' ? undefined : onClose}
      width={560}
      footer={
        mode === 'confirm' ? (
          <>
            <button className="btn ghost" onClick={onClose}>
              跳过，用本地解析结果
            </button>
            <button className="btn primary" onClick={onStart}>
              <IconSpark width={15} height={15} /> 开始精修
            </button>
          </>
        ) : mode === 'running' ? (
          <>
            <span className="muted small">已用 {fmt(tokens)} tokens · {elapsed}s</span>
            <button className="btn danger" onClick={onStop}>
              <IconStop width={15} height={15} /> 停止（已完成的会保留）
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={onClose}>
            知道了
          </button>
        )
      }
    >
      {mode === 'confirm' ? (
        <div className="ai-confirm">
          <p>
            本地解析在 PDF 上常有偏差：<b>公式被拆行、上下标错位、表格被压成一行</b>。
            AI 精修会把 <b>{blockCount}</b> 个内容块交给 DeepSeek 逐块修正，并按 1:1 写回。
          </p>
          <ul className="ai-tips">
            <li>
              <IconAlert width={14} height={14} />
              <span>
                会消耗 API token（本文档预计 <b>1K–8K tokens</b>，按块数与长度而定），
                <b>结果会随文档永久保存</b>，之后打开、提问、导出都复用，不会重复扣费。
              </span>
            </li>
            <li>
              <IconCheck width={14} height={14} />
              <span>图片块会跳过（不浪费 token）；每批完成即落库，中途停止也保留已修好的部分。</span>
            </li>
            <li>
              <IconCheck width={14} height={14} />
              <span>随时可以「还原为本地解析」，原始解析结果一直留着。</span>
            </li>
          </ul>
        </div>
      ) : null}

      {mode === 'running' ? (
        <div className="ai-progress">
          <div className="ai-bar">
            <div className="ai-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="ai-progress-text">
            第 {done} / {total} 批 · 已修正 {fmt(progress?.appliedTotal || 0)} 块 · 已用 {fmt(tokens)} tokens
          </div>
          {progress?.blockFrom !== undefined ? (
            <div className="muted small">
              当前处理：第 {progress.blockFrom + 1} – {progress.blockTo + 1} 块
            </div>
          ) : null}
        </div>
      ) : null}

      {mode === 'done' ? (
        <div className="ai-done">
          <div className="ai-stat">
            <span>精修块数</span>
            <b>{fmt(aiParse?.blocksRefined)}</b>
          </div>
          <div className="ai-stat">
            <span>本次消耗</span>
            <b>{fmt(tokens)} tokens</b>
          </div>
          <div className="ai-stat">
            <span>输入 / 输出</span>
            <b>
              {fmt(aiParse?.usage?.promptTokens)} / {fmt(aiParse?.usage?.completionTokens)}
            </b>
          </div>
          <div className="ai-stat">
            <span>模型</span>
            <b>{aiParse?.model || '—'}</b>
          </div>
          <div className="ai-stat">
            <span>请求批数</span>
            <b>{aiParse?.chunks ?? '—'}</b>
          </div>
          {errors?.length ? (
            <div className="ai-errors">
              {errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
