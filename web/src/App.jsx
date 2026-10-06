import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, askStream, aiParseStream } from './api.js';
import Markdown, { CitationContext } from './markdown.jsx';
import ReadingNav from './components/ReadingNav.jsx';
import Landing from './components/Landing.jsx';
import UploadDialog from './components/UploadDialog.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import HistoryDrawer from './components/HistoryDrawer.jsx';
import CrossDialog from './components/CrossDialog.jsx';
import FoldableAnswer from './components/FoldableAnswer.jsx';
import BlockView from './components/BlockView.jsx';
import AiParsePanel from './components/AiParsePanel.jsx';
import { ImageLightbox, PageViewer } from './components/Viewer.jsx';
import ExportMenu from './components/ExportMenu.jsx';
import {
  IconUpload,
  IconSettings,
  IconHistory,
  IconLink,
  IconSend,
  IconStop,
  IconTarget,
  IconTrash,
  IconSpark,
  IconSun,
  IconMoon,
  IconFile,
  IconPaste,
  IconChevron,
  IconFold,
  IconHome,
} from './components/Icons.jsx';

const LS_DOC = 'paperinsight.currentDocId';
const LS_THEME = 'paperinsight.theme';
const LS_SYNC = 'paperinsight.syncScroll';

const CROSS_KEY = '__cross__';

export default function App() {
  const [config, setConfig] = useState(null);
  const [doc, setDoc] = useState(null);
  const [threads, setThreads] = useState({});
  const [pending, setPending] = useState({});
  const [activeId, setActiveId] = useState(null);

  const [documents, setDocuments] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [showUpload, setShowUpload] = useState(false);
  const [uploadTab, setUploadTab] = useState('file');
  const [showNav, setShowNav] = useState(true);
  const [search, setSearch] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showCross, setShowCross] = useState(false);
  const [crossSelected, setCrossSelected] = useState([]);

  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [toast, setToast] = useState(null);
  const [foldedIds, setFoldedIds] = useState(() => new Set());
  const [lightbox, setLightbox] = useState(null);
  const [pageViewer, setPageViewer] = useState(null);
  const [budget, setBudget] = useState(null);
  const [aiPanel, setAiPanel] = useState(null); // null | 'confirm' | 'running' | 'done'
  const [aiProgress, setAiProgress] = useState(null);
  const [aiUsage, setAiUsage] = useState(null);
  const [aiErrors, setAiErrors] = useState([]);
  const aiAbort = useRef(null);

  const [syncScroll, setSyncScroll] = useState(() => localStorage.getItem(LS_SYNC) !== '0');
  const [theme, setTheme] = useState(() => localStorage.getItem(LS_THEME) || 'light');
  const [jumpValue, setJumpValue] = useState('');

  const leftScrollRef = useRef(null);
  const rightScrollRef = useRef(null);
  const leftInnerRef = useRef(null);
  const rowHRef = useRef([]);
  const naturalRef = useRef({ left: {}, right: {} });
  const observerRef = useRef(null);
  const [rowH, setRowH] = useState([]);
  const aborts = useRef({});
  const docRevision = useRef(0);
  const documentRequest = useRef(0);
  const syncing = useRef(false);
  const syncingTimer = useRef(0);

  const paragraphs = doc?.paragraphs || [];
  const paragraphCount = paragraphs.length;
  useEffect(() => { setTitleDraft(doc?.title || ''); }, [doc?.id, doc?.title]);
  useEffect(() => { setSearch(''); }, [doc?.id]);
  const stopAll = useCallback(() => {
    docRevision.current += 1;
    documentRequest.current += 1;
    Object.values(aborts.current).forEach((h) => h?.abort?.());
    aborts.current = {};
    aiAbort.current?.abort();
    aiAbort.current = null;
    setAiPanel(null);
    naturalRef.current = { left: {}, right: {} };
  }, []);
  const openUpload = (tab = 'file') => { setUploadTab(tab); setShowUpload(true); };
  const locateCitation = (n) => { if (paragraphs[n - 1]) focusParagraph(paragraphs[n - 1]); };
  const saveTitle = async () => {
    const title = titleDraft.trim();
    if (!doc || !title || title === doc.title) { setTitleDraft(doc?.title || ''); return; }
    try { const r = await api.renameDocument(doc.id, title); setDoc((d) => ({ ...d, title: r.document.title })); refreshDocuments(); notify('文档标题已保存'); }
    catch (err) { setTitleDraft(doc.title); notify(err.message, 'error'); }
  };

  /* ------------------------- 行高对齐 ------------------------- */
  /** 取左右两栏内容块自然高度的较大值，作为该行的统一高度，实现像素级对齐 */
  const applyHeights = useCallback(() => {
    const n = paragraphCount;
    if (!n) return;
    const next = new Array(n);
    let changed = false;
    for (let i = 0; i < n; i++) {
      const a = naturalRef.current.left[i] || 0;
      const b = naturalRef.current.right[i] || 0;
      const h = Math.max(a, b, 56);
      next[i] = h;
      if (Math.abs((rowHRef.current[i] ?? -1) - h) > 0.5) changed = true;
    }
    if (changed) {
      rowHRef.current = next;
      setRowH(next);
    }
  }, [paragraphCount]);

  // 观察每个 .row-content 的自然高度变化，实时重新对齐（不依赖测量时机）
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      let dirty = false;
      for (const entry of entries) {
        const el = entry.target.closest('.row-content');
        if (!el) continue;
        const idx = Number(el.dataset.ri);
        const side = el.dataset.side;
        if (!Number.isFinite(idx) || (side !== 'left' && side !== 'right')) continue;
        // 读取内部不受 min-height 约束的包裹层，保证内容变短时也能收缩；
        // 向上取整以避免亚像素误差在多行之间累积
        const inner = el.firstElementChild || el;
        const h = Math.ceil(inner.getBoundingClientRect().height);
        if (Math.abs((naturalRef.current[side][idx] || 0) - h) > 0.5) {
          naturalRef.current[side][idx] = h;
          dirty = true;
        }
      }
      if (dirty) applyHeights();
    });
    observerRef.current = ro;
    document.querySelectorAll('.row-content[data-side]').forEach((el) => ro.observe(el.firstElementChild || el));
    return () => {
      ro.disconnect();
      observerRef.current = null;
    };
  }, [doc?.id, paragraphCount, applyHeights]);

  useLayoutEffect(() => {
    applyHeights();
  });

  useEffect(() => {
    const onResize = () => applyHeights();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [applyHeights]);

  // 字体加载 / 首屏布局稳定后各补测一次，避免个别环境下初始高度偏差
  useEffect(() => {
    const t1 = setTimeout(applyHeights, 120);
    const t2 = setTimeout(applyHeights, 600);
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => applyHeights()).catch(() => {});
    }
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [doc?.id, paragraphCount, applyHeights]);

  /* ---------------------------- 主题 ---------------------------- */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(LS_THEME, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(LS_SYNC, syncScroll ? '1' : '0');
  }, [syncScroll]);

  const notify = useCallback((message, type = 'info') => {
    setToast({ message, type, id: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.type === 'error' ? 5200 : 2600);
    return () => clearTimeout(t);
  }, [toast]);

  /* --------------------------- 初始化 --------------------------- */
  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => {});
  }, []);

  const refreshDocuments = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const r = await api.listDocuments();
      setDocuments(r.documents || []);
    } catch {
      /* ignore */
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadDocument = useCallback(
    async (id) => {
      const requestId = ++documentRequest.current;
      try {
        const r = await api.getDocument(id);
        if (requestId !== documentRequest.current) return false;
        stopAll();
        setDoc(r.document);
        setThreads(r.document.threads || {});
        setPending({});
        setRowH([]);
        rowHRef.current = [];
        setActiveId(null);
        localStorage.setItem(LS_DOC, id);
        requestAnimationFrame(() => {
          leftScrollRef.current?.scrollTo({ top: 0 });
          rightScrollRef.current?.scrollTo({ top: 0 });
        });
        return true;
      } catch (err) {
        notify(err.message, 'error');
        localStorage.removeItem(LS_DOC);
        setDoc(null);
        return false;
      }
    },
    [notify, stopAll],
  );

  useEffect(() => {
    refreshDocuments();
    const last = localStorage.getItem(LS_DOC);
    if (last) loadDocument(last);
  }, [refreshDocuments, loadDocument]);

  /* --------------------------- 滚动联动 --------------------------- */
  const handleScroll = (which) => () => {
    if (!syncScroll || syncing.current) return;
    const src = which === 'left' ? leftScrollRef.current : rightScrollRef.current;
    const dst = which === 'left' ? rightScrollRef.current : leftScrollRef.current;
    if (!src || !dst) return;
    syncing.current = true;
    dst.scrollTop = src.scrollTop;
    clearTimeout(syncingTimer.current);
    syncingTimer.current = setTimeout(() => {
      syncing.current = false;
    }, 90);
  };

  const scrollToParagraph = useCallback(
    (index) => {
      const el = leftInnerRef.current?.children?.[index];
      if (!el) return;
      syncing.current = true;
      const align = () => {
        if (!el.isConnected) return;
        const top = Math.max(0, el.offsetTop - 10);
        leftScrollRef.current?.scrollTo({ top, behavior: 'instant' });
        rightScrollRef.current?.scrollTo({ top, behavior: 'instant' });
      };
      align();
      // 焦点提示、公式截图或刚完成的回答会触发行高测量，待布局更新后再次定位。
      requestAnimationFrame(() => requestAnimationFrame(align));
      clearTimeout(syncingTimer.current);
      syncingTimer.current = setTimeout(() => {
        syncing.current = false;
      }, 420);
    },
    [],
  );

  const focusParagraph = useCallback(
    (p, { scroll = true } = {}) => {
      setActiveId(p.id);
      if (scroll) scrollToParagraph(p.index);
    },
    [scrollToParagraph],
  );

  /* --------------------------- 修正段落 --------------------------- */
  const saveParagraph = useCallback(
    async (block, patch) => {
      if (!doc) return;
      setBusy(true);
      try {
        const r = await api.updateParagraph(doc.id, block.id, patch);
        setDoc((d) => ({
          ...d,
          paragraphs: d.paragraphs.map((p) => (p.id === block.id ? { ...p, ...r.block } : p)),
        }));
        notify('已保存修正，之后提问都会使用新内容');
      } catch (err) {
        notify(err.message, 'error');
      } finally {
        setBusy(false);
      }
    },
    [doc, notify],
  );

  const resetParagraph = useCallback(
    async (block) => {
      if (!doc) return;
      setBusy(true);
      try {
        const r = await api.resetParagraph(doc.id, block.id);
        setDoc((d) => ({
          ...d,
          paragraphs: d.paragraphs.map((p) => (p.id === block.id ? { ...p, ...r.block } : p)),
        }));
        notify('已还原为解析时的原始内容');
      } catch (err) {
        notify(err.message, 'error');
      } finally {
        setBusy(false);
      }
    },
    [doc, notify],
  );

  /* ------------------------- AI 精修解析 ------------------------- */
  const runAiParse = useCallback(
    (docId) => {
      const parseRevision = docRevision.current;
      setAiPanel('running');
      setAiProgress({ total: 0, index: 0, appliedTotal: 0 });
      setAiUsage(null);
      setAiErrors([]);
      let appliedTotal = 0;

      const handle = aiParseStream(docId, {
        onEvent: (evt) => {
          if (parseRevision !== docRevision.current) return;
          if (evt.type === 'progress') {
            if (evt.phase === 'chunk') {
              setAiProgress((p) => ({ ...p, ...evt, appliedTotal }));
            } else if (evt.phase === 'chunk-done') {
              appliedTotal += evt.applied || 0;
              setAiProgress((p) => ({ ...p, index: evt.index, total: evt.total, appliedTotal }));
              setAiUsage(evt.usage);
            } else if (evt.phase === 'start') {
              setAiProgress({ total: evt.total, index: 0, appliedTotal: 0 });
            }
          } else if (evt.type === 'applied') {
            // 实时把已修正的块刷进界面
            api
              .getDocument(docId)
              .then((r) => {
                if (parseRevision !== docRevision.current) return;
                setDoc(r.document);
                setThreads(r.document.threads || {});
              })
              .catch(() => {});
          } else if (evt.type === 'done') {
            setAiUsage(evt.aiParse?.usage || null);
            setAiErrors(evt.errors || []);
            setAiPanel('done');
            aiAbort.current = null;
            api
              .getDocument(docId)
              .then((r) => {
                if (parseRevision !== docRevision.current) return;
                setDoc(r.document);
                setThreads(r.document.threads || {});
                setBudget(null);
              })
              .catch(() => {});
            refreshDocuments();
            notify(`AI 精修完成，消耗 ${(evt.aiParse?.usage?.totalTokens || 0).toLocaleString()} tokens（已保存）`);
          } else if (evt.type === 'aborted') {
            setAiPanel(null);
            aiAbort.current = null;
            api
              .getDocument(docId)
              .then((r) => {
                if (parseRevision !== docRevision.current) return;
                setDoc(r.document);
                setThreads(r.document.threads || {});
              })
              .catch(() => {});
            refreshDocuments();
            notify('已停止 AI 精修，已完成的修正已保存');
          } else if (evt.type === 'error') {
            setAiPanel(null);
            aiAbort.current = null;
            notify(evt.message || 'AI 精修失败', 'error');
          }
        },
        onError: (msg) => {
          if (parseRevision !== docRevision.current) return;
          setAiPanel(null);
          aiAbort.current = null;
          notify(msg, 'error');
        },
      });
      aiAbort.current = handle;
    },
    [notify, refreshDocuments],
  );

  const revertAiParse = useCallback(async () => {
    if (!doc) return;
    if (!window.confirm('还原为本地解析结果？AI 精修的改动会被丢弃（消耗记录保留）。')) return;
    try {
      const r = await api.revertAiParse(doc.id);
      setDoc(r.document);
      setThreads(r.document.threads || {});
      refreshDocuments();
      notify('已还原为本地解析结果');
    } catch (err) {
      notify(err.message, 'error');
    }
  }, [doc, notify, refreshDocuments]);

  /* --------------------------- 返回首页 --------------------------- */  const goHome = useCallback(() => {
    stopAll();
    setDoc(null);
    setThreads({});
    setPending({});
    setActiveId(null);
    setFoldedIds(new Set());
    setRowH([]);
    rowHRef.current = [];
    naturalRef.current = { left: {}, right: {} };
    setShowCross(false);
    setCrossSelected([]);
    localStorage.removeItem(LS_DOC);
    refreshDocuments();
  }, [refreshDocuments, stopAll]);

  /* ---------------------------- 上传 ---------------------------- */
  const afterCreate = async (result) => {
    stopAll();
    setDoc(result.document);
    setThreads(result.document.threads || {});
    setPending({});
    setRowH([]);
    rowHRef.current = [];
    setActiveId(null);
    localStorage.setItem(LS_DOC, result.document.id);
    setShowUpload(false);
    setUploadError('');
    refreshDocuments();
    notify(`解析完成，共 ${result.document.paragraphs.length} 个段落`);
  };

  const handleUploadFile = async (file, title, withAi) => {
    setBusy(true);
    setUploadError('');
    try {
      const r = await api.uploadFile(file, title);
      await afterCreate(r);
      if (withAi) runAiParse(r.document.id);
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleUploadText = async (text, title, withAi) => {
    setBusy(true);
    setUploadError('');
    try {
      const r = await api.uploadText(text, title);
      await afterCreate(r);
      if (withAi) runAiParse(r.document.id);
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setBusy(false);
    }
  };

  /* ---------------------------- 提问 ---------------------------- */
  const runAsk = useCallback(
    (paragraphId, question, citedParagraphIds) => {
      if (!doc || aborts.current[paragraphId]) return false;
      if (!config?.hasKey) {
        notify('请先在「设置」中配置 DeepSeek API 密钥', 'error');
        setShowSettings(true);
        return false;
      }
      const key = paragraphId;
      const requestRevision = docRevision.current;
      const target = paragraphs.find((p) => p.id === paragraphId);
      const originalCanvas = target && leftInnerRef.current?.children[target.index]?.querySelector('.pdf-snippet canvas');
      const sourceImage = originalCanvas?.style.display === 'block' ? originalCanvas.toDataURL('image/png') : undefined;
      setPending((p) => ({
        ...p,
        [key]: { text: '', citedParagraphIds: citedParagraphIds || [], streaming: true },
      }));

      const handle = askStream(
        doc.id,
        { paragraphId, question, citedParagraphIds, useStoredHistory: true, sourceImage },
        {
          onUserMessage: (message) => {
            if (requestRevision !== docRevision.current) return;
            setThreads((t) => {
              const list = t[paragraphId]?.messages ? [...t[paragraphId].messages] : [];
              list.push(message);
              return { ...t, [paragraphId]: { paragraphId, messages: list } };
            });
          },
          onDelta: (text) => {
            if (requestRevision !== docRevision.current) return;
            setPending((p) =>
              p[key] ? { ...p, [key]: { ...p[key], text: p[key].text + text } } : p,
            );
          },
          onReasoning: (text) => {
            if (requestRevision !== docRevision.current) return;
            setPending((p) =>
              p[key] ? { ...p, [key]: { ...p[key], reasoning: (p[key].reasoning || '') + text } } : p,
            );
          },
          onContext: (evt) => {
            if (requestRevision !== docRevision.current) return;
            setPending((p) =>
              p[key] ? { ...p, [key]: { ...p[key], contextTokens: evt.contextTokens, truncated: evt.truncated } } : p,
            );
            if (evt.truncated) {
              notify(
                `文档较长：本次发送约 ${Math.round(evt.contextTokens / 1000)}K tokens（上限 ${Math.round(evt.budget / 1000)}K），已按相关性节选相关段落`,
                'info',
              );
            }
          },
          onDone: (evt) => {
            if (requestRevision !== docRevision.current) return;
            setThreads((t) => {
              const list = t[paragraphId]?.messages ? [...t[paragraphId].messages] : [];
              list.push(evt.message);
              return { ...t, [paragraphId]: { paragraphId, messages: list } };
            });
            setPending((p) => {
              const next = { ...p };
              delete next[key];
              return next;
            });
            delete aborts.current[key];
            refreshDocuments();
          },
          onError: (message) => {
            if (requestRevision !== docRevision.current) return;
            setThreads((t) => {
              const list = t[paragraphId]?.messages ? [...t[paragraphId].messages] : [];
              list.push({
                id: `err_${Date.now()}`,
                role: 'assistant',
                content: '',
                error: message,
                createdAt: new Date().toISOString(),
              });
              return { ...t, [paragraphId]: { paragraphId, messages: list } };
            });
            setPending((p) => {
              const next = { ...p };
              delete next[key];
              return next;
            });
            delete aborts.current[key];
            notify(message, 'error');
          },
          onAborted: () => {
            if (requestRevision !== docRevision.current) return;
            setPending((p) => {
              const next = { ...p };
              delete next[key];
              return next;
            });
            delete aborts.current[key];
            refreshDocuments();
            api.getDocument(doc.id).then((r) => {
              if (requestRevision === docRevision.current) setThreads(r.document.threads || {});
            }).catch(() => {});
          },
        },
      );
      aborts.current[key] = handle;
      return true;
    },
    [doc, config, notify, refreshDocuments],
  );

  const stopAsk = useCallback((paragraphId) => {
    aborts.current[paragraphId]?.abort();
    delete aborts.current[paragraphId];
  }, []);

  const clearThread = useCallback(
    async (paragraphId) => {
      if (!doc) return;
      if (!window.confirm('确定清空该段落的全部问答记录？')) return;
      await api.clearThread(doc.id, paragraphId);
      setThreads((t) => {
        const next = { ...t };
        delete next[paragraphId];
        return next;
      });
      refreshDocuments();
      notify('已清空该段落的问答记录');
    },
    [doc, notify, refreshDocuments],
  );

  /* --------------------------- 设置保存 --------------------------- */
  const saveSettings = async (form) => {
    const r = await api.saveConfig(form);
    const fresh = await api.getConfig();
    setConfig(fresh);
    return fresh;
  };

  /* --------------------------- 快捷键 --------------------------- */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowUpload(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const answeredCount = useMemo(
    () =>
      paragraphs.filter((p) => (threads[p.id]?.messages || []).some((m) => m.role === 'user')).length,
    [paragraphs, threads],
  );

  const canOpenOriginalPage = Boolean(doc?.hasOriginalFile && doc?.format === 'pdf');
  const originalFileUrl = doc ? `${api.fileUrl(doc.id)}?inline=1` : '';

  // 上下文预算提示
  useEffect(() => {
    if (!doc) {
      setBudget(null);
      return;
    }
    let alive = true;
    api
      .contextBudget(doc.id)
      .then((r) => alive && setBudget(r))
      .catch(() => alive && setBudget(null));
    return () => {
      alive = false;
    };
  }, [doc]);

  const overBudget = Boolean(budget && budget.budgetTokens && budget.totalTokens > budget.budgetTokens);

  const contentStats = useMemo(() => {
    let table = 0;
    let image = 0;
    let formula = 0;
    for (const p of paragraphs) {
      if (p.type === 'table') table += 1;
      else if (p.type === 'image') image += 1;
      else if (p.type === 'formula') formula += 1;
    }
    return { table, image, formula };
  }, [paragraphs]);

  const crossMessages = threads[CROSS_KEY]?.messages || [];

  /* ------------------------ 回答折叠 ------------------------ */
  const toggleFold = useCallback((id) => {
    setFoldedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const foldableIds = useMemo(() => {
    const ids = [];
    for (const p of paragraphs) {
      for (const m of threads[p.id]?.messages || []) {
        if (m.role === 'assistant' && m.content) ids.push(m.id);
      }
    }
    for (const m of crossMessages) {
      if (m.role === 'assistant' && m.content) ids.push(m.id);
    }
    return ids;
  }, [paragraphs, threads, crossMessages]);

  const allFolded = foldableIds.length > 0 && foldableIds.every((id) => foldedIds.has(id));

  const toggleAllFolds = useCallback(() => {
    setFoldedIds((prev) => {
      const ids = foldableIds;
      if (!ids.length) return prev;
      const everyFolded = ids.every((id) => prev.has(id));
      if (everyFolded) return new Set();
      return new Set(ids);
    });
  }, [foldableIds]);

  const doJump = () => {
    const n = parseInt(jumpValue, 10);
    if (!Number.isFinite(n) || n < 1 || n > paragraphs.length) {
      notify(`请输入 1 – ${paragraphs.length} 之间的段落编号`, 'error');
      return;
    }
    focusParagraph(paragraphs[n - 1]);
    setJumpValue('');
  };

  /* ---------------------------- 渲染 ---------------------------- */
  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <button
            type="button"
            className="logo"
            onClick={goHome}
            title="返回首页"
            aria-label="返回首页"
          >
            <IconSpark width={18} height={18} />
          </button>
          <div className="brand-text">
            <h1 onClick={goHome} title="返回首页" role="button" tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && goHome()}>
              论文解析与提问
            </h1>
            <p>读原文 · 问细节 · 理解全文</p>
          </div>
        </div>

        <div className="toolbar-actions">
          <button className="btn primary" onClick={() => openUpload()}>
            <IconUpload width={16} height={16} /> 上传 / 粘贴
          </button>
          <button
            className="btn"
            onClick={() => setShowCross(true)}
            disabled={!doc}
            title="引用多个段落一起提问"
          >
            <IconLink width={16} height={16} /> 跨段落提问
            {crossMessages.length ? <em className="badge">{crossMessages.filter((m) => m.role === 'user').length}</em> : null}
          </button>
          <ExportMenu api={api} docId={doc?.id} hasOriginalFile={doc?.hasOriginalFile} />
          <button className="icon-btn" onClick={() => setShowHistory(true)} title="历史记录">
            <IconHistory />
          </button>
          <button className="icon-btn" onClick={() => setShowSettings(true)} title="设置">
            <IconSettings />
          </button>
          <button
            className="icon-btn"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            title="切换主题"
          >
            {theme === 'light' ? <IconMoon /> : <IconSun />}
          </button>
        </div>
      </header>
      {doc ? <div className="document-strip">        <div className="doc-title">
          {doc ? (
            <>
              <button className="btn ghost home-btn" onClick={goHome} title="返回首页（选择其他文档）">
                <IconHome width={15} height={15} /> 首页
              </button>
              <input
                className="title-input"
                value={titleDraft}
                aria-label="文档标题"
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                onBlur={saveTitle}
                title="点击可修改文档标题"
              />
              {doc.hasOriginalFile ? <button className="mini" disabled={busy} onClick={async () => {
                setBusy(true);
                try { const r = await api.reparseDocument(doc.id); await afterCreate(r); notify('已另存新版解析，旧文档和问答仍在历史记录中'); }
                catch (err) { notify(err.message, 'error'); }
                finally { setBusy(false); }
              }}>{busy ? '正在重新解析…' : '重新解析（保留旧版）'}</button> : null}
              <span className="chip">
                {String(doc.format || '').toUpperCase()} · {paragraphs.length} 段
                {contentStats.table ? ` · ${contentStats.table} 表` : ''}
                {contentStats.image ? ` · ${contentStats.image} 图` : ''}
                {contentStats.formula ? ` · ${contentStats.formula} 式` : ''}
                {` · ${answeredCount} 段有问答`}
              </span>
              {doc.aiParse?.enabled ? (
                <button
                  className="chip ai-chip"
                  onClick={revertAiParse}
                  title={`AI 精修于 ${new Date(doc.aiParse.at).toLocaleString('zh-CN')} · 消耗 ${(
                    doc.aiParse.usage?.totalTokens || 0
                  ).toLocaleString()} tokens（已保存）· 点击可还原为本地解析`}
                >
                  ✦ AI 精修 · {((doc.aiParse.usage?.totalTokens || 0) / 1000).toFixed(1)}K tokens
                </button>
              ) : (
                <button
                  className="chip ai-chip pending"
                  onClick={() => setAiPanel('confirm')}
                  title="用 AI 修正本地解析中的公式/表格问题（会消耗 token，结果会保存）"
                >
                  ✦ AI 精修解析
                </button>
              )}
            </>
          ) : (
            <span className="muted">尚未加载文档</span>
          )}
        </div>

</div> : null}

      {config && !config.hasKey ? (
        <div className="banner warn">
          <span>
            先配置一次 DeepSeek 密钥，之后就可以逐段提问。文档解析可直接使用。
          </span>
          <button className="btn small primary" onClick={() => setShowSettings(true)}>
            去配置
          </button>
        </div>
      ) : null}

      {doc?.meta?.warning ? <div className="parse-status" role="status">{doc.meta.warning}</div> : null}
      {doc ? (
        <div className="workspace">
          {showNav ? <ReadingNav paragraphs={paragraphs} threads={threads} activeId={activeId} query={search} onQuery={setSearch} onLocate={focusParagraph} onClose={() => setShowNav(false)} /> : null}
        <main className="panes">
          <section className="pane left">
            <div className="pane-head">
              <button className="mini nav-toggle" aria-label="打开论文目录" onClick={() => setShowNav(!showNav)}>目录</button>
              <span className="pane-title">
                <IconFile width={15} height={15} /> 文档内容
              </span>
              <span className="pane-sub">
                {doc.filename || '粘贴的文本'}
                {doc.meta?.pages ? ` · ${doc.meta.pages} 页` : ''}
              </span>
              <span className="pane-tools">
                {budget ? (
                  <span
                    className={`budget-chip ${overBudget ? 'over' : ''}`}
                    title={
                      overBudget
                        ? `全文约 ${budget.totalTokens.toLocaleString()} tokens，超过单次上限 ${budget.budgetTokens.toLocaleString()}；全文模式下会按问题相关性节选相关段落`
                        : `全文约 ${budget.totalTokens.toLocaleString()} tokens，一次提问即可完整发送`
                    }
                  >
                    {overBudget ? '全文超预算' : '全文可一次发送'} ·{' '}
                    {budget.totalChars.toLocaleString()} 字 ≈{' '}
                    {budget.totalTokens > 9999
                      ? `${Math.round(budget.totalTokens / 1000)}K`
                      : budget.totalTokens}{' '}
                    tokens
                  </span>
                ) : null}
                <label className="switch" title="左右两侧滚动联动">
                  <input type="checkbox" checked={syncScroll} onChange={(e) => setSyncScroll(e.target.checked)} />
                  <span>联动</span>
                </label>
                <div className="jump">
                  <input
                    value={jumpValue}
                    onChange={(e) => setJumpValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && doJump()}
                    placeholder="定位段落"
                    title="输入段落编号后回车，左右两栏一起滚动到该段"
                  />
                  <button className="icon-btn small" onClick={doJump} title="定位到段落">
                    <IconTarget width={15} height={15} />
                  </button>
                </div>
              </span>
            </div>

            <div className="pane-scroll" ref={leftScrollRef} onScroll={handleScroll('left')}>
              <div className="pane-inner" ref={leftInnerRef}>
                {paragraphs.map((p, i) => (
                  <div
                    key={p.id}
                    className={`row ${activeId === p.id ? 'active' : ''} ${search.trim() && p.text.toLowerCase().includes(search.trim().toLowerCase()) ? 'search-match' : ''} ${p.type}`}
                    onClick={() => setActiveId(p.id)}
                  >
                    <div className="row-gutter">
                      <span className="pnum">{p.index + 1}</span>
                      {p.page ? (
                        canOpenOriginalPage ? (
                          <button
                            type="button"
                            className="ppage ppage-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPageViewer(p.page);
                            }}
                            title={`查看第 ${p.page} 页原文`}
                          >
                            p{p.page}
                          </button>
                        ) : (
                          <span className="ppage">p{p.page}</span>
                        )
                      ) : null}
                      {p.type === 'image' ? <span className="block-badge" title="图片">图</span> : null}
                      {p.type === 'table' ? <span className="block-badge" title="表格">表</span> : null}
                      {p.type === 'formula' ? <span className="block-badge" title="公式">式</span> : null}
                    </div>
                    <div
                      className="row-content"
                      data-side="left"
                      data-ri={i}
                      style={{ minHeight: rowH[i] > 0 ? `${rowH[i]}px` : undefined }}
                    >
                      <div className="row-measure">
                        <BlockView
                          originalFileUrl={canOpenOriginalPage ? originalFileUrl : undefined}
                          block={p}
                          canOpenPage={canOpenOriginalPage}
                          busy={busy}
                          onZoomImage={(src, caption) => setLightbox({ src, caption })}
                          onOpenPage={(page) => setPageViewer(page)}
                          onSave={(patch) => saveParagraph(p, patch)}
                          onReset={() => resetParagraph(p)}
                        />
                        <div className="row-quick">
                          <button
                            className="mini"
                            onClick={(e) => {
                              e.stopPropagation();
                              focusParagraph(p);
                              rightScrollRef.current?.querySelector(`[data-ask="${p.id}"] textarea`)?.focus();
                            }}
                          >
                            去提问
                          </button>
                          <button
                            className="mini"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCrossSelected((s) => (s.includes(p.id) ? s : [...s, p.id]));
                              setShowCross(true);
                            }}
                          >
                            加入跨段引用
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="pane right">
            <div className="pane-head">
              <span className="pane-title">
                <IconSpark width={15} height={15} /> 段落提问
              </span>
              <span className="pane-sub">
                {config?.contextMode === 'full' ? '结合全文回答' : config?.contextMode === 'neighbors' ? '结合相邻段落' : '仅参考当前段落'}
              </span>
              {foldableIds.length ? (
                <div className="pane-tools">
                  <button
                    className="mini"
                    onClick={toggleAllFolds}
                    title={allFolded ? '展开全部 AI 回答' : '折叠全部 AI 回答'}
                  >
                    <IconFold width={13} height={13} />
                    {allFolded ? '展开全部回答' : '折叠全部回答'}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="pane-scroll" ref={rightScrollRef} onScroll={handleScroll('right')}>
              <div className="pane-inner">
                {paragraphs.map((p, i) => (
                  <QaCard
                    key={`${doc.id}:${p.id}`}
                    docId={doc.id}
                    onCitation={locateCitation}
                    allParagraphs={paragraphs}
                    notify={notify}
                    paragraph={p}
                    rowIndex={i}
                    height={rowH[i]}
                    messages={threads[p.id]?.messages || []}
                    pending={pending[p.id]}
                    active={activeId === p.id}
                    onFocus={() => focusParagraph(p, { scroll: false })}
                    onLocate={() => focusParagraph(p)}
                    onAsk={(q) => runAsk(p.id, q)}
                    onStop={() => stopAsk(p.id)}
                    onClear={() => clearThread(p.id)}
                    onCite={() => {
                      setCrossSelected((s) => (s.includes(p.id) ? s : [...s, p.id]));
                      setShowCross(true);
                    }}
                    foldedIds={foldedIds}
                    onToggleFold={toggleFold}
                  />
                ))}
              </div>
            </div>
          </section>
        </main>
        </div>
      ) : (
        <Landing onPick={openUpload} onHistory={() => setShowHistory(true)} documents={documents} onOpen={loadDocument} hasKey={config?.hasKey} onSettings={() => setShowSettings(true)} onDemo={() => handleUploadText(DEMO_TEXT, "示例：论文阅读入门", false)} busy={busy} />
      )}

      {showUpload ? (
        <UploadDialog
          initialTab={uploadTab}
          onClose={() => {
            setShowUpload(false);
            setUploadError('');
          }}
          onUploadFile={handleUploadFile}
          onUploadText={handleUploadText}
          busy={busy}
          error={uploadError}
        />
      ) : null}

      {showSettings ? (
        <SettingsDialog
          config={config}
          onClose={() => setShowSettings(false)}
          onSave={saveSettings}
          onVerify={(k) => api.verifyConfig(k)}
          onWriteEnv={(k) => api.writeEnv(k)}
          notify={notify}
        />
      ) : null}

      {showHistory ? (
        <HistoryDrawer
          documents={documents}
          currentId={doc?.id}
          loading={historyLoading}
          onClose={() => setShowHistory(false)}
          onRefresh={refreshDocuments}
          onOpen={async (id) => {
            const ok = await loadDocument(id);
            if (ok) setShowHistory(false);
          }}
          onDelete={async (id) => {
            await api.deleteDocument(id);
            if (doc?.id === id) {
              setDoc(null);
              setThreads({});
              localStorage.removeItem(LS_DOC);
            }
            refreshDocuments();
          }}
        />
      ) : null}

      {showCross && doc ? (
        <CrossDialog
          paragraphs={paragraphs}
          messages={crossMessages}
          pending={pending[CROSS_KEY]}
          initialSelected={crossSelected}
          onClose={() => {
            setShowCross(false);
            setCrossSelected([]);
          }}
          onAsk={(ids, q) => runAsk(CROSS_KEY, q, ids)}
          onStop={() => stopAsk(CROSS_KEY)}
          onClear={async () => {
            await api.clearThread(doc.id, CROSS_KEY);
            setThreads((t) => {
              const next = { ...t };
              delete next[CROSS_KEY];
              return next;
            });
          }}
        />
      ) : null}

      {toast ? <div className={`toast ${toast.type}`}>{toast.message}</div> : null}

      {lightbox ? (
        <ImageLightbox
          src={lightbox.src}
          caption={lightbox.caption}
          onClose={() => setLightbox(null)}
        />
      ) : null}

      {pageViewer && canOpenOriginalPage ? (
        <PageViewer
          url={originalFileUrl}
          page={pageViewer}
          totalPages={doc?.meta?.pages}
          onClose={() => setPageViewer(null)}
        />
      ) : null}

      {aiPanel && doc ? (
        <AiParsePanel
          mode={aiPanel}
          blockCount={paragraphs.length}
          progress={aiProgress}
          usage={aiUsage}
          errors={aiErrors}
          aiParse={doc.aiParse}
          onStart={() => runAiParse(doc.id)}
          onStop={() => aiAbort.current?.abort()}
          onClose={() => setAiPanel(null)}
        />
      ) : null}
    </div>
  );
}

/* ============================ 思考过程 ============================ */
function ReasoningBlock({ text, streaming = false }) {
  const [open, setOpen] = useState(false);
  const chars = String(text || '').length;
  return (
    <div className={`reasoning ${open ? 'open' : ''}`}>
      <button type="button" className="reasoning-head" onClick={() => setOpen((v) => !v)}>
        <IconChevron width={12} height={12} open={open} />
        思考过程{streaming ? '（进行中）' : ''}
        <span className="fold-hint">{chars} 字</span>
      </button>
      {open ? <div className="reasoning-body">{text}</div> : null}
    </div>
  );
}

/* ============================ 段落提问卡片 ============================ */
function QaCard({
  docId, onCitation, allParagraphs, notify,
  paragraph,
  messages,
  pending,
  active,
  height,
  onFocus,
  onLocate,
  onAsk,
  onStop,
  onClear,
  onCite,
  rowIndex,
  foldedIds,
  onToggleFold,
}) {
  const draftKey = 'paperinsight.draft.' + docId + '.' + paragraph.id;
  const [value, setValue] = useState(() => { try { return localStorage.getItem(draftKey) || ''; } catch { return ''; } });
  useEffect(() => { try { if (value) localStorage.setItem(draftKey, value); else localStorage.removeItem(draftKey); } catch {} }, [draftKey, value]);
  const taRef = useRef(null);

  const send = () => {
    const q = value.trim();
    if (!q || pending) return;
    if (onAsk(q) === false) return;
    setValue('');
    if (taRef.current) taRef.current.style.height = '';
  };

  const asked = messages.filter((m) => m.role === 'user').length;

  return (
    <CitationContext.Provider value={{ onCitation, allParagraphs }}>
    <div className={`row qa-card ${active ? 'active' : ''}`} data-ask={paragraph.id}>
      <div className="row-gutter">
        <span className="pnum">{paragraph.index + 1}</span>
      </div>
      <div
        className="row-content"
        data-side="right"
        data-ri={rowIndex}
        style={{ minHeight: height > 0 ? `${height}px` : undefined }}
      >
        <div className="row-measure">
        <div className="qa-head">
          <span className="qa-title">
            第 {paragraph.index + 1} 段提问
            {paragraph.page ? <em className="muted"> · 第 {paragraph.page} 页</em> : null}
          </span>
          {asked ? <span className="chip tiny">{asked} 轮对话</span> : null}
          <span className="spacer" />
          <button className="mini" onClick={onLocate} title="在左侧滚动到该段落">
            <IconTarget width={13} height={13} /> 定位
          </button>
          <button className="mini" onClick={onCite} title="把该段落加入跨段落引用">
            <IconLink width={13} height={13} /> 引用
          </button>
          {messages.length ? (
            <button className="mini danger" disabled={Boolean(pending)} onClick={onClear} title="清空该段落问答">
              <IconTrash width={13} height={13} />
            </button>
          ) : null}
        </div>

        {messages.length || pending ? (
          <div className="bubbles">
            {messages.map((m, i) => (
              <div key={m.id || i} className={`bubble ${m.role}`}>
                <div className="bubble-head">
                  {m.role === 'assistant' && m.content ? <button className="mini copy-answer" onClick={async () => { try { await navigator.clipboard.writeText(m.content); notify('回答已复制'); } catch { notify('无法访问剪贴板，请手动选择文字复制', 'error'); } }}>复制</button> : null}
                  <span className="who">{m.role === 'user' ? '我' : 'AI'}</span>
                  <span className="time">
                    {m.createdAt ? new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                  {m.role === 'assistant' && m.content ? (
                    <button
                      type="button"
                      className="fold-toggle"
                      onClick={() => onToggleFold(m.id)}
                      title={foldedIds.has(m.id) ? '展开这条回答' : '折叠这条回答'}
                    >
                      <IconChevron width={13} height={13} open={!foldedIds.has(m.id)} />
                      {foldedIds.has(m.id) ? '展开' : '折叠'}
                    </button>
                  ) : null}
                </div>
                {m.role === 'assistant' ? (
                  m.error ? (
                    <div className="msg-error">{m.error}<button className="mini" disabled={Boolean(pending)} onClick={() => { setValue(messages.slice(0, i).reverse().find((x) => x.role === "user")?.content || ""); taRef.current?.focus(); }}>重新填写问题</button></div>
                  ) : (
                    <>
                      {m.reasoning ? <ReasoningBlock text={m.reasoning} /> : null}
                      <FoldableAnswer
                        text={m.content}
                        allowedParagraphIds={m.includedParagraphIds}
                        collapsed={foldedIds.has(m.id)}
                        onToggle={() => onToggleFold(m.id)}
                      />
                      {m.outputTruncated ? <div className="answer-note">回答已达到长度上限，可以追问“请继续”。</div> : null}
                      {m.includedParagraphIds ? <div className="answer-note">本次参考 {m.includedParagraphIds.length} 个段落{m.truncated ? ' · 长文已按相关性节选' : m.contextMode === 'full' ? ' · 完整全文' : ''}</div> : null}
                      {m.imageProvided ? <div className="answer-note">同时参考了原 PDF 截图</div> : null}
                      {m.interrupted ? <div className="answer-note">生成已停止，以上是已生成的部分。</div> : null}
                    </>
                  )
                ) : (
                  <div className="user-text">{m.content}</div>
                )}
              </div>
            ))}

            {pending ? (
              <div className="bubble assistant streaming">
                <div className="bubble-head">
                  <span className="who">AI</span>
                  <span className="time">生成中…</span>
                </div>
                {pending.reasoning ? <ReasoningBlock text={pending.reasoning} streaming /> : null}
                {pending.text ? <Markdown text={pending.text} /> : null}
                {pending.text ? (
                  <span className="caret" />
                ) : pending.reasoning ? null : (
                  <div className="typing">
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="suggestions">{(!asked || active) && !pending ? QUICK_QUESTIONS.map(([label, question]) => <button key={label} className="question-chip" onClick={() => { setValue(question); onFocus(); taRef.current?.focus(); }}>{label}</button>) : null}</div>
        <div className="ask-box">
          <textarea
            ref={taRef}
            rows={2}
            value={value}
            aria-label={`第 ${paragraph.index + 1} 段的问题`}
            maxLength={4000}
            placeholder={asked ? "继续追问这一段…" : "这里有哪些不懂的？结合全文问一问…"}
            onFocus={onFocus}
            onChange={(e) => {
              setValue(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && !e.shiftKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {pending ? (
            <button className="btn danger small" onClick={onStop} title="停止生成">
              <IconStop width={14} height={14} /> 停止
            </button>
          ) : (
            <button className="btn primary small" onClick={send} disabled={!value.trim()}>
              <IconSend width={14} height={14} /> 发送
            </button>
          )}
        </div>
        {active ? <div className="ask-hint">Enter 发送 · Shift + Enter 换行{value ? ' · 草稿已保存' : ''}</div> : null}
        </div>
      </div>
    </div>
    </CitationContext.Provider>
  );
}

/* ============================== 空状态 ============================== */
const QUICK_QUESTIONS = [
 ['解释这段', '请结合全文，用通俗语言解释这一段的核心意思，并引用对应原文。'],
 ['梳理方法', '这段涉及什么方法或公式？请结合全文解释步骤、符号和适用条件。'],
 ['检查论证', '结合全文，这段的结论有哪些证据、假设和局限？请引用原文，区分推断。'],
];
const DEMO_TEXT = '论文阅读入门：用段落建立理解\n\n摘要\n\n阅读论文时，可以先明确研究问题，再梳理研究方法、实验结果和局限。每一段都有独立的作用，也与整篇论文的论证相连。\n\n1. 研究问题\n\n本文讨论如何提升长文档阅读效率。仅看一个段落容易忽略前文的定义，因此解释当前段落时，需要结合整篇文档。\n\n2. 方法与验证\n\n一种做法是先按原有结构划分段落，再为每段配置独立的提问入口。用户可以围绕概念、方法或证据追问。验证时应核对回答所引用的原文，而不是只看回答是否流畅。\n\n3. 局限与讨论\n\n自动解析的 PDF 可能出现公式、表格或阅读顺序问题，应保留原页核对入口。资料不足时，回答应明确说明，补充知识也应与作者的原文结论区分。';
