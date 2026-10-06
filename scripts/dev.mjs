#!/usr/bin/env node
/**
 * 开发模式：同时启动 Express 后端（8787）与 Vite 前端（5173，带 /api 代理）。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

function run(label, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: isWin });
  child.on('exit', (code) => {
    console.log(`[${label}] 退出，code=${code}`);
    process.exit(code ?? 0);
  });
  return child;
}

console.log('启动后端 http://127.0.0.1:8787 与前端 http://127.0.0.1:5173 ...');
run('server', process.execPath, [join(root, 'server', 'index.js')], root);
run('web', npmCmd, ['run', 'dev'], join(root, 'web'));
