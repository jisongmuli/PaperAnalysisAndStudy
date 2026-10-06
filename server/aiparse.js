/**
 * AI 精修解析
 *
 * 本地解析（尤其 PDF）常出现：公式被拆行、上下标错位、表格被压成一行、连字符断词。
 * 这里把本地解析出的**内容块**交给 DeepSeek 逐块修正，严格 1:1 映射后再写回文档。
 *
 * 因为要花 token，解析结果由调用方持久化保存，之后打开文档不会重跑。
 */
import { estimateTokens } from './tokens.js';
import { chatComplete } from './deepseek.js';
import { hasMath } from './parser.js';

/** 单次请求的输入预算（token），留足输出空间 */
const CHUNK_TOKEN_BUDGET = 5200;
const CHUNK_MAX_BLOCKS = 28;

const SYSTEM_PROMPT = `你是一个文档结构化助手。用户会给你一批由程序从 PDF/Word 中自动提取出的内容块（带编号），
这些内容块可能有提取错误：公式被拆成多行、上下标错位、表格被压成一行、英文单词被连字符断开、段落被切碎等。

请逐块修正，并**只输出 JSON**（不要 markdown 代码块，不要解释）。

严格规则：
1. 输出的块必须与输入的块**编号一一对应，数量完全一致**，不得增加、删除、合并或调换顺序。
2. 每个块输出：
   {"n": 编号, "type": "paragraph|heading|list|formula|table", "text": "...", "tex": "...", "rows": [["表头1","表头2"],["值1","值2"]]}
   - type=formula：必须给出 tex（LaTeX，**不要** $ 定界符）；text 给出该公式的可读线性形式（如 p_ri = x_ri / Σ x_rj）。
   - type=table：必须给出 rows（二维字符串数组，第一行为表头）；text 给出表格纯文本。
   - 其余类型：text 为修正后的正文；行内公式用 $...$ 包裹（如 其中 $x_{ri}$ 为…）。
   - 不需要的字段可以省略；rows 只在 type=table 时给出。
3. **只做修正，不得编造原文没有的内容**。若原文残缺、无法确定，按最可能的形式补全，
   并在该块 text 末尾追加「（此处原文提取可能不完整）」。
4. 保留原文语言与专业术语；不要翻译。
5. 标题块保持简短。
6. 如果一个块明显是**表格**（多列数据被空格/竖线挤在一起、或表头+数据行），
   请改成 type=table 并给出 rows（第一行为表头）；表格被拆到多个块时，
   让第一个块承载完整 rows，其余块保持原样但把 text 精简为「（表格续行）」。

返回格式：{"blocks": [ ... ]}`;

/** 把块按 token 预算切分成若干批 */
function chunkBlocks(blocks) {
  const chunks = [];
  let cur = [];
  let curTokens = 0;
  for (const b of blocks) {
    const t = estimateTokens(b.line) + 8;
    if (cur.length && (curTokens + t > CHUNK_TOKEN_BUDGET || cur.length >= CHUNK_MAX_BLOCKS)) {
      chunks.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(b);
    curTokens += t;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function blockLine(b) {
  const tag =
    b.block.type === 'formula'
      ? '公式'
      : b.block.type === 'table'
        ? '表格'
        : b.block.type === 'heading'
          ? '标题'
          : b.block.type === 'image'
            ? '图片'
            : '段落';
  const body = b.block.type === 'table' ? b.block.text.replace(/\n/g, ' ⏎ ') : b.block.text;
  return `[${b.index}] (${tag}) ${body}`;
}

/** 宽容地解析模型返回的 JSON */
function parseJsonLoose(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return null;
  const out = rows
    .filter((r) => Array.isArray(r))
    .map((r) => r.map((c) => String(c ?? '').replace(/\n+/g, ' ').trim()));
  const width = out.reduce((m, r) => Math.max(m, r.length), 0);
  if (!width) return null;
  for (const r of out) while (r.length < width) r.push('');
  return out;
}

/**
 * 对整篇文档做 AI 精修
 * @param {{ title: string, blocks: Array }} doc
 * @param {{ onProgress?: Function, onBlocks?: Function, signal?: AbortSignal }} opts
 */
export async function aiRefineDocument({ title, blocks }, opts = {}) {
  const { onProgress, onBlocks, signal } = opts;

  // 图片块没有可修正的文本，直接跳过（省 token）
  const targets = blocks
    .map((block, index) => ({ index, block, line: '' }))
    .filter((t) => t.block.type !== 'image')
    .map((t) => ({ ...t, line: blockLine(t) }));

  const outline = blocks
    .filter((b) => b.type === 'heading')
    .map((b) => `  第 ${b.index + 1} 块：${b.text}`)
    .join('\n');

  const chunks = chunkBlocks(targets);
  const updated = new Map();
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  let model = '';
  const errors = [];

  onProgress?.({ phase: 'start', total: chunks.length, blocks: targets.length });

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    if (signal?.aborted) break;

    const userContent =
      `文档标题：${title}\n` +
      (outline ? `文档结构大纲（供参考，不需要你输出）：\n${outline}\n` : '') +
      `\n请修正下面 ${chunk.length} 个内容块，输出严格的 JSON：\n\n` +
      chunk.map((b) => b.line).join('\n');

    onProgress?.({
      phase: 'chunk',
      index: ci + 1,
      total: chunks.length,
      blockFrom: chunk[0].index,
      blockTo: chunk[chunk.length - 1].index,
      usage: { ...usage },
    });

    let parsed = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const res = await chatComplete({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          signal,
          jsonMode: true,
          maxTokens: 4096,
          overrides: { temperature: 0.1 },
        });
        model = res.model || model;
        if (res.usage) {
          usage.promptTokens += res.usage.prompt_tokens || 0;
          usage.completionTokens += res.usage.completion_tokens || 0;
          usage.totalTokens += res.usage.total_tokens || 0;
        }
        usage.calls += 1;
        parsed = parseJsonLoose(res.content);
      } catch (err) {
        if (err.name === 'AbortError') break;
        lastError = err;
      }
    }

    if (!parsed?.blocks?.length) {
      errors.push(`第 ${ci + 1} 批（块 ${chunk[0].index + 1}–${chunk[chunk.length - 1].index + 1}）修正失败：${lastError?.message || '返回格式无法解析'}`);
      continue;
    }

    const byN = new Map();
    for (const item of parsed.blocks) {
      const n = Number(item?.n);
      if (Number.isFinite(n)) byN.set(n, item);
    }

    const applied = [];
    for (const target of chunk) {
      const item = byN.get(target.index);
      if (!item) continue;
      const patch = {};
      const type = ['paragraph', 'heading', 'list', 'formula', 'table'].includes(item.type) ? item.type : null;
      if (type) patch.type = type;

      const wantFormula = type === 'formula' || target.block.type === 'formula';
      if (typeof item.tex === 'string' && item.tex.trim()) {
        patch.tex = item.tex.trim().replace(/^\$\$?/, '').replace(/\$\$?$/, '');
        patch.type = 'formula';
        patch.display = true;
        patch.text = `$$${patch.tex}$$`;
      }
      if (type === 'table') {
        const rows = normalizeRows(item.rows);
        if (rows) {
          patch.table = { rows, headerRow: true, cols: rows[0].length };
          patch.type = 'table';
        }
      }
      if (typeof item.text === 'string' && item.text.trim()) {
        const t = item.text.trim();
        if (!patch.tex) {
          patch.text = t;
          // 含 $...$ 就必须标记 rich，否则前端会把 LaTeX 原样显示
          patch.rich = hasMath(t);
        } else if (!/^\$\$/.test(t) && wantFormula) {
          // 公式块：text 里带的是可读线性形式，作为补充保留在 tex 之外
          patch.readable = t;
        }
      }
      if (!Object.keys(patch).length) continue;
      updated.set(target.index, patch);
      applied.push(target.index);
    }

    onBlocks?.(applied, updated);
    onProgress?.({
      phase: 'chunk-done',
      index: ci + 1,
      total: chunks.length,
      applied: applied.length,
      usage: { ...usage },
    });
  }

  onProgress?.({ phase: 'done', usage: { ...usage }, errors });

  return {
    patches: updated,
    usage,
    model,
    chunks: chunks.length,
    errors,
  };
}
