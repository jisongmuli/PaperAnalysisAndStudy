import React, { useEffect, useRef, useState } from 'react';
import Markdown from '../markdown.jsx';
import PdfSnippet from './PdfSnippet.jsx';
import { IconZoom, IconFormula, IconTable, IconImage, IconBook, IconEdit, IconCheck, IconClose, IconUndo } from './Icons.jsx';

/** 图片按原始像素等比缩放，避免小图被拉糊、大图溢出 */
function imageStyle(im) {
  const w = Number(im.width);
  const h = Number(im.height);
  if (Number.isFinite(w) && w > 0) {
    return { width: `${w}px`, maxWidth: '100%', ...(Number.isFinite(h) && h>0 ? {aspectRatio:`${w} / ${h}`} : {}) };
  }
  return { maxWidth: '100%' };
}

/**
 * 文本里是否含行内公式（$...$ 或 \(...\)）。
 * 作为渲染兜底：无论标记从哪来（本地解析 / AI 精修 / 人工修改），
 * 只要含公式就必须走 KaTeX 渲染，不能把 $...$ 原样显示。
 */
export function hasInlineMath(text) {
  const s = String(text || '');
  return /\$[^$\n]{1,300}\$/.test(s) || /\\\([\s\S]{1,300}?\\\)/.test(s) || /\$\$[\s\S]{1,600}?\$\$/.test(s);
}

/**
 * 渲染一个文档块：段落 / 标题 / 列表 / 公式 / 表格 / 图片
 * 支持原地编辑（解析出的公式常需人工订正，改完永久生效）
 */
export default function BlockView({
  block,
  onZoomImage,
  onOpenPage,
  canOpenPage,
  onSave,
  onReset,
  busy,
  originalFileUrl,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftTex, setDraftTex] = useState('');
  const taRef = useRef(null);

  useEffect(() => {
    if (!editing) return;
    taRef.current?.focus();
  }, [editing]);

  const startEdit = () => {
    setDraft(block.text || '');
    setDraftTex(block.tex || '');
    setEditing(true);
  };

  const save = async () => {
    const patch = { text: draft };
    if (block.type === 'formula' || draftTex.trim()) patch.tex = draftTex;
    await onSave?.(patch);
    setEditing(false);
  };

  /* ------------------------------ 编辑态 ------------------------------ */
  if (editing) {
    const isFormula = block.type === 'formula';
    return (
      <div className="block-editor">
        <div className="editor-head">
          <IconEdit width={13} height={13} />
          修正这一块的内容
          <span className="muted small">
            {isFormula ? '公式请填 LaTeX（不含 $ 符号）' : '可直接粘贴正确文本，公式用 $...$ 包裹'}
          </span>
        </div>
        {isFormula ? (
          <>
            <label className="editor-label">LaTeX 公式</label>
            <textarea
              ref={taRef}
              className="editor-input mono"
              rows={3}
              value={draftTex}
              onChange={(e) => setDraftTex(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <label className="editor-label">预览</label>
            <div className="editor-preview">
              <Markdown text={draftTex.trim() ? `$$${draftTex}$$` : '_（空）_'} />
            </div>
          </>
        ) : (
          <>
            <textarea
              ref={taRef}
              className="editor-input"
              rows={5}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            {/\$/.test(draft) ? (
              <>
                <label className="editor-label">预览</label>
                <div className="editor-preview">
                  <Markdown text={draft} />
                </div>
              </>
            ) : null}
          </>
        )}
        <div className="editor-actions">
          <button className="btn primary small" onClick={save} disabled={busy}>
            <IconCheck width={14} height={14} /> 保存（Ctrl+Enter）
          </button>
          <button className="btn small ghost" onClick={() => setEditing(false)}>
            <IconClose width={14} height={14} /> 取消
          </button>
          {block.edited ? (
            <button className="btn small ghost" onClick={onReset} disabled={busy}>
              <IconUndo width={14} height={14} /> 还原原始解析
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const editButton = (
    <button
      type="button"
      className="inline-page-btn edit-btn"
      onClick={(e) => {
        e.stopPropagation();
        startEdit();
      }}
      title="修正这一块的内容（用于公式/表格解析不准的情况）"
    >
      <IconEdit width={12} height={12} /> 修正
    </button>
  );

  const pageButton =
    canOpenPage && block.page ? (
      <button
        type="button"
        className="inline-page-btn"
        onClick={(e) => {
          e.stopPropagation();
          onOpenPage?.(block.page);
        }}
        title={`查看第 ${block.page} 页原文`}
      >
        <IconBook width={12} height={12} /> 原页
      </button>
    ) : null;

  const editedTag = block.edited ? (
    <span className="edited-tag" title="该块已被人工修正">
      已修正
    </span>
  ) : null;

  if (block.type === 'image') {
    const list = block.images || [];
    return (
      <div className="block-image">
        {list.map((im, i) => (
          <button
            type="button"
            key={i}
            className="figure"
            onClick={() => onZoomImage?.(im.url, `第 ${block.index + 1} 块${block.page ? ` · 第 ${block.page} 页` : ''}`)}
            title="点击放大查看"
          >
            <img src={im.url} alt={`插图 ${i + 1}`} loading="lazy" style={imageStyle(im)} />
            <span className="figure-zoom">
              <IconZoom width={13} height={13} /> 放大
            </span>
          </button>
        ))}
      </div>
    );
  }

  if (block.type === 'table') {
    const rows = block.table?.rows || [];
    const headerRow = block.table?.headerRow !== false;
    const head = headerRow ? rows[0] || [] : [];
    const body = headerRow ? rows.slice(1) : rows;
    return (
      <div className="block-table">
        <div className="block-tag">
          <IconTable width={13} height={13} /> 表格 {rows.length} × {block.table?.cols || head.length || 0}
          {editedTag}
          {editButton}
          {pageButton}
        </div>
        {block.source && originalFileUrl ? <details className="answer-note"><summary>对照原 PDF 表格</summary><PdfSnippet url={originalFileUrl} page={block.page} source={block.source} onZoom={onZoomImage} /></details> : null}
        <div className="table-scroll">
          <table>
            {head.length ? (
              <thead>
                <tr>
                  {head.map((c, i) => (
                    <th key={i}>{c}</th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (block.type === 'formula') {
    const tex = block.tex || String(block.text || '').replace(/^\$\$?/, '').replace(/\$\$?$/, '');
    return (
      <div className="block-formula">
        <div className="block-tag">
          <IconFormula width={13} height={13} /> 公式
          {editedTag}
          {editButton}
          {pageButton}
        </div>
        {block.source && originalFileUrl && !block.edited ? <>
          <PdfSnippet url={originalFileUrl} page={block.page} source={block.source} onZoom={onZoomImage} />
          <details className="answer-note"><summary>查看提取的公式文本（需核对）</summary><Markdown text={`$$${tex}$$`} /></details>
        </> : <Markdown text={`$$${tex}$$`} />}
        {block.texUncertain && !block.edited ? (
          <div className="block-note">
            {block.source && originalFileUrl ? '以上为原 PDF 截图；展开的提取文本需核对，可点「修正」编辑。' : '提取的公式文字可能有误，可点「修正」编辑或点「原页」核对。'}
          </div>
        ) : null}
      </div>
    );
  }

  if (block.rich || hasInlineMath(block.text)) {
    // 段落内含行内公式：交给 Markdown + KaTeX 渲染
    return (
      <div className={`block-rich type-${block.type}`}>
        <Markdown text={block.text} />
        <div className="block-inline-tools">
          {editedTag}
          {editButton}
          {pageButton}
        </div>
      </div>
    );
  }

  return (
    <p className={`ptext type-${block.type}`}>
      {block.text}
      {editedTag}
      {editButton}
      {pageButton}
    </p>
  );
}

export function blockIcon(type) {
  if (type === 'table') return <IconTable width={12} height={12} />;
  if (type === 'image') return <IconImage width={12} height={12} />;
  if (type === 'formula') return <IconFormula width={12} height={12} />;
  return null;
}
