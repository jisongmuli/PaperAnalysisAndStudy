/**
 * 网站启动器（由桌面快捷方式 / 启动网站.cmd 调用）
 * 1) 检查服务是否已在运行
 * 2) 未运行则在后台启动后端（日志写入 data/server.log）
 * 3) 等待就绪后用默认浏览器打开
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
const URL = `http://${HOST}:${PORT}/`;
const DATA_DIR = path.join(root, 'data');
const LOG = path.join(DATA_DIR, 'server.log');

fs.mkdirSync(DATA_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${URL}api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function startServer() {
  const out = fs.openSync(LOG, 'a');
  fs.writeSync(out, `\n===== ${new Date().toLocaleString('zh-CN')} 启动服务 =====\n`);
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, PORT: String(PORT), HOST },
  });
  child.unref();
  return child;
}

async function main() {
  if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
    console.log('首次运行：正在构建阅读界面…');
    await new Promise((resolve, reject) => {
      const child = process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', 'npm run build'], { cwd:root, stdio:'inherit', windowsHide:true })
        : spawn('npm', ['run', 'build'], { cwd:root, stdio:'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => code===0 ? resolve() : reject(new Error('前端构建失败，请先运行 npm install 并检查依赖')));
    });
  }
  if (await healthy()) {
    console.log('服务已在运行，直接打开浏览器…');
    openBrowser(URL);
    return;
  }

  console.log('正在启动后端服务…');
  startServer();

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await healthy()) {
      console.log(`服务已就绪：${URL}`);
      openBrowser(URL);
      return;
    }
  }

  console.error(`服务启动超时，请手动检查 ${LOG}`);
  process.exitCode = 1;
}

main().catch((err) => { console.error(err.message); process.exitCode=1; });
