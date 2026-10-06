/** 与后端通信的 API 封装 */

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    err.detail = data?.detail;
    throw err;
  }
  return data;
}

export const api = {
  health: () => request('/api/health'),

  getConfig: () => request('/api/config'),
  saveConfig: (patch) => request('/api/config', { method: 'POST', body: JSON.stringify(patch) }),
  verifyConfig: (apiKey) =>
    request('/api/config/verify', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  writeEnv: (apiKey) =>
    request('/api/config/env', { method: 'POST', body: JSON.stringify({ apiKey }) }),

  listDocuments: () => request('/api/documents'),
  reparseDocument: (id) => request(`/api/documents/${id}/reparse`, { method:'POST' }),
  getDocument: (id) => request(`/api/documents/${id}`),
  renameDocument: (id, title) =>
    request(`/api/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteDocument: (id) => request(`/api/documents/${id}`, { method: 'DELETE' }),

  uploadFile: (file, title) => {
    const fd = new FormData();
    fd.append('file', file);
    if (title) fd.append('title', title);
    return request('/api/documents', { method: 'POST', body: fd });
  },
  uploadText: (pastedText, title) =>
    request('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ pastedText, title }),
    }),

  clearThread: (id, paragraphId) =>
    request(`/api/documents/${id}/threads/${encodeURIComponent(paragraphId)}`, { method: 'DELETE' }),

  updateParagraph: (id, pid, patch) =>
    request(`/api/documents/${id}/paragraphs/${encodeURIComponent(pid)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  resetParagraph: (id, pid) =>
    request(`/api/documents/${id}/paragraphs/${encodeURIComponent(pid)}/edit`, { method: 'DELETE' }),
  contextBudget: (id) => request(`/api/documents/${id}/context-budget`),

  exportUrl: (id, format, opts = {}) => {
    const q = new URLSearchParams({ format, ...opts });
    return `/api/documents/${id}/export?${q.toString()}`;
  },
  fileUrl: (id) => `/api/documents/${id}/file`,
  revertAiParse: (id) => request(`/api/documents/${id}/ai-parse`, { method: 'DELETE' }),
};

/** 通用 SSE 读取 */
async function readSse(url, options, handlers) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let msg = `请求失败（HTTP ${res.status}）`;
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch {
      /* ignore */
    }
    handlers.onError?.(msg);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const handle = (raw) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    handlers.onEvent?.(evt);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    parts.forEach(handle);
  }
  if (buffer.trim()) handle(buffer);
}

/** AI 精修解析（SSE） */
export function aiParseStream(docId, handlers = {}) {
  const controller = new AbortController();
  readSse(`/api/documents/${docId}/ai-parse`, { method: 'POST', signal: controller.signal }, handlers).catch(
    (err) => {
      if (err.name === 'AbortError') handlers.onEvent?.({ type:'aborted' });
      else handlers.onError?.(err.message || 'AI 精修失败');
    },
  );
  return { abort: () => controller.abort() };
}

/**
 * 流式提问（SSE）
 * @returns {Promise<{abort: () => void}>}
 */
export function askStream(docId, payload, handlers = {}) {
  const controller = new AbortController();

  const run = async () => {
    let res;
    try {
      res = await fetch(`/api/documents/${docId}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') handlers.onAborted?.();
      else handlers.onError?.(err.message || '网络错误');
      return;
    }

    if (!res.ok) {
      let msg = `请求失败（HTTP ${res.status}）`;
      try {
        const j = await res.json();
        msg = j.error || msg;
      } catch {
        /* ignore */
      }
      handlers.onError?.(msg);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let terminal = false;

    const handleEvent = (raw) => {
      const line = raw.trim();
      if (!line.startsWith('data:')) return;
      const payloadText = line.slice(5).trim();
      if (!payloadText) return;
      let evt;
      try {
        evt = JSON.parse(payloadText);
      } catch {
        return;
      }
      switch (evt.type) {
        case 'user_message':
          handlers.onUserMessage?.(evt.message);
          break;
        case 'context':
          handlers.onContext?.(evt);
          break;
        case 'delta':
          handlers.onDelta?.(evt.text);
          break;
        case 'reasoning':
          handlers.onReasoning?.(evt.text);
          break;
        case 'done':
          terminal = true;
          handlers.onDone?.(evt);
          break;
        case 'error':
          terminal = true;
          handlers.onError?.(evt.message);
          break;
        case 'aborted':
          terminal = true;
          handlers.onAborted?.();
          break;
        default:
          break;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        parts.forEach(handleEvent);
      }
      if (buffer.trim()) handleEvent(buffer);
      if (!terminal) handlers.onError?.('回答连接提前结束，请重试');
    } catch (err) {
      if (err.name === 'AbortError') handlers.onAborted?.();
      else handlers.onError?.(err.message || '读取流失败');
    }
  };

  run();
  return { abort: () => controller.abort() };
}
