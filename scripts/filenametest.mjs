/** 文件名乱码修复 + rich 标记自测 */
import { fixFilename } from '../server/store.js';

let failures = 0;
const ok = (c, label, extra = '') => {
  console.log(`${c ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!c) failures += 1;
};

const cn = 'RobustBench_中文精读总结.docx';
const mojibake = Buffer.from(cn, 'utf8').toString('latin1'); // 模拟 busboy 的错误解码
console.log('  原始正确名 :', JSON.stringify(cn));
console.log('  乱码形态   :', JSON.stringify(mojibake));

ok(fixFilename(mojibake) === cn, '乱码文件名可还原为正确中文');
ok(fixFilename('paper.pdf') === 'paper.pdf', '纯 ASCII 文件名不受影响');
ok(fixFilename(cn) === cn, '已正确的中文文件名不会被二次破坏');
ok(fixFilename('') === '', '空值安全');
ok(fixFilename('报告 2024.pdf') === '报告 2024.pdf', '已正确的中文+空格不受影响');

console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
