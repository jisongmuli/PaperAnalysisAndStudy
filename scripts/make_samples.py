"""生成富内容自测样例（DOCX）：标题 / 正文 / 表格 / 图片 / OMML 公式。"""
import os
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls, qn
from PIL import Image, ImageDraw

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "data", "samples")
os.makedirs(OUT, exist_ok=True)


def make_figure(path):
    """画一张示意图当作论文插图。"""
    w, h = 640, 380
    img = Image.new("RGB", (w, h), "#ffffff")
    d = ImageDraw.Draw(img)
    # 坐标轴
    d.line([(70, 40), (70, h - 60)], fill="#333333", width=2)
    d.line([(70, h - 60), (w - 40, h - 60)], fill="#333333", width=2)
    # 柱状图
    bars = [("A", 120, "#6366f1"), ("B", 210, "#4f46e5"), ("C", 160, "#7c3aed"), ("D", 250, "#a855f7")]
    x = 110
    for label, val, color in bars:
        top = h - 60 - val
        d.rectangle([x, top, x + 70, h - 60], fill=color)
        d.text((x + 28, h - 50), label, fill="#333333")
        d.text((x + 20, top - 18), str(val), fill="#333333")
        x += 110
    d.text((80, 15), "Figure 1. Ablation results", fill="#111111")
    img.save(path)
    return path


def omml_display(tex_parts):
    """构造一个块级 OMML 公式：p_ri = x_ri / sum_j x_rj"""
    return f'''<m:oMathPara {nsdecls('m', 'w')}>
      <m:oMath>
        <m:sSub><m:e><m:r><m:t>p</m:t></m:r></m:e><m:sub><m:r><m:t>ri</m:t></m:r></m:sub></m:sSub>
        <m:r><m:t>=</m:t></m:r>
        <m:f>
          <m:num><m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>ri</m:t></m:r></m:sub></m:sSub></m:num>
          <m:den>
            <m:nary>
              <m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr>
              <m:sub><m:r><m:t>j=1</m:t></m:r></m:sub>
              <m:sup><m:r><m:t>17</m:t></m:r></m:sup>
              <m:e><m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>rj</m:t></m:r></m:sub></m:sSub></m:e>
            </m:nary>
          </m:den>
        </m:f>
        <m:r><m:t>,</m:t></m:r>
        <m:sSub><m:e><m:r><m:t>p</m:t></m:r></m:e><m:sub><m:r><m:t>ri</m:t></m:r></m:sub></m:sSub>
        <m:r><m:t>≥0</m:t></m:r>
      </m:oMath>
    </m:oMathPara>'''


def omml_inline():
    """行内公式：E = mc^2，用根式做一个稍复杂的形式"""
    return f'''<m:oMath {nsdecls('m', 'w')}>
      <m:r><m:t>R</m:t></m:r>
      <m:r><m:t>=</m:t></m:r>
      <m:rad>
        <m:deg><m:r><m:t>2</m:t></m:r></m:deg>
        <m:e><m:r><m:t>a</m:t></m:r><m:sSup><m:e><m:r><m:t>b</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:e>
      </m:rad>
    </m:oMath>'''


doc = Document()
doc.add_heading("基于深度学习的文档理解研究综述", level=0)

doc.add_heading("摘要", level=1)
doc.add_paragraph(
    "本文系统综述了深度学习在文档理解领域的研究进展。文档理解旨在从非结构化文档中抽取结构化信息，"
    "涵盖版面分析、文本识别、表格解析与语义抽取等子任务。近年来，随着预训练语言模型与视觉-语言模型的兴起，"
    "该领域取得了显著进展。"
)

doc.add_heading("1 引言", level=1)
doc.add_paragraph(
    "文档是人类知识传承的主要载体。据估计，企业数据中约百分之八十以非结构化文档形式存在，"
    "包括合同、发票、学术论文与病历等。如何让机器自动理解这些文档，成为信息检索与知识管理的关键问题。"
)

doc.add_heading("2 方法", level=1)
doc.add_paragraph(
    "本文提出的框架包含三个阶段：文档图像预处理、多模态特征编码与结构化解码。"
    "解码阶段采用受限解码策略，保证输出符合目标模式。"
)

# ---- 块级公式 ----
p_formula = doc.add_paragraph()
p_formula._p.append(parse_xml(omml_display(None)))

doc.add_paragraph(
    "其中 x_ri 为第 r 组配方中第 i 个领域的原始比例，分母为全部 17 个领域之和，"
    "使比例向量落在单纯形上（非负且分量和为 1）。"
)

# ---- 行内公式 ----
p_inline = doc.add_paragraph("模型复杂度可由 ")
p_inline._p.append(parse_xml(omml_inline()))
p_inline.add_run(" 衡量，其中 a 为基础系数，b 为缩放因子。")

# ---- 表格 ----
doc.add_heading("3 实验结果", level=1)
table = doc.add_table(rows=5, cols=4)
table.style = "Table Grid"
data = [
    ["数据集", "方法", "F1", "mAP"],
    ["FUNSD", "LayoutLM", "0.792", "0.741"],
    ["FUNSD", "本文方法", "0.815", "0.762"],
    ["CORD", "LayoutLM", "0.901", "0.845"],
    ["CORD", "本文方法", "0.928", "0.873"],
]
for r, row in enumerate(data):
    for c, val in enumerate(row):
        cell = table.cell(r, c)
        cell.text = val
        if r == 0:
            for para in cell.paragraphs:
                for run in para.runs:
                    run.bold = True

doc.add_paragraph(
    "表 1 给出了在 FUNSD 与 CORD 两个公开数据集上的对比结果。可以看出，本文方法在实体抽取任务上的 "
    "F1 值较基线提升约 2.3 个百分点。"
)

# ---- 图片 ----
fig = make_figure(os.path.join(OUT, "_figure1.png"))
doc.add_heading("4 消融分析", level=1)
doc.add_paragraph("图 1 展示了去掉不同模块后的性能变化。")
doc.add_picture(fig, width=Inches(4.2))
doc.add_paragraph("图 1 消融实验结果（柱状图）。")

doc.add_heading("5 结论", level=1)
doc.add_paragraph("未来工作将探索更高效的预训练策略以及面向长文档的层次化建模方法。")

path = os.path.join(OUT, "sample.docx")
doc.save(path)
print("written:", path)
