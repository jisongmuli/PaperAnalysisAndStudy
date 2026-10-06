import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { IconCheck, IconSpark } from './Icons.jsx';

const MODELS = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'];
const CONTEXT_MODES = [
  { value: 'paragraph', label: '仅当前段落', desc: '把该段落原文作为上下文（最省 token）' },
  { value: 'neighbors', label: '当前段落 + 相邻段落', desc: '额外带上前后各一段，适合需要上下文的提问' },
  {
    value: 'full',
    label: '结合全文（推荐）',
    desc: '把整篇文档发过去；超出上限时自动按问题相关性节选最相关的段落与标题大纲',
  },
];

export default function SettingsDialog({ config, onClose, onSave, onVerify, onWriteEnv, notify }) {
  const [form, setForm] = useState({
    apiKey: '',
    baseUrl: config?.baseUrl || 'https://api.deepseek.com',
    model: config?.model || 'deepseek-flash',
    temperature: config?.temperature ?? 0.3,
    maxTokens: config?.maxTokens ?? 2048,
    maxContextTokens: config?.maxContextTokens ?? 56000,
    systemPrompt: config?.systemPrompt || '',
    contextMode: config?.contextMode || 'full',
  });
  const [busy, setBusy] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSaved(false);
  }, [form]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const doVerify = async () => {
    setBusy('verify');
    setTestResult(null);
    try {
      const r = await onVerify(form.apiKey || undefined);
      setTestResult({ ok: true, ...r });
    } catch (err) {
      setTestResult({ ok: false, message: err.message });
    } finally {
      setBusy('');
    }
  };

  const doSave = async () => {
    setBusy('save');
    try {
      await onSave(form);
      setSaved(true);
      notify?.('设置已保存');
    } catch (err) {
      notify?.(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const doWriteEnv = async () => {
    if (!form.apiKey.trim()) {
      notify?.('请先在输入框中填写密钥，再写入 .env', 'error');
      return;
    }
    setBusy('env');
    try {
      const r = await onWriteEnv(form.apiKey.trim());
      notify?.(r.message || '已写入 .env');
      setForm((f) => ({ ...f, apiKey: '' }));
    } catch (err) {
      notify?.(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <Modal
      title="设置"
      subtitle="API 密钥可保存在本机配置文件中，也可通过环境变量 DEEPSEEK_API_KEY 提供"
      onClose={onClose}
      width={720}
      footer={
        <>
          {saved ? (
            <span className="form-ok inline">
              <IconCheck width={14} height={14} /> 已保存
            </span>
          ) : null}
          <button className="btn ghost" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={doSave} disabled={busy === 'save'}>
            {busy === 'save' ? '保存中…' : '保存设置'}
          </button>
        </>
      }
    >
      <section className="settings-section">
        <h4>DeepSeek API</h4>
        <label className="field">
          <span>
            API 密钥
            {config?.envKeyPresent ? <em className="tag">环境变量中已有密钥</em> : null}
          </span>
          <input
            type="password"
            value={form.apiKey}
            onChange={set('apiKey')}
            placeholder={
              config?.hasKey
                ? `已配置：${config.apiKeyMasked}（来源：${config.apiKeySource === 'env' ? '环境变量' : '配置文件'}）— 留空表示不修改`
                : 'sk-...'
            }
          />
          <small className="hint">
            密钥仅保存在本机 <code>data/config.json</code>，不会发送到除 DeepSeek 之外的任何地方。
          </small>
        </label>

        <div className="row-2">
          <label className="field">
            <span>API 地址</span>
            <input type="text" value={form.baseUrl} onChange={set('baseUrl')} />
          </label>
          <label className="field">
            <span>模型</span>
            <input list="model-list" type="text" value={form.model} onChange={set('model')} />
            <datalist id="model-list">
              {MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
        </div>

        <div className="row-2">
          <label className="field">
            <span>温度（0–2）：<b>{form.temperature}</b></span>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={form.temperature}
              onChange={(e) => setForm((f) => ({ ...f, temperature: Number(e.target.value) }))}
            />
          </label>
          <label className="field">
            <span>最大回复长度（tokens）</span>
            <input type="number" min="64" max="8192" step="64" value={form.maxTokens} onChange={set('maxTokens')} />
          </label>
        </div>

        <label className="field">
          <span>单次发送的上下文上限（tokens）</span>
          <input
            type="number"
            min="2000"
            max="120000"
            step="1000"
            value={form.maxContextTokens}
            onChange={set('maxContextTokens')}
          />
          <small className="hint">
            这个上限包含论文、对话历史和问题。默认 56000；长论文会自动选取与问题相关的段落，
            并告诉你本次参考了多少原文。调高前请确认所用模型支持相应的上下文长度。
          </small>
        </label>

        <div className="settings-actions">
          <button className="btn" onClick={doVerify} disabled={busy === 'verify'}>
            <IconSpark width={15} height={15} />
            {busy === 'verify' ? '测试中…' : '测试连接'}
          </button>
          <button className="btn ghost" onClick={doWriteEnv} disabled={busy === 'env'}>
            写入 .env 并改用环境变量
          </button>
        </div>

        {testResult ? (
          <div className={`test-result ${testResult.ok ? 'ok' : 'bad'}`}>
            {testResult.ok ? (
              <>
                连接成功（{testResult.latencyMs} ms）· 可用模型：
                {(testResult.models || []).join('、') || '未返回列表'}
              </>
            ) : (
              <>连接失败：{testResult.message}</>
            )}
          </div>
        ) : null}
      </section>

      <section className="settings-section">
        <h4>提问上下文</h4>
        <div className="radio-group">
          {CONTEXT_MODES.map((m) => (
            <label key={m.value} className={`radio-card ${form.contextMode === m.value ? 'active' : ''}`}>
              <input
                type="radio"
                name="contextMode"
                value={m.value}
                checked={form.contextMode === m.value}
                onChange={(e) => setForm((f) => ({ ...f, contextMode: e.target.value }))}
              />
              <div>
                <strong>{m.label}</strong>
                <small>{m.desc}</small>
              </div>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h4>系统提示词</h4>
        <label className="field">
          <textarea rows={4} value={form.systemPrompt} onChange={set('systemPrompt')} />
          <small className="hint">决定 AI 的角色与回答风格，每次提问都会带上。</small>
        </label>
      </section>
    </Modal>
  );
}
