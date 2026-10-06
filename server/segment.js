/**
 * 文本分段工具：把纯文本切分为有意义的段落。
 * 同时提供 DOCX / PDF 解析结果共用的清洗与长段二次切分逻辑。
 */

const SENTENCE_END = /[。！？；!?;：:]\s*$/;
const HARD_END = /[。！？!?]\s*$/;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\u3000/g, ' ')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/[ ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** 判断一行是否像标题（编号开头 / 全大写 / 很短无句号） */
export function looksLikeHeading(line) {
  const t = line.trim();
  if (!t || t.length > 90) return false;
  if (/^(第[一二三四五六七八九十百\d]+[章节部分篇]|[一二三四五六七八九十]+[、.．]|\d+(\.\d+)*[、.．\s])\s*\S/.test(t)) return true;
  if (/^(abstract|introduction|related work|background|method(s|ology)?|experiment(s)?|result(s)?|discussion|conclusion(s)?|references|acknowledg(e)?ments?)\b/i.test(t)) return true;
  if (/^(摘要|关键词|引言|绪论|背景|相关工作|研究方法|方法|实验|结果|讨论|结论|参考文献|致谢)\s*[:：]?$/.test(t)) return true;
  if (t.length <= 40 && !/[。．.,，;；:：]$/.test(t) && !CJK.test(t) && /^[A-Z0-9][A-Za-z0-9 ,\-:()/]{0,60}$/.test(t) && t === t.toUpperCase()) return true;
  return false;
}

/** 超长段落按句子边界二次切分，尽量贴近 maxLen */
export function splitLongParagraph(text, maxLen = 900) {
  if (text.length <= maxLen * 1.4) return [text];
  const sentences = text.match(/[^。！？!?；;\n]+[。！？!?；;]?|\n/g) || [text];
  const out = [];
  let buf = '';
  for (const s of sentences) {
    if (buf && (buf + s).length > maxLen) {
      out.push(buf.trim());
      buf = '';
    }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

function pushBlock(blocks, text, type = 'paragraph') {
  const t = text.trim();
  if (!t) return;
  for (const piece of splitLongParagraph(t)) {
    if (piece.trim()) blocks.push({ text: piece.trim(), type });
  }
}

/**
 * 纯文本 / TXT 分段：空行优先，其次标题识别、行尾标点、缩进。
 * @param {string} raw
 * @param {{ mode?: 'txt' | 'pdf' }} [opts]
 */
export function segmentText(raw, opts = {}) {
  const mode = opts.mode || 'txt';
  const text = normalizeWhitespace(raw);
  const blocks = [];

  const chunks = text.split(/\n{2,}/);
  for (const chunk of chunks) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    let buf = '';
    const flush = (type = 'paragraph') => {
      if (buf.trim()) pushBlock(blocks, buf, type);
      buf = '';
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isHeading = looksLikeHeading(line);
      // PDF 抽取的单行文本：行尾无硬标点说明是换行折行，应拼回同一段
      const joinPdf = mode === 'pdf' && buf && !HARD_END.test(buf) && !/^\s*[-•·*]\s/.test(line);

      if (isHeading && line.length <= 60) {
        flush();
        pushBlock(blocks, line, 'heading');
        continue;
      }
      if (/^\s*[-•·*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        flush();
        pushBlock(blocks, line, 'list');
        continue;
      }
      if (!buf) {
        buf = line;
      } else if (joinPdf && !CJK.test(line.slice(-1)) && !/[。！？；]$/.test(buf)) {
        buf += ' ' + line;
      } else if (joinPdf) {
        buf += line;
      } else {
        // TXT 模式：单换行通常仍是同一段，除非上一行以句末标点结束且当前行像新起句
        if (SENTENCE_END.test(buf) && /^[A-Z\u4e00-\u9fff]/.test(line) && buf.length > 60) {
          flush();
          buf = line;
        } else if (CJK.test(buf.slice(-1)) || CJK.test(line.charAt(0))) {
          buf += line;
        } else {
          buf += ' ' + line;
        }
      }
    }
    flush();
  }

  return blocks;
}
