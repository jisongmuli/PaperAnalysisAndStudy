import React, { useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { IconUpload, IconPaste, IconFile } from './Icons.jsx';

const ACCEPT = '.docx,.pdf,.txt,.md,.markdown,.text,.log,.csv,.json';

export default function UploadDialog({ initialTab = 'file', onClose, onUploadFile, onUploadText, busy, error }) {
  const [tab, setTab] = useState(initialTab);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [aiParse, setAiParse] = useState(false);
  const [validation, setValidation] = useState('');
  const inputRef = useRef(null);

  const pick = (f) => {
    if (!f) return;
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    if (!ACCEPT.split(',').includes(ext)) {
      setValidation(ext === '.doc' ? '旧版 .doc 请先用 Word 另存为 .docx 后上传。' : '请选择 Word（.docx）、PDF 或纯文本文件。');
      setFile(null); return;
    }
    if (f.size > 60 * 1024 * 1024) { setValidation('文件超过 60 MB，请压缩或拆分后上传。'); setFile(null); return; }
    if (!f.size) { setValidation('文件为空，请重新选择。'); setFile(null); return; }
    setValidation('');
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  };

  const submit = () => {
    if (tab === 'file') {
      if (!file) return;
      onUploadFile(file, title, aiParse);
    } else {
      if (!text.trim()) return;
      onUploadText(text, title || '粘贴的文本', aiParse);
    }
  };

  const canSubmit = tab === 'file' ? Boolean(file) : text.trim().length > 0;

  return (
    <Modal
      title="添加待解析的文档"
      subtitle="支持 Word（.docx）、PDF、TXT/Markdown，也可以直接粘贴文本"
      onClose={busy ? undefined : onClose}
      width={720}
      footer={
        <>
          {error || validation ? <span className="form-error inline" role="alert">{validation || error}</span> : null}
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={submit} disabled={!canSubmit || busy}>
            {busy ? '解析中…' : aiParse ? '解析并 AI 精修' : '开始解析'}
          </button>
        </>
      }
    >
      <div className="tabs">
        <button className={`tab ${tab === 'file' ? 'active' : ''}`} onClick={() => setTab('file')}>
          <IconUpload width={15} height={15} /> 上传文件
        </button>
        <button className={`tab ${tab === 'text' ? 'active' : ''}`} onClick={() => setTab('text')}>
          <IconPaste width={15} height={15} /> 粘贴文本
        </button>
      </div>

      {tab === 'file' ? (
        <>
          <div
            className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pick(e.dataTransfer.files?.[0]);
            }}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              hidden
              onChange={(e) => pick(e.target.files?.[0])}
            />
            {file ? (
              <>
                <IconFile width={26} height={26} />
                <strong>{file.name}</strong>
                <span className="muted">{(file.size / 1024).toFixed(0)} KB · 点击可重新选择</span>
              </>
            ) : (
              <>
                <IconUpload width={28} height={28} />
                <strong>把文件拖到这里，或点击选择</strong>
                <span className="muted">.docx / .pdf / .txt / .md，单文件最大 60 MB</span>
              </>
            )}
          </div>
        </>
      ) : (
        <textarea
          aria-label="粘贴论文文本"
          className="paste-area"
          placeholder="在此粘贴论文、合同、说明书等任意文本内容，系统会自动按段落切分…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
        />
      )}

      <label className="field">
        <span>文档标题（可选）</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="不填则使用文件名"
        />
      </label>

      <label className={`ai-option ${aiParse ? 'checked' : ''}`}>
        <input type="checkbox" checked={aiParse} onChange={(e) => setAiParse(e.target.checked)} />
        <div>
          <strong>用 AI 整理提取文本（可选）</strong>
          <small>
            调用 DeepSeek 整理提取出的文本。这不能恢复扫描件或核验原始公式，重要内容仍需核对原页。
            <b>会消耗 token</b>；修正结果会随文档保存，之后打开、提问、导出都复用，不会重复扣费。
          </small>
        </div>
      </label>
    </Modal>
  );
}
