/** LaTeX → Word 原生公式：通过真实生成 .docx 并检查 OMML XML 来验证 */
import { Document, Packer, Paragraph, Math as DocxMath } from 'docx';
import JSZip from 'jszip';
import { latexToMathComponents } from '../server/latexMath.js';

const CASES = [
  {
    name: '分数 + 求和 + 下标 + 关系符',
    tex: 'p_{ri}=\\frac{x_{ri}}{\\sum\\limits_{j=1}^{17} x_{rj}},p_{ri}\\ge0',
    expect: ['<m:f>', '<m:nary', '<m:sSub>', '<m:limLoc', '≥'],
  },
  {
    name: '上下标同时存在（sSubSup）',
    tex: 'x_{i}^{2}',
    expect: ['<m:sSubSup>'],
  },
  {
    name: '根式 + 上标',
    tex: 'R=\\sqrt[2]{ab^{2}}',
    expect: ['<m:rad', '<m:sSup>'],
  },
  {
    name: '带次数的根式（三次根）',
    tex: '\\sqrt[3]{x}',
    expect: ['<m:rad', '<m:deg>'],
  },
  {
    name: '期望等级公式',
    tex: 's_{ij} = \\sum_{k=0}^{5} k \\cdot \\frac{\\exp(l_{ijk})}{\\sum_{h=0}^{5}\\exp(l_{ijh})}',
    expect: ['<m:nary', '<m:f>', '<m:sSub>', '⋅'],
  },
  {
    name: '括号定界',
    tex: '\\left( \\frac{a}{b} \\right)',
    expect: ['<m:d>', '<m:f>'],
  },
  {
    name: '希腊字母与符号',
    tex: '\\alpha + \\beta \\le \\infty',
    expect: ['α', 'β', '≤', '∞'],
  },
];

let failures = 0;
const ok = (c, label, extra = '') => {
  console.log(`${c ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!c) failures += 1;
};

console.log('\nLaTeX → Word 原生公式（OMML）');
for (const c of CASES) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new DocxMath({ children: latexToMathComponents(c.tex) })] }),
        ],
      },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  const missing = c.expect.filter((e) => !xml.includes(e));
  ok(missing.length === 0, c.name, missing.length ? `缺少 ${missing.join(' ')}` : `含 ${c.expect.join(' ')}`);
}

console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
