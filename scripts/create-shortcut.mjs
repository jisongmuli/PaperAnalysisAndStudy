/**
 * 在桌面创建「论文解析与提问」快捷方式（Windows .lnk）。
 * - 目标：项目根目录的 启动网站.cmd（会自动拉起后端并打开浏览器）
 * - 图标：assets/icon.ico（不存在时自动生成）
 * 用法：node scripts/create-shortcut.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function desktopDir() {
  const candidates = [];
  if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, 'Desktop'));
  if (process.env.OneDrive) candidates.push(path.join(process.env.OneDrive, 'Desktop'));
  candidates.push(path.join(os.homedir(), 'Desktop'));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function ps(script) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8' },
  ).trim();
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('该脚本仅支持 Windows。');
    process.exit(1);
  }

  // 图标
  let icon = path.join(root, 'assets', 'icon.ico');
  if (!fs.existsSync(icon)) {
    const { execFileSync: run } = await import('node:child_process');
    run(process.execPath, [path.join(root, 'scripts', 'make-icon.mjs')], { stdio: 'inherit', cwd: root });
  }
  if (!fs.existsSync(icon)) icon = null;

  // 启动器
  const launcher = path.join(root, '启动网站.cmd');
  if (!fs.existsSync(launcher)) {
    console.error(`未找到启动器：${launcher}`);
    process.exit(1);
  }

  const desktop = desktopDir();
  const lnk = path.join(desktop, '论文解析与提问.lnk');

  const script = `
$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut(${JSON.stringify(lnk)})
$sc.TargetPath = ${JSON.stringify(launcher)}
$sc.WorkingDirectory = ${JSON.stringify(root)}
$sc.Description = '启动并打开「论文解析与提问」网站'
$sc.WindowStyle = 1
${icon ? `$sc.IconLocation = ${JSON.stringify(`${icon},0`)}` : ''}
$sc.Save()
Write-Output $sc.FullName
`;
  const created = ps(script);
  console.log(`[shortcut] 已创建桌面快捷方式：${created}`);
  console.log(`[shortcut] 目标：${launcher}`);
}

main().catch((err) => {
  console.error('[shortcut] 创建失败：', err.message);
  if (err.stderr) console.error(String(err.stderr).trim());
  process.exit(1);
});
