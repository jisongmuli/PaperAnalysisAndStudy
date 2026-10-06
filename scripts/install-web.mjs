#!/usr/bin/env node
/**
 * postinstall：把 web/ 目录的前端依赖也装上（单仓库双 package.json）。
 * 失败时只提示，不阻断主安装。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const webDir = join(root, 'web');

if (!existsSync(join(webDir, 'package.json'))) process.exit(0);
if (process.env.PAPER_INSIGHT_SKIP_WEB === '1') process.exit(0);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
console.log('[postinstall] 安装前端依赖 web/ ...');
const r = spawnSync(npmCmd, ['install', '--no-audit', '--no-fund'], {
  cwd: webDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (r.status !== 0) {
  console.warn('[postinstall] 前端依赖安装失败，请手动执行：cd web && npm install');
}
process.exit(0);
