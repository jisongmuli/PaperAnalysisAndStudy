/**
 * 导出：Markdown / JSON / Word（含批注）
 */
import {
  Document as DocxDocument,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Comment,
  CommentRangeStart,
  CommentRangeEnd,
  CommentReference,
  BorderStyle,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ImageRun,
  Math as DocxMath,
} from 'docx';
import fs from 'node:fs';
import path from 'node:path';
import { countQuestions, assetDirFor } from './store.js';
import { latexToMathComponents } from './latexMath.js';

const AUTHOR = 'AI 解析助手';

function safeName(name) {
  return String(name || 'document')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .slice(0, 80);
}

function paragraphMap(doc) {
  const map = new Map();
  for (const p of doc.paragraphs || []) map.set(p.id, p);
  return map;
}

/** 把消息序列配对成 [问, 答] 列表 */
function pairMessages(messages = []) {
  const qa = [];
  let pending = null;
  for (const m of messages) {
    if (m.role === 'user') {
      if (pending) qa.push({ ...pending, answer: '' });
      pending = { question: m.content, answer: '', createdAt: m.createdAt, cited: m.citedParagraphIds };
    } else if (m.role === 'assistant' && pending) {
      pending.answer = m.content;
      pending.error = m.error;
      qa.push(pending);
      pending = null;
    }
  }
  if (pending) qa.push({ ...pending, answer: '' });
  return qa;
}

/** 把文档整理为统一的「条目」列表（含所有提问） */
export function toItems(doc, { onlyAnswered = false } = {}) {
  const items = [];
  for (const p of doc.paragraphs || []) {
    const qa = pairMessages(doc.threads?.[p.id]?.messages || []);
    if (onlyAnswered && qa.length === 0) continue;
    items.push({
      paragraphId: p.id,
      index: p.index,
      page: p.page,
      type: p.type,
      level: p.level,
      text: p.text,
      rich: p.rich,
      tex: p.tex,
      table: p.table,
      images: p.images,
      qa,
    });
  }
  // 跨段落提问记录在 __cross__ 虚拟线程里
  const crossQa = pairMessages(doc.threads?.__cross__?.messages || []);
  if (crossQa.length) {
    items.push({
      paragraphId: '__cross__',
      index: -1,
      type: 'cross',
      text: '（跨段落关联提问）',
      qa: crossQa,
      cross: true,
    });
  }
  return items;
}

export function summarize(doc) {
  const items = toItems(doc);
  const answered = items.filter((i) => i.qa.length > 0);
  return {
    documentId: doc.id,
    title: doc.title,
    filename: doc.filename,
    format: doc.format,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    paragraphCount: doc.paragraphs?.length || 0,
    questionCount: countQuestions(doc),
    answeredParagraphCount: answered.length,
    pageCount: doc.meta?.pages,
  };
}

function citeLabel(cited, pmap) {
  if (!cited || !cited.length) return '';
  return cited
    .map((id) => {
      const p = pmap?.get(id);
      return p ? `[段落 ${p.index + 1}]` : `[${id}]`;
    })
    .join(' ');
}

/** 把表格渲染为 Markdown 表格 */
function tableToMarkdown(table) {
  const rows = table?.rows || [];
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const header = rows[0];
  const lines = [
    `| ${Array.from({ length: cols }, (_, i) => cell(header[i])).join(' | ')} |`,
    `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`,
  ];
  for (const r of rows.slice(1)) {
    lines.push(`| ${Array.from({ length: cols }, (_, i) => cell(r[i])).join(' | ')} |`);
  }
  return lines.join('\n');
}

/** 块 → Markdown 片段 */
function blockToMarkdown(item) {
  if (item.type === 'table') return tableToMarkdown(item.table);
  if (item.type === 'image') {
    return (item.images || []).map((im, i) => `![插图 ${i + 1}](${im.url})`).join('\n\n');
  }
  return String(item.text || '');
}

/* ------------------------------ Markdown ------------------------------ */
export function buildMarkdown(doc, { includeOriginal = true, includeUnanswered = false } = {}) {
  const s = summarize(doc);
  const pmap = paragraphMap(doc);
  // 章节一尽量还原原文档（含未提问的表格/图片/公式），章节二只列问答
  const allItems = toItems(doc, { onlyAnswered: false });
  const answeredItems = allItems.filter((i) => i.qa.length > 0);
  const lines = [];

  lines.push(`# ${s.title}`, '');
  lines.push(
    `> 来源文件：\`${s.filename || '（粘贴文本）'}\` ｜ 段落：${s.paragraphCount}` +
      `${s.pageCount ? ` ｜ 页数：${s.pageCount}` : ''} ｜ 提问：${s.questionCount} 条 ｜ 导出时间：${new Date().toLocaleString('zh-CN')}`,
  );
  lines.push('', '---', '');

  if (!answeredItems.length) {
    lines.push('_（暂无问答记录）_', '');
  }

  if (includeOriginal) {
    lines.push('## 一、原文与问答（逐块）', '');
    for (const item of allItems) {
      const p = pmap.get(item.paragraphId);
      const label = item.cross
        ? '跨段落关联提问'
        : `${item.type === 'table' ? '表格' : item.type === 'image' ? '插图' : item.type === 'formula' ? '公式' : '段落'} ${item.index + 1}`;
      lines.push(`### ${label}${p?.page ? `（第 ${p.page} 页）` : ''}`, '');
      const body = blockToMarkdown(item);
      if (item.type === 'image' || item.type === 'table') {
        lines.push(body, '');
      } else {
        lines.push(`> ${body.replace(/\n+/g, ' ')}`, '');
      }
      for (const qa of item.qa) {
        const cite = citeLabel(qa.cited, pmap);
        lines.push(`**问${cite ? ` ${cite}` : ''}：** ${qa.question}`, '');
        lines.push(`**答：**`, '', qa.answer ? qa.answer : '_（未获得回答）_', '');
      }
      lines.push('---', '');
    }
  }

  lines.push('## 二、问答记录清单', '');
  let n = 0;
  for (const item of includeUnanswered ? allItems : answeredItems) {
    for (const qa of item.qa) {
      n += 1;
      const cite = citeLabel(qa.cited, pmap);
      lines.push(
        `**Q${n}**${item.cross ? '（跨段落）' : `（段落 ${item.index + 1}）`}${cite ? ` ${cite}` : ''}：${qa.question}`,
        '',
      );
      lines.push(qa.answer ? qa.answer : '_（未获得回答）_', '');
    }
  }
  if (n === 0) lines.push('_（暂无问答记录）_', '');

  return lines.join('\n');
}

/* ------------------------------ JSON ------------------------------ */
export function buildJson(doc, { includeOriginal = true, includeUnanswered = false } = {}) {
  const pmap = paragraphMap(doc);
  const allItems = toItems(doc, { onlyAnswered: false });
  const items = includeOriginal || includeUnanswered ? allItems : allItems.filter((i) => i.qa.length > 0);
  return {
    exportedAt: new Date().toISOString(),
    generator: '论文解析与提问网站',
    document: summarize(doc),
    items: items.map((item) => ({
      paragraphId: item.paragraphId,
      paragraphNumber: item.cross ? null : item.index + 1,
      page: pmap.get(item.paragraphId)?.page ?? null,
      type: item.type || 'paragraph',
      crossParagraph: !!item.cross,
      ...(includeOriginal ? { text: item.text } : {}),
      ...(item.tex ? { tex: item.tex } : {}),
      ...(item.table ? { table: item.table } : {}),
      ...(item.images ? { images: item.images } : {}),
      ...(item.cross ? { citedParagraphIds: item.qa[0]?.cited || [] } : {}),
      qa: item.qa.map((qa) => ({
        question: qa.question,
        answer: qa.answer || null,
        error: qa.error || null,
        citedParagraphIds: qa.cited || [],
        askedAt: qa.createdAt,
      })),
    })),
  };
}

/* ------------------------------ Word ------------------------------ */

/** 行内 $...$ → 文本与 Word 原生公式混排 */
function inlineMathChildren(line, { size = 20 } = {}) {
  const parts = String(line ?? '')
    .split(/(\$[^$\n]+\$)/g)
    .filter((p) => p !== '');
  const children = parts.map((part) => {
    if (part.length > 2 && part.startsWith('$') && part.endsWith('$')) {
      return new DocxMath({ children: latexToMathComponents(part.slice(1, -1)) });
    }
    return new TextRun({ text: part, size });
  });
  return children.length ? children : [new TextRun({ text: '', size })];
}

/** 批注锚点：图片/表格无法被批注范围包裹，用一个近乎不可见的锚点段落 */
function commentAnchorParagraph(id, label) {
  return new Paragraph({
    spacing: { before: 0, after: 0 },
    children: [
      new CommentRangeStart(id),
      new TextRun({ text: label, size: 2, color: 'FFFFFF' }),
      new CommentRangeEnd(id),
      new TextRun({ children: [new CommentReference(id)] }),
    ],
  });
}

function imageRun(im, assetsDir) {
  try {
    const name = path.basename(String(im.url || '').split('?')[0]);
    const full = path.join(assetsDir, name);
    if (!fs.existsSync(full)) return null;
    const data = fs.readFileSync(full);
    const ext = path.extname(name).slice(1).toLowerCase();
    const type = ext === 'jpeg' ? 'jpg' : ext || 'png';
    const MAX_W = 520;
    let w = Number(im.width) || 460;
    let h = Number(im.height) || 320;
    if (!Number.isFinite(w) || w <= 0) w = 460;
    if (!Number.isFinite(h) || h <= 0) h = Math.round(w * 0.7);
    if (w > MAX_W) {
      h = Math.max(1, Math.round(h * (MAX_W / w)));
      w = MAX_W;
    }
    return new ImageRun({ data, transformation: { width: w, height: h }, type });
  } catch {
    return null;
  }
}

function docxTable(table) {
  const rows = table?.rows || [];
  if (!rows.length) return null;
  const headerRow = table.headerRow !== false;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (r, ri) =>
        new TableRow({
          tableHeader: headerRow && ri === 0,
          children: r.map(
            (c) =>
              new TableCell({
                children: [
                  new Paragraph({
                    spacing: { before: 20, after: 20 },
                    children: [
                      new TextRun({ text: String(c ?? ''), size: 18, bold: headerRow && ri === 0 }),
                    ],
                  }),
                ],
              }),
          ),
        }),
    ),
  });
}

/** 把一个文档块转成 Word 元素（段落 / 表格 / 图片 / 公式） */
function blockChildren(p, { heading, anchorId, assetsDir }) {
  const out = [];
  const hasAnchor = anchorId !== null && anchorId !== undefined;

  if (p.type === 'table') {
    if (hasAnchor) out.push(commentAnchorParagraph(anchorId, ' '));
    out.push(
      new Paragraph({
        spacing: { before: 80, after: 40 },
        children: [new TextRun({ text: `表 ${p.index + 1}`, bold: true, size: 18, color: '666666' })],
      }),
    );
    const t = docxTable(p.table);
    if (t) out.push(t);
    out.push(new Paragraph({ text: '', spacing: { after: 120 } }));
    return out;
  }

  if (p.type === 'image') {
    if (hasAnchor) out.push(commentAnchorParagraph(anchorId, ' '));
    const runs = (p.images || []).map((im) => imageRun(im, assetsDir)).filter(Boolean);
    out.push(
      runs.length
        ? new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 80, after: 60 },
            children: runs,
          })
        : new Paragraph({ text: '［图片］', alignment: AlignmentType.CENTER }),
    );
    return out;
  }

  if (p.type === 'formula') {
    if (hasAnchor) out.push(commentAnchorParagraph(anchorId, ' '));
    const tex = p.tex || String(p.text || '').replace(/^\$\$?/, '').replace(/\$\$?$/, '');
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 100, after: 100 },
        children: [new DocxMath({ children: latexToMathComponents(tex) })],
      }),
    );
    return out;
  }

  // 普通文本块：行内公式转成 Word 原生公式，其余为文本
  const src = String(p.text || '');
  const children = inlineMathChildren(src, { size: 22 });
  if (hasAnchor) {
    out.push(
      new Paragraph({
        heading,
        children: [
          new CommentRangeStart(anchorId),
          ...children,
          new CommentRangeEnd(anchorId),
          new TextRun({ children: [new CommentReference(anchorId)] }),
        ],
      }),
    );
  } else {
    out.push(new Paragraph({ heading, children }));
  }
  return out;
}

function answerParagraphs(text, { prefix = '' } = {}) {
  const raw = String(text || '').trim() || '（未获得回答）';
  const lines = raw.split(/\r?\n/);
  const out = [];

  /** 行内 $...$ → 文本与真公式混排 */
  const inlineChildren = (line) => inlineMathChildren(line, { size: 20 });

  let i = 0;
  let first = true;
  while (i < lines.length) {
    const t = lines[i].trim();

    // 块级公式 $$...$$ → Word 原生公式
    if (t.startsWith('$$')) {
      const buf = [];
      let rest = t.replace(/^\$\$/, '');
      if (/\$\$$/.test(rest)) {
        buf.push(rest.replace(/\$\$$/, ''));
        i += 1;
      } else {
        buf.push(rest);
        i += 1;
        while (i < lines.length && !/\$\$/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) {
          buf.push(lines[i].replace(/\$\$/, ''));
          i += 1;
        }
      }
      out.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 80, after: 80 },
          children: [new DocxMath({ children: latexToMathComponents(buf.join(' ').trim()) })],
        }),
      );
      first = false;
      continue;
    }

    if (t !== '' || lines.length === 1) {
      out.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [
            ...(first && prefix ? [new TextRun({ text: prefix, color: '888888', size: 18 })] : []),
            ...inlineChildren(t),
          ],
        }),
      );
    }
    first = false;
    i += 1;
  }

  return out.length ? out : [new Paragraph('（未获得回答）')];
}

/**
 * 生成 Word 文档
 * @param {object} doc 文档对象
 * @param {{includeOriginal?: boolean, asComments?: boolean}} opts
 */export async function buildDocx(doc, { includeOriginal = true, asComments = true } = {}) {
  const s = summarize(doc);
  const pmap = paragraphMap(doc);
  const items = toItems(doc, { onlyAnswered: false });
  const answered = items.filter((i) => i.qa.length > 0);
  const assetsDir = assetDirFor(doc.id);

  const children = [];
  const comments = [];
  let commentId = 0;

  children.push(
    new Paragraph({ text: s.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [
        new TextRun({
          text:
            `来源文件：${s.filename || '（粘贴文本）'}　段落数：${s.paragraphCount}` +
            `${s.pageCount ? `　页数：${s.pageCount}` : ''}　提问数：${s.questionCount}`,
          color: '666666',
          size: 18,
        }),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `导出时间：${new Date().toLocaleString('zh-CN')}　生成工具：论文解析与提问网站`, color: '666666', size: 18 }),
      ],
      spacing: { after: 240 },
    }),
  );

  if (includeOriginal && asComments) {
    children.push(new Paragraph({ text: '正文（问答以批注形式标注）', heading: HeadingLevel.HEADING_1 }));

    // 段落自身的问答 + 引用了该段落的跨段落问答，都挂在同一个批注里
    const commentByParagraph = new Map();
    const bucket = (pid) => {
      if (!commentByParagraph.has(pid)) commentByParagraph.set(pid, { own: [], cross: [] });
      return commentByParagraph.get(pid);
    };
    for (const item of answered) {
      if (item.cross) {
        for (const pid of item.qa[0]?.cited || []) {
          if (pmap.has(pid)) bucket(pid).cross.push(item);
        }
      } else {
        bucket(item.paragraphId).own.push(item);
      }
    }

    for (const p of doc.paragraphs || []) {
      const entry = commentByParagraph.get(p.id);
      const heading =
        p.type === 'heading'
          ? p.level === 1
            ? HeadingLevel.HEADING_2
            : HeadingLevel.HEADING_3
          : undefined;

      const anchorId = entry ? commentId++ : null;
      if (entry) {
        const commentChildren = [];
        const appendQa = (qa, prefix, first) => {
          commentChildren.push(
            new Paragraph({
              spacing: { before: first ? 0 : 120, after: 60 },
              children: [
                new TextRun({ text: prefix, bold: true, size: 20 }),
                new TextRun({ text: qa.question, size: 20 }),
              ],
            }),
          );
          commentChildren.push(
            new Paragraph({
              spacing: { after: 40 },
              children: [new TextRun({ text: '答：', bold: true, size: 20 })],
            }),
          );
          commentChildren.push(...answerParagraphs(qa.answer));
        };

        let qi = 0;
        for (const item of entry.own) {
          for (const qa of item.qa) {
            qi += 1;
            const cite = citeLabel(qa.cited, pmap);
            appendQa(qa, `问${qi}${cite ? `（引用 ${cite}）` : ''}：`, qi === 1);
          }
        }
        for (const item of entry.cross) {
          const cite = citeLabel(item.qa[0]?.cited, pmap);
          for (const qa of item.qa) {
            qi += 1;
            appendQa(qa, `问${qi}（跨段落关联提问，引用 ${cite}）：`, qi === 1);
          }
        }

        const citeTxt = citeLabel(entry.own[0]?.qa[0]?.cited, pmap);
        const extra = entry.cross.length ? '（含跨段落关联提问）' : '';
        comments.push({
          id: anchorId,
          author: AUTHOR,
          initials: 'AI',
          date: new Date(),
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: `段落 ${p.index + 1}${p.page ? `（第 ${p.page} 页）` : ''} 的问答${extra}${citeTxt ? ` ${citeTxt}` : ''}`,
                  bold: true,
                  size: 18,
                  color: '4472C4',
                }),
              ],
            }),
            ...commentChildren,
          ],
        });
      }

      children.push(...blockChildren(p, { heading, anchorId, assetsDir }));
    }
  } else if (includeOriginal) {
    children.push(new Paragraph({ text: '正文', heading: HeadingLevel.HEADING_1 }));
    for (const p of doc.paragraphs || []) {
      const heading =
        p.type === 'heading'
          ? p.level === 1
            ? HeadingLevel.HEADING_2
            : HeadingLevel.HEADING_3
          : undefined;
      children.push(...blockChildren(p, { heading, anchorId: null, assetsDir }));
    }
  }

  // 问答附录
  children.push(new Paragraph({ text: '问答记录', heading: HeadingLevel.HEADING_1 }));
  let n = 0;
  for (const item of answered) {
    const p = pmap.get(item.paragraphId);
    for (const qa of item.qa) {
      n += 1;
      const cite = citeLabel(qa.cited, pmap);
      children.push(
        new Paragraph({
          spacing: { before: 200, after: 60 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD' } },
          children: [
            new TextRun({
              text: item.cross
                ? `Q${n}　跨段落关联提问${cite ? ` ${cite}` : ''}`
                : `Q${n}　段落 ${item.index + 1}${p?.page ? `（第 ${p.page} 页）` : ''}${cite ? ` ${cite}` : ''}`,
              bold: true,
              color: '2F5597',
              size: 22,
            }),
          ],
        }),
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({ text: '原文：', bold: true, size: 20, color: '888888' }),
            new TextRun({
              text: String(item.text)
                .replace(/\$\$([^$]+)\$\$/g, '$1')
                .replace(/\$([^$]+)\$/g, '$1')
                .replace(/\n+/g, ' '),
              size: 20,
              color: '888888',
              italics: true,
            }),
          ],
        }),
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({ text: '问：', bold: true, size: 22 }),
            new TextRun({ text: qa.question, size: 22 }),
          ],
        }),
        new Paragraph({ children: [new TextRun({ text: '答：', bold: true, size: 22 })] }),
        ...answerParagraphs(qa.answer),
      );
    }
  }
  if (n === 0) children.push(new Paragraph({ text: '（暂无问答记录）' }));

  const document = new DocxDocument({
    creator: '论文解析与提问网站',
    title: s.title,
    description: `导出自 ${s.filename || '粘贴文本'}`,
    ...(comments.length ? { comments: { children: comments } } : {}),
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(document);
}

export function exportFilename(doc, ext) {
  return `${safeName(doc.title)}-问答记录.${ext}`;
}
