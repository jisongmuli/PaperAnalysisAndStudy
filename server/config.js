/**
 * 配置管理
 * 读取顺序：data/config.json（配置页保存） > 环境变量 > 内置默认值
 * 支持 .env 文件（无需第三方依赖，自行解析）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(__dirname);
export const DATA_DIR = process.env.PAPERINSIGHT_DATA_DIR
  ? path.resolve(process.env.PAPERINSIGHT_DATA_DIR)
  : path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 极简 .env 解析（不覆盖已存在的真实环境变量） */
function loadDotEnv() {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  const content = fs.readFileSync(envFile, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  temperature: 0.3,
  maxTokens: 4096,
  // 单次输入预算包含文档、历史对话、系统提示和当前问题。
  maxContextTokens: 56000,
  systemPrompt:
    '你是一位严谨的学术与技术文档助理。用户会给你一段文档原文（段落）以及一个针对该段落的问题。' +
    '请优先基于给定段落作答，回答使用简体中文，条理清晰；如段落信息不足以回答，请明确说明，' +
    '并可基于常识谨慎补充，但需标注“（段落未提及，以下为补充说明）”。',
};

function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn('[config] 读取 config.json 失败：', err.message);
    return {};
  }
}

let cached = readConfigFile();

export function getConfig({ withSecret = false } = {}) {
  const fileKey = String(cached.apiKey || '').trim();
  const envKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
  const apiKey = fileKey || envKey;
  const source = fileKey ? 'config' : envKey ? 'env' : 'none';

  const merged = {
    apiKey,
    apiKeySource: source,
    baseUrl: String(cached.baseUrl || process.env.DEEPSEEK_BASE_URL || DEFAULTS.baseUrl).replace(
      /\/+$/,
      '',
    ),
    model: String(cached.model || process.env.DEEPSEEK_MODEL || DEFAULTS.model),
    temperature: Number.isFinite(+cached.temperature) ? +cached.temperature : DEFAULTS.temperature,
    maxTokens: Number.isFinite(+cached.maxTokens) ? +cached.maxTokens : DEFAULTS.maxTokens,
    maxContextTokens: Number.isFinite(+cached.maxContextTokens)
      ? +cached.maxContextTokens
      : Number.isFinite(+process.env.DEEPSEEK_MAX_CONTEXT_TOKENS)
        ? +process.env.DEEPSEEK_MAX_CONTEXT_TOKENS
        : DEFAULTS.maxContextTokens,
    systemPrompt: String(cached.systemPrompt || DEFAULTS.systemPrompt),
    contextMode: ['paragraph', 'neighbors', 'full'].includes(cached.contextMode)
      ? cached.contextMode
      : 'full',
  };

  if (!withSecret) {
    merged.apiKey = apiKey ? maskKey(apiKey) : '';
    delete merged.rawApiKey;
  }
  return merged;
}

export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 3)}****`;
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}

/** 配置页保存。空密钥保留现有配置；clearApiKey 显式清除配置页密钥。 */
export function saveConfig(patch = {}) {
  const next = { ...cached };
  if (patch.clearApiKey === true) delete next.apiKey;
  else if ('apiKey' in patch) {
    const v = String(patch.apiKey ?? '').trim();
    if (v) next.apiKey = v;
  }
  for (const key of ['temperature', 'maxTokens', 'maxContextTokens']) {
    if (key in patch && patch[key] !== '' && patch[key] !== null && !Number.isFinite(Number(patch[key]))) {
      const err = new Error('参数必须是有效数字');
      err.status = 400;
      throw err;
    }
  }
  if (patch.baseUrl && (() => {
    try {
      const u = new URL(String(patch.baseUrl).trim());
      return !['https:', 'http:'].includes(u.protocol) || Boolean(u.username || u.password);
    } catch { return true; }
  })()) {
    const err = new Error('请输入有效的 API 地址（http 或 https）');
    err.status = 400;
    throw err;
  }
  if ('baseUrl' in patch && String(patch.baseUrl).trim())
    next.baseUrl = String(patch.baseUrl).trim().replace(/\/+$/, '');
  if ('model' in patch && String(patch.model).trim()) next.model = String(patch.model).trim();
  if ('temperature' in patch && patch.temperature !== '' && patch.temperature !== null)
    next.temperature = Math.max(0, Math.min(2, Number(patch.temperature)));
  if ('maxTokens' in patch && patch.maxTokens !== '' && patch.maxTokens !== null)
    next.maxTokens = Math.max(64, Math.min(8192, Math.round(Number(patch.maxTokens))));
  if ('maxContextTokens' in patch && patch.maxContextTokens !== '' && patch.maxContextTokens !== null)
    next.maxContextTokens = Math.max(2000, Math.min(120000, Math.round(Number(patch.maxContextTokens))));
  if ('systemPrompt' in patch && String(patch.systemPrompt).trim())
    next.systemPrompt = String(patch.systemPrompt);
  if ('contextMode' in patch && ['paragraph', 'neighbors', 'full'].includes(patch.contextMode))
    next.contextMode = patch.contextMode;

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  cached = next;
  return getConfig();
}

/** 写入 .env（可选功能，方便用户固化密钥） */
export function writeEnvFile(apiKey) {
  const envFile = path.join(ROOT, '.env');
  let lines = [];
  if (fs.existsSync(envFile)) {
    lines = fs
      .readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !/^\s*DEEPSEEK_API_KEY\s*=/.test(l));
  }
  lines = lines.filter((l, i) => !(l === '' && i === lines.length - 1));
  lines.push(`DEEPSEEK_API_KEY=${apiKey}`);
  fs.writeFileSync(envFile, lines.join('\n') + '\n', 'utf8');
  process.env.DEEPSEEK_API_KEY = apiKey;
}
