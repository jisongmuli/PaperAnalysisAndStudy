/**
 * 本地模拟 DeepSeek API（OpenAI 兼容，支持 SSE 流式），仅用于端到端自测。
 * 用法：node scripts/mock-deepseek.mjs [port]
 * 校验：Authorization 必须为 mock 前缀或任意非空值
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 8899);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'missing api key' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }));
  }

  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        /* ignore */
      }
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: '密钥无效' } }));
      }

      const msgs = payload.messages || [];
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
      const context = msgs[0]?.role === 'system' ? msgs[1]?.content || '' : '';
      const round = msgs.filter((m) => m.role === 'user').length;

      // ---- AI 精修解析（JSON 结构化输出）----
      if (payload.response_format?.type === 'json_object') {
        const lines = lastUser.split('\n').filter((l) => /^\[\d+\] \(/.test(l));
        const typeMap = { 段落: 'paragraph', 标题: 'heading', 公式: 'formula', 表格: 'table', 图片: 'image', 列表: 'list' };
        const blocks = lines.map((line) => {
          const m = /^\[(\d+)\] \(([^)]+)\) ([\s\S]*)$/.exec(line);
          if (!m) return null;
          const n = Number(m[1]);
          const tag = m[2];
          let type = typeMap[tag] || 'paragraph';
          let text = m[3];
          const out = { n, type, text };
          // 模拟「把形如 1引言 的段落识别为标题」
          if (type === 'paragraph' && /^\d+\s*[\u4e00-\u9fff]{2,6}$/.test(text.trim())) {
            out.type = 'heading';
          }
          if (type === 'formula') {
            out.tex = text.replace(/\$\$/g, '').trim();
            out.text = out.tex;
          }
          if (type === 'table') {
            out.rows = text
              .split('⏎')
              .map((r) => r.split(/\s{2,}|\|/).map((c) => c.trim()).filter(Boolean))
              .filter((r) => r.length);
            if (!out.rows.length) out.type = 'paragraph';
          }
          return out;
        }).filter(Boolean);

        const body = JSON.stringify({ blocks });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 'mock-refine',
            model: payload.model,
            choices: [{ index: 0, message: { role: 'assistant', content: body }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1200, completion_tokens: 620, total_tokens: 1820 },
          }),
        );
      }

      const answer = [
        `### 针对本段的回答（第 ${round} 轮）`,
        '',
        `**你的问题：** ${lastUser}`,
        '',
        '根据所给段落，可以归纳为以下三点：',
        '',
        '1. 该段落提出了一个**核心论点**，并在上下文 `section` 中给出了支撑。',
        '2. 论据主要来自两方面：公开数据集上的实验结果与消融分析。',
        '3. 作者同时指出了局限性，例如长文档建模仍待改进。',
        '',
        '其中归一化采用配比闭合修正：',
        '',
        '$$p_{ri} = \\frac{x_{ri}}{\\sum_{j=1}^{17} x_{rj}}, \\quad p_{ri} \\ge 0, \\quad \\sum_i p_{ri} = 1$$',
        '',
        `这里的 $x_{ri}$ 是第 $r$ 组配方中第 $i$ 个领域的原始比例，行内公式 $E = mc^2$ 也应正常渲染。`,
        '',
        '$$s_{ij} = \\sum_{k=0}^{5} k \\cdot \\frac{\\exp(l_{ijk})}{\\sum_{h=0}^{5}\\exp(l_{ijh})}$$',
        '',
        `> 上下文长度：${context.length} 字符`,
        '',
        '| 维度 | 结论 |',
        '| --- | --- |',
        '| 方法 | 三阶段多模态框架 |',
        '| 效果 | F1 +2.3 |',
        '',
        '```python',
        'print("mock answer")',
        '```',
      ].join('\n');

      if (!payload.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 'mock-1',
            model: payload.model,
            choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 120, total_tokens: 220 },
          }),
        );
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const chunks = answer.match(/[\s\S]{1,18}/g) || [];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= chunks.length) {
          clearInterval(timer);
          res.write(
            `data: ${JSON.stringify({
              id: 'mock-1',
              model: payload.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 100, completion_tokens: 120, total_tokens: 220 },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(
          `data: ${JSON.stringify({
            id: 'mock-1',
            model: payload.model,
            choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }],
          })}\n\n`,
        );
        i += 1;
      }, 12);

      res.on('close', () => {
        if (!res.writableEnded) clearInterval(timer);
      });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-deepseek] listening on http://127.0.0.1:${PORT}`);
});
