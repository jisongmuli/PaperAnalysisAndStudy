/**
 * 端到端界面自测：用无头 Chrome 通过 CDP 真实驱动页面并截图。
 * 前置：mock-deepseek 在 8899，应用服务在 8787，且 /api/config 已指向 mock。
 * 用法：node scripts/uicheck.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'data', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

const APP = process.env.APP_URL || 'http://127.0.0.1:8787';
const CDP_PORT = Number(process.env.CDP_PORT || 9333);

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error('未找到 Chrome/Edge');
  process.exit(1);
}

const userDataDir = path.join(os.tmpdir(), `paperinsight-cdp-${Date.now()}`);
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-extensions',
    '--window-size=1680,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error('无法连接 Chrome 调试端口');
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error(`WebSocket 错误: ${e.message || e.type}`)));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      // 自动接受 window.confirm / alert，否则页面会阻塞导致 evaluate 超时
      if (msg.method === 'Page.javascriptDialogOpening') {
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 60000);
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面脚本错误: ${d.exception?.description || d.text}`);
    }
    return r.result?.value;
  }

  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(outDir, name);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  📷 ${name}`);
    return file;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const HELPERS = `
window.__t = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => [...document.querySelectorAll(sel)],
  byText: (sel, text) => [...document.querySelectorAll(sel)].find(e => (e.textContent||'').trim().includes(text)),
  click: (sel, text) => {
    const el = text ? window.__t.byText(sel, text) : document.querySelector(sel);
    if (!el) throw new Error('找不到元素: ' + sel + (text ? ' / ' + text : ''));
    el.click();
    return true;
  },
  set: (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  setSel: (sel, value, index = 0) => {
    const el = [...document.querySelectorAll(sel)][index];
    if (!el) throw new Error('找不到输入框: ' + sel + '[' + index + ']');
    return window.__t.set(el, value);
  },
  wait: async (fn, timeout = 25000, label = '') => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (fn()) return true; } catch (e) { /* keep waiting */ }
      await new Promise(r => setTimeout(r, 120));
    }
    throw new Error('等待超时: ' + (label || fn.toString()));
  },
  waitSel: (sel, timeout) => window.__t.wait(() => !!document.querySelector(sel), timeout, sel),
  txt: (sel) => (document.querySelector(sel)?.textContent || '').trim(),
};
true;
`;

let failures = 0;
const check = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

const PASTE_TEXT = `基于深度学习的文档理解研究综述

摘要

本文系统综述了深度学习在文档理解领域的研究进展。文档理解旨在从非结构化文档中抽取结构化信息，涵盖版面分析、文本识别与语义抽取等子任务。随着预训练语言模型的兴起，该领域取得了显著进展。

1 引言

文档是人类知识传承的主要载体。据估计，企业数据中约百分之八十以非结构化文档形式存在，包括合同、发票与学术论文等。如何让机器自动理解这些文档，成为信息检索与知识管理的关键问题。

2 相关工作

早期工作如 LayoutLM 将文本、位置与图像三种模态联合编码，在表单理解任务上取得了领先效果。后续工作通过引入视觉主干网络进一步提升了性能。

3 方法

本文提出的框架包含三个阶段：文档图像预处理、多模态特征编码与结构化解码。解码阶段采用受限解码策略，保证输出符合目标模式。

成员判对率是 $a_{train}$，非成员判对率是 $1-a_{test}$，整体准确率为 $Acc = \frac{a_{train}+1-a_{test}}{2}$。

4 结论

未来工作将探索更高效的预训练策略以及面向长文档的层次化建模方法。`;

async function main() {
  const target = await findTarget();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1680,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  console.log('\n[1] 首屏');
  await cdp.send('Page.navigate', { url: APP });
  await sleep(1500);
  await cdp.evaluate(HELPERS, { awaitPromise: false });
  await cdp.evaluate(`window.__t.waitSel('.landing-card')`);
  check(await cdp.evaluate(`!!window.__t.q('.landing-card')`), '渲染出首屏引导卡片');
  check(
    await cdp.evaluate(`document.body.innerText.includes('论文解析与提问')`),
    '页面标题渲染',
  );
  await cdp.shot('ui-01-landing.png');

  console.log('\n[2] 打开上传弹窗并粘贴文本');
  await cdp.evaluate(`window.__t.click('button', '上传文件 / 粘贴文本')`);
  await cdp.evaluate(`window.__t.waitSel('.modal')`);
  await cdp.evaluate(`window.__t.click('.tab', '粘贴文本')`);
  await cdp.evaluate(`window.__t.setSel('.paste-area', ${JSON.stringify(PASTE_TEXT)})`);
  await cdp.evaluate(`window.__t.setSel('.modal .field input', '深度学习文档理解综述')`);
  await cdp.shot('ui-02-upload.png');
  check(
    await cdp.evaluate(`window.__t.q('.paste-area').value.length > 100`),
    '粘贴框写入成功',
  );

  console.log('\n[3] 提交解析');
  await cdp.evaluate(`window.__t.click('.modal-foot button', '开始解析')`);
  await cdp.evaluate(`window.__t.waitSel('.panes', 30000)`);
  await sleep(2000);
  await cdp.evaluate(HELPERS, { awaitPromise: false });
  const paraCount = await cdp.evaluate(`window.__t.qa('.pane.left .row').length`);
  const qaCount = await cdp.evaluate(`window.__t.qa('.pane.right .qa-card').length`);
  check(paraCount >= 6, `左侧渲染 ${paraCount} 个段落`);
  check(paraCount === qaCount, `右侧问答卡片一一对应（${qaCount} 个）`);

  // 正文里的行内公式必须被渲染，不能显示 $...$ 原文
  const pastedMath = await cdp.evaluate(`(() => {
    const left = document.querySelector('.pane.left');
    const txt = left.innerText;
    return {
      katex: left.querySelectorAll('.katex').length,
      rawDollar: /\\$[^$\\n]{2,}\\$/.test(txt),
      richBlocks: left.querySelectorAll('.block-rich').length,
      sample: (left.querySelector('.block-rich')?.innerText || '').slice(0, 60),
    };
  })()`);
  check(pastedMath.katex >= 2, `粘贴文本中的公式已渲染为 KaTeX（${pastedMath.katex} 个）`);
  check(!pastedMath.rawDollar, '正文中不再出现未渲染的 $...$ 原文', pastedMath.sample);

  const aligned = await cdp.evaluate(`(() => {
    const l = window.__t.qa('.pane.left .row');
    const r = window.__t.qa('.pane.right .qa-card');
    const lScroll = window.__t.q('.pane.left .pane-scroll');
    const rScroll = window.__t.q('.pane.right .pane-scroll');
    const n = Math.min(l.length, r.length);
    const diag = {
      leftHead: window.__t.q('.pane.left .pane-head').getBoundingClientRect().height,
      rightHead: window.__t.q('.pane.right .pane-head').getBoundingClientRect().height,
      leftScrollTop: lScroll.scrollTop,
      rightScrollTop: rScroll.scrollTop,
      leftInnerTop: window.__t.q('.pane.left .pane-inner').getBoundingClientRect().top,
      rightInnerTop: window.__t.q('.pane.right .pane-inner').getBoundingClientRect().top,
      leftRowPad: getComputedStyle(l[0]).paddingTop,
      rightRowPad: getComputedStyle(r[0]).paddingTop,
      leftRowMargin: getComputedStyle(l[0]).marginTop,
      rightRowMargin: getComputedStyle(r[0]).marginTop,
      leftBorder: getComputedStyle(l[0]).borderTopWidth,
      rightBorder: getComputedStyle(r[0]).borderTopWidth,
      leftScrollBorder: getComputedStyle(lScroll).borderTopWidth,
      rightScrollBorder: getComputedStyle(rScroll).borderTopWidth,
      leftH: l[0].getBoundingClientRect().height,
      rightH: r[0].getBoundingClientRect().height,
      leftMinH: getComputedStyle(l[0]).minHeight,
      rightMinH: getComputedStyle(r[0]).minHeight,
      leftContentH: window.__t.qa('.pane.left .row-content').map((e) => e.offsetHeight),
      rightContentH: window.__t.qa('.pane.right .row-content').map((e) => e.offsetHeight),
      leftRowH: l.map((e) => Math.round(e.getBoundingClientRect().height)),
      rightRowH: r.map((e) => Math.round(e.getBoundingClientRect().height)),
    };
    for (let i = 0; i < n; i++) {
      const a = l[i].getBoundingClientRect().top + lScroll.scrollTop;
      const b = r[i].getBoundingClientRect().top + rScroll.scrollTop;
      if (Math.abs(a - b) > 2) return { ok: false, i, a, b, diag };
    }
    return { ok: true, n, diag };
  })()`);
  check(aligned.ok, '左右行严格对齐（像素级）', aligned.ok ? `${aligned.n} 行` : `第 ${aligned.i} 行差 ${(aligned.a - aligned.b).toFixed(1)}px`);
  if (!aligned.ok) console.log('    诊断：', JSON.stringify(aligned.diag, null, 2).replace(/\n/g, '\n    '));
  await cdp.shot('ui-03-parsed.png');

  console.log('\n[4] 段落级提问（流式回答）');
  const askIdx = 3;
  await cdp.evaluate(`(() => {
    const el = window.__t.qa('.qa-card textarea')[${askIdx}];
    el.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(300);
  await cdp.evaluate(`window.__t.setSel('.qa-card textarea', '这一段的论证结构是怎样的？', ${askIdx})`);
  await cdp.evaluate(`(() => {
    const card = window.__t.qa('.qa-card')[${askIdx}];
    [...card.querySelectorAll('button')].find(b => b.textContent.includes('发送')).click();
    return true;
  })()`);
  await cdp.evaluate(`window.__t.wait(() => !!document.querySelector('.bubble.streaming'))`, 15000, '进入流式状态');
  await sleep(400);
  await cdp.shot('ui-04-streaming.png');
  await cdp.evaluate(
    `window.__t.wait(() => !document.querySelector('.bubble.streaming') && window.__t.qa('.bubble.assistant').length > 0)`,
    40000,
    '流式结束',
  );
  await sleep(500);
  await cdp.evaluate(HELPERS, { awaitPromise: false });
  const ansText = await cdp.evaluate(
    `window.__t.qa('.qa-card')[${askIdx}].querySelector('.bubble.assistant .markdown')?.innerText.slice(0,60) || ''`,
  );
  check(ansText.length > 10, '收到 AI 回答', ansText.replace(/\n/g, ' '));
  const hasTable = await cdp.evaluate(
    `!!window.__t.qa('.qa-card')[${askIdx}].querySelector('.md-table')`,
  );
  check(hasTable, 'Markdown 表格渲染成功');
  const hasCode = await cdp.evaluate(
    `!!window.__t.qa('.qa-card')[${askIdx}].querySelector('.md-code')`,
  );
  check(hasCode, 'Markdown 代码块渲染成功');

  const mathInfo = await cdp.evaluate(`(() => {
    const card = window.__t.qa('.qa-card')[${askIdx}];
    const ans = card.querySelector('.bubble.assistant .markdown');
    return {
      katex: ans.querySelectorAll('.katex').length,
      display: ans.querySelectorAll('.katex-display').length,
      hasRawDollar: /\\$\\$/.test(ans.innerText),
      hasRawFrac: /\\\\frac/.test(ans.innerText),
    };
  })()`);
  check(mathInfo.display >= 2, `块级公式渲染为 KaTeX（${mathInfo.display} 个）`);
  check(mathInfo.katex >= 4, `公式节点总数 ${mathInfo.katex} 个（含行内 $x_{ri}$）`);
  check(!mathInfo.hasRawDollar, '页面中不再出现未渲染的 $$ 定界符');
  check(!mathInfo.hasRawFrac, '页面中不再出现裸 \\frac 源码');

  const foldInfo = await cdp.evaluate(`(async () => {
    const card = window.__t.qa('.qa-card')[${askIdx}];
    const bubble = card.querySelector('.bubble.assistant');
    const before = bubble.getBoundingClientRect().height;
    const btn = bubble.querySelector('.fold-toggle');
    if (!btn) return { ok: false, why: '找不到折叠按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 350));
    const folded = bubble.getBoundingClientRect().height;
    const hasFade = !!bubble.querySelector('.answer.folded .answer-body');
    const expandBtn = bubble.querySelector('.fold-btn');
    if (expandBtn) expandBtn.click();
    await new Promise(r => setTimeout(r, 350));
    return { ok: true, before, folded, hasFade, after: bubble.getBoundingClientRect().height, expandLabel: expandBtn ? expandBtn.textContent : '' };
  })()`);
  check(foldInfo.ok, 'AI 回答存在折叠按钮');
  check(foldInfo.ok && foldInfo.folded < foldInfo.before - 40, '折叠后高度明显变小', foldInfo.ok ? `${Math.round(foldInfo.before)}px → ${Math.round(foldInfo.folded)}px` : '');
  check(foldInfo.ok && foldInfo.hasFade, '折叠时显示渐变遮罩');
  check(foldInfo.ok && foldInfo.after > foldInfo.folded + 40, '可再次展开', foldInfo.ok ? `展开后 ${Math.round(foldInfo.after)}px` : '');

  console.log('\n[5] 同一段落多轮追问');
  await cdp.evaluate(`window.__t.setSel('.qa-card textarea', '能再举一个反例吗？', ${askIdx})`);
  await cdp.evaluate(`(() => {
    const card = window.__t.qa('.qa-card')[${askIdx}];
    [...card.querySelectorAll('button')].find(b => b.textContent.includes('发送')).click();
    return true;
  })()`);
  await cdp.evaluate(
    `window.__t.wait(() => window.__t.qa('.qa-card')[${askIdx}].querySelectorAll('.bubble.user').length >= 2 && !document.querySelector('.bubble.streaming'))`,
    40000,
    '第二轮完成',
  );
  await sleep(400);
  await cdp.evaluate(HELPERS, { awaitPromise: false });
  const rounds = await cdp.evaluate(
    `window.__t.qa('.qa-card')[${askIdx}].querySelectorAll('.bubble.user').length`,
  );
  check(rounds >= 2, `同一段落多轮对话（${rounds} 轮）`);
  await cdp.shot('ui-05-multiround.png');

  const foldAll = await cdp.evaluate(`(async () => {
    const btn = [...document.querySelectorAll('.pane.right .pane-head button')].find(b => b.textContent.includes('折叠全部回答'));
    if (!btn) return { ok: false, why: '找不到「折叠全部回答」按钮' };
    const before = [...document.querySelectorAll('.pane.right .bubble.assistant')].map(b => b.getBoundingClientRect().height);
    btn.click();
    await new Promise(r => setTimeout(r, 400));
    const folded = [...document.querySelectorAll('.pane.right .bubble.assistant')].map(b => b.getBoundingClientRect().height);
    const expandedCount = document.querySelectorAll('.pane.right .answer:not(.folded)').length;
    const label = btn.textContent;
    btn.click();
    await new Promise(r => setTimeout(r, 400));
    return { ok: true, before, folded, expandedCount, label, after: [...document.querySelectorAll('.pane.right .bubble.assistant')].map(b => b.getBoundingClientRect().height) };
  })()`);
  check(foldAll.ok, '右侧栏存在「折叠全部回答」按钮');
  check(
    foldAll.ok && foldAll.folded.every((h, i) => h < foldAll.before[i] - 30),
    '一键折叠全部回答生效',
    foldAll.ok ? `${foldAll.before.map(Math.round).join('/')} → ${foldAll.folded.map(Math.round).join('/')}` : '',
  );
  check(foldAll.ok && /展开全部回答/.test(foldAll.label), '按钮切换为「展开全部回答」', foldAll.ok ? foldAll.label : '');
  check(
    foldAll.ok && foldAll.after.every((h, i) => h > foldAll.folded[i] + 30),
    '一键展开全部回答生效',
    foldAll.ok ? `→ ${foldAll.after.map(Math.round).join('/')}` : '',
  );

  // 留一张「全部折叠」状态的效果图
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.pane.right .pane-head button')].find(b => b.textContent.includes('折叠全部回答'));
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(500);
  await cdp.shot('ui-05b-folded.png');
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.pane.right .pane-head button')].find(b => b.textContent.includes('展开全部回答'));
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(400);

  console.log('\n[6] 段落高亮 + 滚动联动');
  await cdp.evaluate(`(() => {
    window.__t.qa('.pane.left .row')[8].click();
    return true;
  })()`);
  await sleep(400);
  const activeSync = await cdp.evaluate(`(() => {
    const active = window.__t.q('.pane.left .row.active');
    if (!active) return { ok: false, why: '无高亮' };
    const idx = window.__t.qa('.pane.left .row').indexOf(active);
    const right = window.__t.qa('.pane.right .qa-card')[idx];
    const lTop = active.getBoundingClientRect().top;
    const rTop = right.getBoundingClientRect().top;
    return { ok: active.className.includes('active') && Math.abs(lTop - rTop) < 3, idx, lTop, rTop };
  })()`);
  check(activeSync.ok, '点击段落高亮且左右同步', `第 ${activeSync.idx + 1} 段`);

  const syncCheck = await cdp.evaluate(`(async () => {
    const l = window.__t.q('.pane.left .pane-scroll');
    const r = window.__t.q('.pane.right .pane-scroll');
    l.scrollTop = 0; await new Promise(x => setTimeout(x, 150));
    l.scrollTop = 600; await new Promise(x => setTimeout(x, 300));
    return { left: l.scrollTop, right: r.scrollTop };
  })()`);
  check(Math.abs(syncCheck.left - syncCheck.right) < 12, '滚动联动生效', `左 ${Math.round(syncCheck.left)} / 右 ${Math.round(syncCheck.right)}`);

  const jump = await cdp.evaluate(`(async () => {
    window.__t.setSel('.jump input', '2');
    [...document.querySelectorAll('.jump button')][0].click();
    await new Promise(x => setTimeout(x, 700));
    const l = window.__t.q('.pane.left .pane-scroll');
    const r = window.__t.q('.pane.right .pane-scroll');
    return { left: Math.round(l.scrollTop), right: Math.round(r.scrollTop) };
  })()`);
  check(jump.left > 0 || jump.right > 0, '「定位到段落」可用', `左 ${jump.left} / 右 ${jump.right}`);
  await cdp.shot('ui-06-highlight-jump.png');

  console.log('\n[7] 跨段落关联提问');
  await cdp.evaluate(`window.__t.click('.toolbar-actions button', '跨段落提问')`);
  await cdp.evaluate(`window.__t.waitSel('.cross-modal')`);
  await cdp.evaluate(`(() => {
    const items = window.__t.qa('.cross-item');
    [0, 2, 4].forEach(i => items[i]?.querySelector('input').click());
    return true;
  })()`);
  await sleep(200);
  await cdp.evaluate(`window.__t.setSel('.cross-ask textarea', '第 1、3、5 段之间的逻辑关系是什么？')`);
  await cdp.shot('ui-07-cross-select.png');
  await cdp.evaluate(`window.__t.click('.cross-ask button', '发送')`);
  await cdp.evaluate(`window.__t.waitSel('.cross-thread .bubble', 20000)`);
  await cdp.evaluate(
    `window.__t.wait(() => !document.querySelector('.cross-thread .bubble.streaming'))`,
    40000,
    '跨段落回答完成',
  );
  await sleep(400);
  const cited = await cdp.evaluate(`window.__t.txt('.cross-thread .bubble.assistant .cite')`);
  check(/第 \d+ 段/.test(cited), '跨段落回答标注了引用段落', cited);
  await cdp.shot('ui-08-cross-answer.png');
  await cdp.evaluate(`window.__t.click('.modal-head button')`);
  await sleep(300);

  console.log('\n[8] 设置 / 历史 / 导出菜单');
  await cdp.evaluate(`window.__t.click('.toolbar-actions button[title="设置"]')`);
  await cdp.evaluate(`window.__t.waitSel('.settings-section')`);
  await sleep(300);
  await cdp.shot('ui-09-settings.png');
  const modelVal = await cdp.evaluate(`window.__t.q('.settings-section input[type=text]').value`);
  check(modelVal.includes('127.0.0.1'), '设置页回填了 API 地址', modelVal);
  await cdp.evaluate(`window.__t.click('.modal-head button')`);
  await sleep(250);

  await cdp.evaluate(`window.__t.click('.toolbar-actions button', '导出')`);
  await sleep(350);
  await cdp.shot('ui-10-export-menu.png');
  const exportItems = await cdp.evaluate(`window.__t.qa('.dropdown-item').map(e => e.querySelector('strong').textContent)`);
  check(exportItems.length >= 5, `导出菜单包含 ${exportItems.length} 个选项`, exportItems.join(' / '));
  await cdp.evaluate(`document.body.click()`);
  await sleep(200);

  await cdp.evaluate(`window.__t.click('.toolbar-actions button[title="历史记录"]')`);
  await cdp.evaluate(`window.__t.waitSel('.drawer')`);
  await sleep(350);
  await cdp.shot('ui-11-history.png');
  const histCount = await cdp.evaluate(`window.__t.qa('.history-item').length`);
  check(histCount >= 1, `历史记录已保存 ${histCount} 份文档`);
  await cdp.evaluate(`window.__t.click('.drawer-head button')`);
  await sleep(250);

  console.log('\n[9] 导出接口（真实下载 Word / Markdown / JSON）');
  const docId = await cdp.evaluate(`localStorage.getItem('paperinsight.currentDocId')`);
  check(Boolean(docId), `当前文档 id = ${docId}`);
  await cdp.send('Page.navigate', {
    url: `${APP}/print.html?doc=${docId}&auto=0`,
  });
  await sleep(2000);
  await cdp.evaluate(HELPERS, { awaitPromise: false });
  const printOk = await cdp.evaluate(`window.__t.txt('.page h1')`);
  check(Boolean(printOk), `打印/PDF 页面渲染成功：${printOk}`);
  const printMath = await cdp.evaluate(`(() => {
    const root = document.querySelector('.page');
    return { katex: root.querySelectorAll('.katex').length, raw: /\\$\\$/.test(root.innerText) };
  })()`);
  check(printMath.katex >= 4, `打印页公式渲染为 KaTeX（${printMath.katex} 个）`);
  check(!printMath.raw, '打印页无未渲染的 $$ 定界符');
  await cdp.shot('ui-12-print-pdf.png');

  console.log('\n[10] 暗色主题');
  await cdp.send('Page.navigate', { url: APP });
  await sleep(1800);
  await cdp.evaluate(HELPERS, { awaitPromise: false });
  await cdp.evaluate(`window.__t.waitSel('.panes', 20000)`);
  await cdp.evaluate(`window.__t.click('.toolbar-actions button[title="切换主题"]')`);
  await sleep(500);
  await cdp.shot('ui-13-dark.png');
  const dark = await cdp.evaluate(`document.documentElement.dataset.theme`);
  check(dark === 'dark', '暗色主题切换成功');

  console.log('\n[11] 刷新后问答记录持久化');
  await cdp.send('Page.reload');
  await sleep(2500);
  await cdp.evaluate(HELPERS, { awaitPromise: false });
  await cdp.evaluate(`window.__t.waitSel('.panes', 25000)`);
  await sleep(600);
  const persisted = await cdp.evaluate(`window.__t.qa('.pane.right .bubble.user').length`);
  check(persisted >= 2, `刷新后仍保留 ${persisted} 条段落提问记录`);
  const persistedCross = await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.toolbar-actions button')].find(b => b.textContent.includes('跨段落提问'));
    return btn ? btn.textContent : '';
  })()`);
  check(/[1-9]/.test(persistedCross), '刷新后跨段落提问计数保留', persistedCross);

  console.log('\n[12] 通过界面真实上传 PDF / DOCX 文件');
  for (const [label, sample] of [
    ['PDF', 'sample.pdf'],
    ['DOCX', 'sample.docx'],
  ]) {
    const filePath = path.join(root, 'data', 'samples', sample);
    if (!fs.existsSync(filePath)) {
      console.log(`  - 跳过 ${label}（缺少 ${filePath}）`);
      continue;
    }
    await cdp.send('Page.navigate', { url: APP });
    await sleep(1800);
    await cdp.evaluate(HELPERS, { awaitPromise: false });
    await cdp.evaluate(`window.__t.wait(() => !!document.querySelector('.toolbar-actions'), 25000, 'toolbar')`);
    await cdp.evaluate(`window.__t.click('.toolbar-actions button', '上传 / 粘贴')`);
    await cdp.evaluate(`window.__t.waitSel('.dropzone')`);
    const doc0 = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: doc0.root.nodeId,
      selector: '.dropzone input[type=file]',
    });
    await cdp.send('DOM.setFileInputFiles', { files: [filePath], nodeId });
    await sleep(400);
    const chosen = await cdp.evaluate(`window.__t.txt('.dropzone strong')`);
    check(chosen.includes(sample) || chosen.length > 3, `${label} 文件已选中`, chosen);
    await cdp.evaluate(`window.__t.click('.modal-foot button', '开始解析')`);
    await cdp.evaluate(`window.__t.waitSel('.panes', 40000)`);
    await sleep(2000);
    await cdp.evaluate(HELPERS, { awaitPromise: false });
    const n = await cdp.evaluate(`window.__t.qa('.pane.left .row').length`);
    const txt = await cdp.evaluate(`window.__t.qa('.pane.left .ptext, .pane.left .block-rich').map(e => e.textContent).join('')`);
    check(n >= 8, `${label} 解析出 ${n} 个块`);
    check(txt.includes('深度学习') && txt.length > 200, `${label} 正文提取正常（${txt.length} 字）`);

    const rich = await cdp.evaluate(`(async () => {
      const left = document.querySelector('.pane.left');
      // 图片是懒加载的，先滚动到可见区域
      const first = left.querySelector('.block-image img');
      if (first) {
        first.scrollIntoView({ block: 'center' });
        await new Promise(r => setTimeout(r, 200));
        for (let i = 0; i < 60 && !(first.complete && first.naturalWidth > 0); i++) {
          await new Promise(r => setTimeout(r, 150));
        }
      }
      const imgs = [...left.querySelectorAll('.block-image img')];
      return {
        tables: left.querySelectorAll('.block-table table').length,
        tableRows: left.querySelectorAll('.block-table tbody tr').length,
        tableCols: left.querySelectorAll('.block-table thead th').length,
        tableText: (left.querySelector('.block-table')?.innerText || '').slice(0, 60),
        images: imgs.length,
        imagesLoaded: imgs.filter(i => i.naturalWidth > 0).length,
        imageSizes: imgs.map(i => i.naturalWidth + 'x' + i.naturalHeight),
        formulas: left.querySelectorAll('.block-formula .katex-display').length,
        inlineMath: left.querySelectorAll('.block-rich .katex').length,
        badges: [...left.querySelectorAll('.block-badge')].map(e => e.textContent),
        rawTex: /\\\\frac|\\$\\$/.test(left.innerText),
      };
    })()`);
    console.log(`     富内容：表格 ${rich.tables} / 图片 ${rich.images} / 公式 ${rich.formulas} / 行内公式 ${rich.inlineMath}`);

    if (label === 'DOCX') {
      check(rich.tables >= 1 && rich.tableRows >= 4 && rich.tableCols >= 3, `表格渲染为真表格（${rich.tableRows} 行 × ${rich.tableCols} 列）`);
      check(rich.tableText.includes('LayoutLM'), '表格内容正确', rich.tableText.replace(/\n/g, ' ').slice(0, 40));
      check(rich.images >= 1 && rich.imagesLoaded >= 1, `图片渲染并加载成功（${rich.imageSizes.join(',')}）`);
      check(rich.formulas >= 1, `块级公式渲染为 KaTeX（${rich.formulas} 个）`);
      check(rich.inlineMath >= 1, `行内公式渲染为 KaTeX（${rich.inlineMath} 个）`);
      check(!rich.rawTex, '页面不残留裸 LaTeX 源码');
      check(rich.badges.join('') .includes('表') && rich.badges.join('').includes('图') && rich.badges.join('').includes('式'), `块类型标记齐全：${rich.badges.join(' ')}`);

      // 图片灯箱
      await cdp.evaluate(`document.querySelector('.pane.left .block-image .figure').click()`);
      await cdp.evaluate(`window.__t.waitSel('.lightbox', 8000)`);
      await sleep(400);
      const lb = await cdp.evaluate(`(() => {
        const img = document.querySelector('.lightbox-body img');
        return { ok: !!img, loaded: img ? img.naturalWidth > 0 : false, zoom: !!document.querySelector('.lightbox-zoom') };
      })()`);
      check(lb.ok && lb.loaded, '点击图片打开放大灯箱');
      check(lb.zoom, '灯箱提供缩放控件');
      await cdp.shot('ui-15-image-lightbox.png');
      await cdp.evaluate(`window.__t.click('.lightbox-bar button[title^="关闭"]')`);
      await sleep(300);
      check(!(await cdp.evaluate(`!!document.querySelector('.lightbox')`)), '灯箱可关闭');

      const headings = await cdp.evaluate(
        `window.__t.qa('.pane.left .ptext.type-heading, .pane.left .block-rich.type-heading').map(e => e.textContent).slice(0, 8)`,
      );
      check(headings.length >= 3, `标题层级识别 ${headings.length} 个`, headings.join(' / '));

      // 滚动到公式块截图
      await cdp.evaluate(`(() => {
        const f = document.querySelector('.pane.left .block-formula');
        if (f) f.scrollIntoView({ block: 'center' });
        return true;
      })()`);
      await sleep(500);
      await cdp.shot('ui-18-docx-formula.png');

      // 对表格块提问，验证富内容也能作为上下文
      const tableIdx = await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.pane.left .row')];
        const i = rows.findIndex(r => r.querySelector('.block-table'));
        if (i >= 0) rows[i].scrollIntoView({ block: 'center' });
        return i;
      })()`);
      check(tableIdx >= 0, `定位到表格块（第 ${tableIdx + 1} 块）`);
      await sleep(300);
      await cdp.evaluate(`window.__t.setSel('.qa-card textarea', '这张表里哪个方法效果最好？', ${tableIdx})`);
      await cdp.evaluate(`(() => {
        const card = window.__t.qa('.qa-card')[${tableIdx}];
        [...card.querySelectorAll('button')].find(b => b.textContent.includes('发送')).click();
        return true;
      })()`);
      await cdp.evaluate(
        `window.__t.wait(() => window.__t.qa('.qa-card')[${tableIdx}].querySelector('.bubble.assistant .markdown') && !document.querySelector('.bubble.streaming'), 40000, '表格提问完成')`,
      );
      await sleep(400);
      check(
        await cdp.evaluate(`window.__t.qa('.qa-card')[${tableIdx}].querySelectorAll('.bubble.assistant').length >= 1`),
        '可针对表格块提问',
      );
      await cdp.shot('ui-19-docx-table-qa.png');

      // ---------- 段落修正（公式/表格解析不准时的兜底） ----------
      const formulaIdx = await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.pane.left .row')];
        const i = rows.findIndex(r => r.querySelector('.block-formula'));
        if (i >= 0) rows[i].scrollIntoView({ block: 'center' });
        return i;
      })()`);
      check(formulaIdx >= 0, `定位到公式块（第 ${formulaIdx + 1} 块）`);
      await cdp.evaluate(`(() => {
        const btn = window.__t.qa('.pane.left .row')[${formulaIdx}].querySelector('.edit-btn');
        if (btn) btn.click();
        return true;
      })()`);
      await cdp.evaluate(`window.__t.waitSel('.block-editor', 8000)`);
      await sleep(300);
      check(await cdp.evaluate(`!!document.querySelector('.block-editor .editor-preview .katex')`), '编辑器带公式实时预览');
      await cdp.evaluate(
        `window.__t.setSel('.block-editor textarea', 'p_{ri}=\\\\frac{x_{ri}}{\\\\sum_{j=1}^{17} x_{rj}}')`,
      );
      await sleep(300);
      await cdp.shot('ui-20-block-editor.png');
      await cdp.evaluate(`window.__t.click('.editor-actions button', '保存')`);
      await cdp.evaluate(`window.__t.wait(() => !document.querySelector('.block-editor'), 15000, '保存完成')`);
      await sleep(600);
      const edited = await cdp.evaluate(`(() => {
        const row = window.__t.qa('.pane.left .row')[${formulaIdx}];
        return {
          tex: row.querySelector('.block-formula')?.innerText || '',
          katex: row.querySelectorAll('.block-formula .katex').length,
          tag: row.querySelector('.edited-tag')?.textContent || '',
        };
      })()`);
      check(edited.katex > 0, '修正后公式仍正常渲染');
      check(edited.tag.includes('已修正'), '块上显示「已修正」标记', edited.tag);
      const persisted = await cdp.evaluate(`(async () => {
        const id = localStorage.getItem('paperinsight.currentDocId');
        const r = await fetch('/api/documents/' + id);
        const j = await r.json();
        const b = j.document.paragraphs.find(p => p.type === 'formula');
        return { edited: !!b.edited, tex: b.tex, hasFrac: String(b.tex).includes('\\\\frac') };
      })()`);
      check(
        persisted.edited && persisted.hasFrac,
        '修正已落库（服务端持久化）',
        `edited=${persisted.edited} tex=${String(persisted.tex).slice(0, 50)}`,
      );
    }

    if (label === 'PDF') {
      check(rich.images >= 1 && rich.imagesLoaded >= 1, `PDF 内嵌图片渲染成功（${rich.imageSizes.join(',')}）`);
      const pageBtn = await cdp.evaluate(`(() => {
        const b = document.querySelector('.pane.left .ppage-btn');
        if (!b) return { ok: false };
        b.click();
        return { ok: true, label: b.textContent };
      })()`);
      check(pageBtn.ok, `PDF 段落带「原页」入口（${pageBtn.label}）`);
      await cdp.evaluate(`window.__t.waitSel('.page-viewer', 8000)`);
      await sleep(500);
      const pv = await cdp.evaluate(`(() => {
        const f = document.querySelector('.page-viewer iframe');
        return { ok: !!f, src: f ? f.getAttribute('src') : '', hasInline: f ? f.getAttribute('src').includes('inline=1') : false };
      })()`);
      check(pv.ok && pv.hasInline, '原页查看器加载内联 PDF', pv.src);
      await cdp.shot('ui-16-page-viewer.png');
      await cdp.evaluate(`window.__t.click('.page-viewer .icon-btn[title^="关闭"]')`);
      await sleep(300);
    }

    await cdp.shot(`ui-14-upload-${label.toLowerCase()}.png`);
  }

  console.log('\n[13] AI 精修解析（上传时勾选 → 进度 → 落库保存）');
  {
    const pdfPath = path.join(root, 'data', 'samples', 'sample.pdf');
    await cdp.send('Page.navigate', { url: APP });
    await sleep(1800);
    await cdp.evaluate(HELPERS, { awaitPromise: false });
    await cdp.evaluate(`window.__t.wait(() => !!document.querySelector('.toolbar-actions'), 25000, 'toolbar')`);
    await cdp.evaluate(`window.__t.click('.toolbar-actions button', '上传 / 粘贴')`);
    await cdp.evaluate(`window.__t.waitSel('.dropzone')`);
    const d0 = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId: fileNode } = await cdp.send('DOM.querySelector', {
      nodeId: d0.root.nodeId,
      selector: '.dropzone input[type=file]',
    });
    await cdp.send('DOM.setFileInputFiles', { files: [pdfPath], nodeId: fileNode });
    await sleep(400);

    const opt = await cdp.evaluate(`(() => {
      const cb = document.querySelector('.ai-option input[type=checkbox]');
      if (!cb) return { ok: false };
      cb.click();
      return { ok: true, checked: cb.checked, label: document.querySelector('.ai-option strong').textContent };
    })()`);
    check(opt.ok && opt.checked, `上传弹窗有「AI 精修」选项：${opt.label}`);
    await cdp.shot('ui-21-ai-option.png');

    await cdp.evaluate(`window.__t.click('.modal-foot button', '解析并 AI 精修')`);
    // mock 很快，进度条可能一闪而过，因此三者任一出现即算进入流程
    await cdp.evaluate(`window.__t.wait(() => !!document.querySelector('.ai-progress, .ai-confirm, .ai-done'), 40000, 'AI 精修面板')`);
    const sawProgress = await cdp.evaluate(`(() => {
      const bar = document.querySelector('.ai-bar-fill');
      return { hasBar: !!bar, text: document.querySelector('.ai-progress-text')?.textContent || '' };
    })()`);
    if (sawProgress.hasBar) {
      await cdp.shot('ui-22-ai-progress.png');
    } else {
      // 已经跑完，补一张确认面板的说明截图（用「AI 精修」按钮重新打开确认框）
      console.log('  （mock 过快，进度条一闪而过，跳过进度截图）');
    }

    await cdp.evaluate(`window.__t.wait(() => !!document.querySelector('.ai-done'), 60000, '精修完成')`);
    await sleep(600);
    const doneInfo = await cdp.evaluate(`(() => {
      const stats = [...document.querySelectorAll('.ai-stat')].map(s => s.innerText.replace(/\\n/g, ': '));
      return { stats, chip: document.querySelector('.ai-chip')?.textContent || '' };
    })()`);
    check(doneInfo.stats.length >= 4, '完成后展示消耗统计', doneInfo.stats.join(' | ').slice(0, 120));
    await cdp.shot('ui-23-ai-done.png');
    await cdp.evaluate(`window.__t.click('.modal-foot button', '知道了')`);
    await sleep(600);

    const persisted = await cdp.evaluate(`(async () => {
      const id = localStorage.getItem('paperinsight.currentDocId');
      const j = await (await fetch('/api/documents/' + id)).json();
      const d = j.document;
      return {
        chip: document.querySelector('.ai-chip')?.textContent || '',
        enabled: !!d.aiParse?.enabled,
        tokens: d.aiParse?.usage?.totalTokens || 0,
        refined: d.paragraphs.filter(p => p.aiRefined).length,
        hasBackup: d.hasLocalBackup,
        headings: d.paragraphs.filter(p => p.type === 'heading').length,
      };
    })()`);
    check(persisted.enabled, 'AI 精修结果已随文档落库');
    check(persisted.tokens > 0, `记录了 token 消耗：${persisted.tokens}`);
    check(persisted.refined > 0, `标记了 ${persisted.refined} 个已精修块`);
    check(persisted.hasBackup, '保留了本地解析备份（可还原）');
    check(/AI 精修/.test(persisted.chip), `标题栏显示精修标记：${persisted.chip}`);
    check(doneInfo.chip === persisted.chip, '完成提示与标题栏标记一致');

    // 重新打开文档：不应再消耗 token（直接复用已保存结果）
    await cdp.send('Page.navigate', { url: APP });
    await sleep(2200);
    await cdp.evaluate(HELPERS, { awaitPromise: false });
    await cdp.evaluate(`window.__t.waitSel('.panes', 25000)`);
    await sleep(900);
    const reopened = await cdp.evaluate(`(async () => {
      const id = localStorage.getItem('paperinsight.currentDocId');
      const j = await (await fetch('/api/documents/' + id)).json();
      return { tokens: j.document.aiParse?.usage?.totalTokens || 0, chip: document.querySelector('.ai-chip')?.textContent || '' };
    })()`);
    check(reopened.tokens === persisted.tokens, '重新打开复用已保存结果，未重复消耗', `${reopened.tokens} tokens`);

    // 还原（window.confirm 已由 CDP 自动接受）
    await cdp.evaluate(`window.__t.click('.ai-chip')`);
    await sleep(1500);
    const reverted = await cdp.evaluate(`(async () => {
      const id = localStorage.getItem('paperinsight.currentDocId');
      const j = await (await fetch('/api/documents/' + id)).json();
      return { enabled: !!j.document.aiParse?.enabled, refined: j.document.paragraphs.filter(p=>p.aiRefined).length };
    })()`);
    check(!reverted.enabled && reverted.refined === 0, '可还原为本地解析结果');
  }

  console.log('\n[14] 返回首页');  {
    await cdp.evaluate(`window.__t.click('.home-btn')`);
    await sleep(800);
    const atHome = await cdp.evaluate(`(() => ({
      landing: !!document.querySelector('.landing-card'),
      panes: !!document.querySelector('.panes'),
      ls: localStorage.getItem('paperinsight.currentDocId'),
    }))()`);
    check(atHome.landing && !atHome.panes, '点击「首页」回到首屏');
    check(!atHome.ls, '首页状态下不再记住当前文档');
    await cdp.shot('ui-17-home.png');

    await cdp.evaluate(`window.__t.click('.landing-actions button', '查看历史记录')`);
    await cdp.evaluate(`window.__t.waitSel('.drawer')`);
    await sleep(400);
    const hist = await cdp.evaluate(`window.__t.qa('.history-item').length`);
    check(hist >= 2, `历史记录中保留 ${hist} 份文档`);
    await cdp.evaluate(`window.__t.qa('.history-item .history-main')[0].click()`);
    await cdp.evaluate(`window.__t.waitSel('.panes', 25000)`);
    await sleep(1200);
    check(
      await cdp.evaluate(`!!document.querySelector('.pane.left .row')`),
      '可从历史记录重新打开文档',
    );
  }

  console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}`);
  console.log(`截图目录：${outDir}\n`);

  cdp.close();
  chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ 自测异常：', err.message);
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
