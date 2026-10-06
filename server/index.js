/**
 * 论文解析与提问网站 —— 后端服务
 * 端口：PORT（默认 8787）
 */
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, getConfig, saveConfig, writeEnvFile, UPLOAD_DIR } from './config.js';
import { parseDocument } from './parser.js';
import { chatStream, verifyKey, ApiError } from './deepseek.js';
import { estimateTokens } from './tokens.js';
import { buildContextMessages as buildReadingContext } from './context.js';
import { aiRefineDocument } from './aiparse.js';
import * as store from './store.js';
import { buildMarkdown, buildJson, buildDocx, exportFilename, summarize } from './export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ============================ 健康检查 ============================ */
app.get('/api/health', (req, res) => {
  const cfg = getConfig();
  res.json({ ok: true, time: new Date().toISOString(), hasKey: cfg.apiKeySource !== 'none' });
});

/* ============================== 配置 ============================== */
app.get('/api/config', (req, res) => {
  const cfg = getConfig();
  res.json({
    hasKey: cfg.apiKeySource !== 'none',
    apiKeyMasked: cfg.apiKey,
    apiKeySource: cfg.apiKeySource,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    maxContextTokens: cfg.maxContextTokens,
    systemPrompt: cfg.systemPrompt,
    contextMode: cfg.contextMode || 'paragraph',
    envKeyPresent: Boolean(String(process.env.DEEPSEEK_API_KEY || '').trim()),
  });
});

app.post(
  '/api/config',
  wrap(async (req, res) => {
    const cfg = saveConfig(req.body || {});
    res.json({ ok: true, config: { ...cfg, apiKey: cfg.apiKey } });
  }),
);

app.post(
  '/api/config/verify',
  wrap(async (req, res) => {
    const result = await verifyKey(req.body?.apiKey);
    res.json(result);
  }),
);

app.post(
  '/api/config/env',
  wrap(async (req, res) => {
    const key = String(req.body?.apiKey || '').trim();
    if (!key) throw new ApiError('请先填写 API 密钥', 400);
    writeEnvFile(key);
    saveConfig({ clearApiKey: true });
    res.json({ ok: true, message: '已写入 .env，并清除配置页中的密钥（改用环境变量）' });
  }),
);

/* =========================== 文档管理 =========================== */
app.post('/api/documents/:id/reparse', wrap(async (req, res) => {
  const previous = store.getDocument(req.params.id);
  if (!previous?.filePath || !fs.existsSync(previous.filePath)) throw new ApiError('原始文件不存在，无法重新解析', 400);
  const docId = store.newId('doc');
  const buffer = fs.readFileSync(previous.filePath);
  const parsed = await parseDocument({ buffer, filename:previous.filename, docId, assetsDir:store.assetDirFor(docId) });
  if (!parsed.paragraphs.length) throw new ApiError('未能从原文件中提取文本，请先 OCR 或粘贴识别后的文字', 400);
  const fresh = store.createDocument({ id:docId, title:previous.title + ' · 新版解析', filename:previous.filename, format:parsed.meta.format, size:buffer.length, meta:{ ...parsed.meta, reparsedFrom:previous.id }, paragraphs:parsed.paragraphs, assets:parsed.assets || [], pageImages:parsed.pageImages || [] });
  fresh.filePath = store.saveUpload(fresh.id, previous.filename, buffer);
  store.flush();
  res.json({ ok:true, document:publicDoc(fresh) });
}));
app.post(
  '/api/documents',
  upload.single('file'),
  wrap(async (req, res) => {
    const title = req.body?.title;
    let parsed;
    let filePath = null;
    let size = 0;

    // 先分配文档 id，解析器据此把图片资源直接落到该文档的资源目录
    const docId = store.newId('doc');
    const assetsDir = store.assetDirFor(docId);

    if (req.file) {
      size = req.file.size;
      const originalName = store.fixFilename(req.file.originalname);
      req.file.originalname = originalName;
      parsed = await parseDocument({
        buffer: req.file.buffer,
        filename: originalName,
        mimetype: req.file.mimetype,
        docId,
        assetsDir,
      });
    } else if (req.body?.pastedText) {
      parsed = await parseDocument({
        filename: title || '粘贴的文本',
        pastedText: req.body.pastedText,
        docId,
        assetsDir,
      });
    } else {
      throw new ApiError('请上传文件或粘贴文本内容', 400);
    }

    if (!parsed.paragraphs.length) {
      throw new ApiError(parsed.meta?.warning || '未能从该文件中提取到任何文本内容，请检查文件后重试。', 400);
    }

    const doc = store.createDocument({
      id: docId,
      title: title || parsed.meta.filename || '未命名文档',
      filename: parsed.meta.filename,
      format: parsed.meta.format,
      size,
      meta: parsed.meta,
      paragraphs: parsed.paragraphs,
      assets: parsed.assets || [],
      pageImages: parsed.pageImages || [],
    });

    if (req.file) {
      filePath = store.saveUpload(doc.id, req.file.originalname, req.file.buffer);
      doc.filePath = filePath;
      store.flush();
    }

    res.json({ ok: true, document: publicDoc(doc) });
  }),
);

/** 解析出的图片 / 页面影像资源 */
app.get('/api/documents/:id/assets/:file', (req, res, next) => {
  const doc = store.getDocument(req.params.id);
  if (!doc) return next(new ApiError('文档不存在', 404));
  const dir = store.assetDirFor(doc.id);
  const name = path.basename(req.params.file);
  if (!name || name.startsWith('.')) return next(new ApiError('非法资源名', 400));
  const full = path.join(dir, name);
  if (!full.startsWith(dir) || !fs.existsSync(full)) return next(new ApiError('资源不存在', 404));
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(full);
});

app.get('/api/documents', (req, res) => {
  res.json({ documents: store.listDocuments() });
});

app.get('/api/documents/:id', (req, res, next) => {
  const doc = store.getDocument(req.params.id);
  if (!doc) return next(new ApiError('文档不存在或已被删除', 404));
  res.json({ document: publicDoc(doc) });
});

app.patch(
  '/api/documents/:id',
  wrap(async (req, res) => {
    const doc = store.updateDocumentTitle(req.params.id, req.body?.title);
    if (!doc) throw new ApiError('文档不存在', 404);
    res.json({ ok: true, document: publicDoc(doc) });
  }),
);

app.delete('/api/documents/:id', (req, res, next) => {
  const ok = store.deleteDocument(req.params.id);
  if (!ok) return next(new ApiError('文档不存在', 404));
  res.json({ ok: true });
});

app.get('/api/documents/:id/file', (req, res, next) => {
  const doc = store.getDocument(req.params.id);
  if (!doc?.filePath || !fs.existsSync(doc.filePath)) return next(new ApiError('原始文件不存在', 404));
  const ext = path.extname(doc.filename || doc.filePath).toLowerCase();
  const mime =
    ext === '.pdf'
      ? 'application/pdf'
      : ext === '.docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/octet-stream';

  // inline=1：交给浏览器内置阅读器内联显示（用于「查看原页」）
  if (req.query.inline === '1' && ext === '.pdf') {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.filename || 'document.pdf')}`);
    res.setHeader('Cache-Control', 'private, max-age=600');
    return res.sendFile(doc.filePath);
  }
  res.download(doc.filePath, doc.filename || path.basename(doc.filePath));
});

/* ============================= 问答 ============================= */
app.get('/api/documents/:id/threads', (req, res, next) => {
  const doc = store.getDocument(req.params.id);
  if (!doc) return next(new ApiError('文档不存在', 404));
  res.json({ threads: doc.threads || {} });
});

app.delete(
  '/api/documents/:id/threads/:paragraphId',
  wrap(async (req, res) => {
    const ok = store.clearThread(req.params.id, req.params.paragraphId);
    res.json({ ok });
  }),
);

/** 修正单个块的内容（解析出的公式/表格常常需要人工订正） */
app.patch(
  '/api/documents/:id/paragraphs/:pid',
  wrap(async (req, res) => {
    const { text, tex, type } = req.body || {};
    if (text !== undefined && !String(text).trim()) throw new ApiError('内容不能为空', 400);
    const block = store.updateParagraph(req.params.id, req.params.pid, { text, tex, type });
    if (!block) throw new ApiError('文档或段落不存在', 404);
    res.json({ ok: true, block });
  }),
);

/** 清空某个块的人工修正 */
app.delete(
  '/api/documents/:id/paragraphs/:pid/edit',
  wrap(async (req, res) => {
    const restored = store.resetParagraph(req.params.id, req.params.pid);
    if (!restored) throw new ApiError('文档不存在或没有可还原的原始内容', 404);
    res.json({ ok: true, block: restored });
  }),
);

/* ======================= AI 精修解析 ======================= */

/**
 * 用 AI 修正本地解析结果（公式/表格/断词）。结果持久化保存，重复打开不再消耗 token。
 * SSE 事件：progress / applied / done / error
 */
app.post(
  '/api/documents/:id/ai-parse',
  wrap(async (req, res) => {
    const doc = store.getDocument(req.params.id);
    if (!doc) throw new ApiError('文档不存在', 404);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (obj) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    store.ensureLocalBackup(doc.id);
    const startedAt = new Date().toISOString();

    try {
      const result = await aiRefineDocument(
        { title: doc.title, blocks: doc.paragraphs || [] },
        {
          signal: controller.signal,
          onProgress: (p) => send({ type: 'progress', ...p }),
          onBlocks: (applied, patches) => {
            // 每批完成即落库，中断也不会白花 token
            store.applyAiRefine(doc.id, {
              patches,
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 },
              model: '',
              chunks: 0,
              errors: [],
              startedAt,
            });
            send({ type: 'applied', indexes: applied, totalBlocks: doc.paragraphs.length });
          },
        },
      );

      const info = store.applyAiRefine(doc.id, { ...result, startedAt });
      send({ type: 'done', aiParse: info, errors: result.errors });
      res.end();
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        const fresh = store.getDocument(doc.id);
        send({ type: 'aborted', aiParse: fresh?.aiParse || null });
        res.end();
        return;
      }
      send({ type: 'error', message: err.message || 'AI 精修失败' });
      res.end();
    }
  }),
);

/** 还原为本地解析结果 */
app.delete(
  '/api/documents/:id/ai-parse',
  wrap(async (req, res) => {
    const doc = store.restoreLocalParsed(req.params.id);
    if (!doc) throw new ApiError('文档不存在或没有可还原的本地解析结果', 404);
    res.json({ ok: true, document: publicDoc(doc) });
  }),
);

/** 上下文预算估算（用于「全文提问」提示） */app.get(
  '/api/documents/:id/context-budget',
  wrap(async (req, res) => {
    const doc = store.getDocument(req.params.id);
    if (!doc) throw new ApiError('文档不存在', 404);
    const cfg = getConfig({ withSecret: true });
    const totalChars = (doc.paragraphs || []).reduce((s, p) => s + (p.text?.length || 0), 0);
    res.json({
      totalChars,
      totalTokens: estimateTokens((doc.paragraphs || []).map((p) => p.text).join('\n')),
      budgetTokens: cfg.maxContextTokens,
      contextMode: cfg.contextMode,
      blocks: (doc.paragraphs || []).length,
    });
  }),
);

app.post(
  '/api/documents/:id/ask',
  wrap(async (req, res) => {
    const doc = store.getDocument(req.params.id);
    if (!doc) throw new ApiError('文档不存在', 404);

    const { paragraphId, question, citedParagraphIds, useStoredHistory = true, sourceImage } = req.body || {};
    const q = String(question || '').trim();
    if (!q) throw new ApiError('问题不能为空', 400);
    if (q.length > 4000) throw new ApiError('问题过长（上限 4000 字）', 400);

    const stored = store.getThread(req.params.id, paragraphId);
    const history = useStoredHistory ? stored?.messages || [] : req.body?.history || [];
    const cfg = getConfig({ withSecret:true });
    if (sourceImage && (typeof sourceImage !== 'string' || sourceImage.length > 2800000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sourceImage))) throw new ApiError('公式截图格式无效或过大，请重试', 400);
    const imageProvided = Boolean(sourceImage && /^(deepseek-flash|deepseek-v4-pro)$/.test(cfg.model) && cfg.maxContextTokens >= 6000 && doc.format === 'pdf');
    const built = buildReadingContext(doc, paragraphId, citedParagraphIds, q, history, { ...cfg, maxContextTokens:cfg.maxContextTokens-(imageProvided ? 3000 : 0) });
    if (imageProvided) built.messages[built.messages.length-1].content = [
      { type:'text', text:q+'\n附图为当前段落在原 PDF 中的截图。以原始截图为公式依据，提取文本可能有误。' },
      { type:'image_url', image_url:{ url:sourceImage } },
    ];
    const { messages, contextTokens, truncated, budget } = built;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (obj) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    const userMsg = store.appendMessage(req.params.id, paragraphId, {
      role: 'user',
      content: q,
      ...(citedParagraphIds?.length ? { citedParagraphIds } : {}),
    });
    send({ type: 'user_message', message: userMsg });
    send({ type: 'context', contextTokens, budget, truncated, contextMode: built.contextMode,
      includedParagraphIds: built.includedParagraphIds, historyTruncated: built.historyTruncated, imageProvided });

    const controller = new AbortController();
    let aborted = false;
    let partialText = '', partialReasoning = '';
    // 注意：不能用 req 的 'close'（Node 在请求体读完后即触发），必须用 res 且判断是否正常结束
    res.on('close', () => {
      if (!res.writableEnded) {
        aborted = true;
        controller.abort();
      }
    });

    try {
      const result = await chatStream({
        messages,
        signal: controller.signal,
        onDelta: (t) => { partialText += t; send({ type: 'delta', text: t }); },
        onReasoning: (t) => { partialReasoning += t; send({ type: 'reasoning', text: t }); },
      });

      const aiMsg = store.appendMessage(req.params.id, paragraphId, {
        role: 'assistant',
        content: result.content,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        model: result.model,
        usage: result.usage,
        includedParagraphIds: built.includedParagraphIds,
        contextMode: built.contextMode,
        truncated,
        imageProvided,
        ...(result.finishReason === 'length' ? { outputTruncated: true } : {}),
      });
      send({ type: 'done', message: aiMsg, usage: result.usage, model: result.model });
      res.end();
    } catch (err) {
      if (aborted || err.name === 'AbortError') {
        store.appendMessage(doc.id, paragraphId, { role:'assistant', content:partialText,
          reasoning:partialReasoning, interrupted:true, includedParagraphIds:built.includedParagraphIds });
        if (!res.writableEnded) {
          send({ type: 'aborted' });
          res.end();
        }
        return;
      }
      const message = err.message || 'AI 请求失败';
      store.appendMessage(req.params.id, paragraphId, {
        role: 'assistant',
        content: '',
        error: message,
      });
      send({ type: 'error', message });
      res.end();
    }
  }),
);

/* ============================= 导出 ============================= */
app.get(
  '/api/documents/:id/export',
  wrap(async (req, res) => {
    const doc = store.getDocument(req.params.id);
    if (!doc) throw new ApiError('文档不存在', 404);

    const format = String(req.query.format || 'markdown').toLowerCase();
    const includeOriginal = req.query.includeOriginal !== '0';
    const includeUnanswered = req.query.includeUnanswered === '1';
    const asComments = req.query.comments !== '0';
    const base = exportFilename(doc, '').replace(/\.$/, '');

    if (format === 'markdown' || format === 'md') {
      const md = buildMarkdown(doc, { includeOriginal, includeUnanswered });
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.md`)}`);
      return res.send(md);
    }

    if (format === 'json') {
      const data = buildJson(doc, { includeOriginal, includeUnanswered });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.json`)}`);
      return res.send(JSON.stringify(data, null, 2));
    }

    if (format === 'docx' || format === 'word') {
      const buffer = await buildDocx(doc, { includeOriginal, asComments });
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(`${base}${asComments ? '-批注版' : ''}.docx`)}`,
      );
      return res.send(buffer);
    }

    if (format === 'html') {
      // 供前端「导出 PDF（打印）」使用：返回可打印 HTML（不下载，直接渲染）
      const { buildMarkdown } = await import('./export.js');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.json({ ok: true, markdown: buildMarkdown(doc, { includeOriginal, includeUnanswered }) });
    }

    throw new ApiError(`不支持的导出格式：${format}`, 400);
  }),
);

app.get('/api/documents/:id/summary', (req, res, next) => {
  const doc = store.getDocument(req.params.id);
  if (!doc) return next(new ApiError('文档不存在', 404));
  res.json({ summary: summarize(doc) });
});

/* ======================= 静态资源（前端构建产物） ======================= */
const distDir = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (req, res) => {
    res
      .status(200)
      .type('html')
      .send(
        '<h1>前端尚未构建</h1><p>请运行 <code>npm run build</code>，或使用 <code>npm run dev</code> 启动开发服务器（http://127.0.0.1:5173）。</p>',
      );
  });
}

/* =========================== 错误处理 =========================== */
app.use((err, req, res, next) => {
  const status = err.statusCode || err.status || 500;
  if (status >= 500) console.error('[error]', err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: err.message || '服务器内部错误', detail: err.detail });
});

const server = app.listen(PORT, HOST, () => {
  const cfg = getConfig();
  console.log(`\n  论文解析与提问网站 · 后端已启动`);
  console.log(`  ➜  http://${HOST}:${PORT}`);
  console.log(`  ➜  DeepSeek 密钥：${cfg.apiKeySource === 'none' ? '未配置（请在页面右上角「设置」中填写）' : `已配置（来源：${cfg.apiKeySource === 'env' ? '环境变量' : '配置页'}）`}`);
  console.log(`  ➜  数据目录：${path.join(ROOT, 'data')}\n`);
});

const shutdown = () => {
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function publicDoc(doc) {
  return {
    id: doc.id,
    title: doc.title,
    filename: doc.filename,
    format: doc.format,
    size: doc.size,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    meta: doc.meta,
    paragraphs: doc.paragraphs,
    assets: doc.assets || [],
    pageImages: doc.pageImages || [],
    threads: doc.threads || {},
    aiParse: doc.aiParse || null,
    hasLocalBackup: Boolean(doc.localParsedBackup),
    hasOriginalFile: Boolean(doc.filePath),
  };
}

export { app, UPLOAD_DIR };
