/**
 * DeepSeek API 客户端（OpenAI 兼容协议）
 * - chatStream: 流式对话，回调增量文本
 * - verifyKey : 校验密钥是否可用
 */
import { getConfig } from './config.js';

export class ApiError extends Error {
  constructor(message, status = 500, detail = '') {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function requireKey() {
  const cfg = getConfig({ withSecret: true });
  if (!cfg.apiKey) {
    throw new ApiError(
      '尚未配置 DeepSeek API 密钥。请点击右上角「设置」填写，或设置环境变量 DEEPSEEK_API_KEY。',
      400,
    );
  }
  return cfg;
}

async function readError(res) {
  let detail = '';
  try {
    detail = await res.text();
    try {
      const j = JSON.parse(detail);
      detail = j?.error?.message || j?.message || detail;
    } catch {
      /* 保留原始文本 */
    }
  } catch {
    /* ignore */
  }
  return detail.slice(0, 600);
}

/**
 * 流式对话
 * @param {{messages: Array<{role:string, content:string}>, signal?: AbortSignal,
 *          onDelta?: (t:string)=>void, onReasoning?: (t:string)=>void, overrides?: object}} opts
 * @returns {Promise<{content: string, reasoning: string, usage: object|null, model: string}>}
 */
export async function chatStream({ messages, signal, onDelta, onReasoning, overrides = {} }) {
  const cfg = { ...requireKey(), ...overrides };
  const body = {
    model: cfg.model,
    messages,
    stream: true,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    stream_options: { include_usage: true },
    ...(cfg.model === 'deepseek-flash' ? { thinking:{ type:'disabled' } } : {}),
  };

  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(`无法连接 DeepSeek API（${cfg.baseUrl}）：${err.message}`, 502);
  }

  if (!res.ok) {
    const detail = await readError(res);
    const hint =
      res.status === 401
        ? '密钥无效或已过期'
        : res.status === 402
          ? '账户余额不足'
          : res.status === 429
            ? '请求过于频繁，请稍后重试'
            : '接口返回错误';
    throw new ApiError(`${hint}（HTTP ${res.status}）：${detail}`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let model = cfg.model;
  let finishReason = null;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.model) model = json.model;
    if (json.usage) usage = json.usage;
    const choice = json.choices?.[0];
    const delta = choice?.delta || {};
    // 推理模型（deepseek-reasoner / *-pro）会先流式返回思考过程
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      if (onReasoning) onReasoning(delta.reasoning_content);
    }
    if (delta.content) {
      content += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  }
  if (buffer.trim()) handleLine(buffer);

  if (!finishReason) {
    throw new ApiError('回答连接提前结束，请重试。', 502);
  }
  if (!content && !reasoning) {
    throw new ApiError(`模型未返回内容（finish_reason=${finishReason}）`, 502);
  }
  if (!content && reasoning) {
    // 输出被 max_tokens 截断，思考过程吃掉了全部预算
    throw new ApiError(
      '模型只输出了思考过程就被截断，没有给出正式回答。请把「最大回复长度」调大（推理模型建议 4096 以上）后重试。',
      502,
    );
  }

  return { content, reasoning, usage, model, finishReason };
}

/**
 * 非流式对话（用于结构化输出，如 AI 精修解析）
 * @returns {Promise<{content: string, usage: object|null, model: string}>}
 */
export async function chatComplete({ messages, signal, overrides = {}, jsonMode = false, maxTokens }) {
  const cfg = { ...requireKey(), ...overrides };
  const body = {
    model: cfg.model,
    messages,
    stream: false,
    temperature: overrides.temperature ?? 0.1,
    max_tokens: maxTokens || cfg.maxTokens,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    ...(cfg.model === 'deepseek-flash' ? { thinking:{ type:'disabled' } } : {}),
  };

  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(`无法连接 DeepSeek API（${cfg.baseUrl}）：${err.message}`, 502);
  }

  if (!res.ok) {
    const detail = await readError(res);
    throw new ApiError(`接口返回错误（HTTP ${res.status}）：${detail}`, res.status);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content || '';
  if (!content && choice?.message?.reasoning_content) {
    throw new ApiError('模型只返回了思考过程，请调大「最大回复长度」后重试', 502);
  }
  return { content, usage: data.usage || null, model: data.model || cfg.model };
}

/** 校验密钥：调用 /models */export async function verifyKey(apiKeyOverride) {
  const cfg = getConfig({ withSecret: true });
  const key = (apiKeyOverride || cfg.apiKey || '').trim();
  if (!key) throw new ApiError('未提供 API 密钥', 400);
  const baseUrl = String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new ApiError(`无法连接 ${baseUrl}：${err.message}`, 502);
  }
  if (!res.ok) {
    const detail = await readError(res);
    throw new ApiError(
      res.status === 401 ? `密钥无效（HTTP 401）：${detail}` : `校验失败（HTTP ${res.status}）：${detail}`,
      res.status,
    );
  }
  const data = await res.json().catch(() => ({}));
  const models = (data?.data || []).map((m) => m.id).filter(Boolean);
  return { ok: true, baseUrl, models, latencyMs: Date.now() - started };
}
