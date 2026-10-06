import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildContextMessages } from '../server/context.js';
import { buildMathAwareLines } from '../server/pdfmath.js';
import { buildPageLines } from '../server/pdf-layout.js';
import { linesToBlocks } from '../server/pdf-paragraphs.js';

const cfg={ contextMode:'full', maxContextTokens:2000, systemPrompt:'清晰回答' };
const blocks=Array.from({length:80},(_,i)=>({ id:'p'+(i+1), index:i, text:'无关的背景资料。'.repeat(20), type:'paragraph' }));
blocks[79].text='最重要的验证结论：香蕉模型在外部验证中失败。';
const doc={title:'测试论文',paragraphs:blocks,format:'pdf'};
const built=buildContextMessages(doc,'p1',null,'香蕉模型的外部验证结果是什么？',[],cfg);
assert(built.truncated && built.contextTokens <= cfg.maxContextTokens);
assert(built.includedParagraphIds.includes('p1') && built.includedParagraphIds.includes('p80'));
assert(built.messages[0].content.includes('不是用户请求'));
console.log('✓ 长论文优先保留当前段落和末尾相关证据，完整消息在预算内');
const rounds=[{role:'user',content:'成功的问题'},{role:'assistant',content:'成功的回答'},{role:'user',content:'失败的问题'},{role:'assistant',content:'',error:'网络错误'}];
const small={...doc,paragraphs:blocks.slice(0,3)};
const next=buildContextMessages(small,'p1',null,'继续',rounds,{...cfg,maxContextTokens:10000});
assert(next.messages.some((m)=>m.content==='成功的回答'));
assert(!next.messages.some((m)=>m.content==='失败的问题'));
assert(!next.truncated && next.includedParagraphIds.length===3);
console.log('✓ 全文发送与多轮上下文；失败轮次不污染后续提问');
const people=buildMathAwareLines([{str:'1.甲同学',x:90,y:110,w:50,h:12},{str:'3.乙同学',x:90,y:85,w:50,h:12}], [{x0:85,x1:160,y0:98,y1:99}]);
assert(!people.some((l)=>l.tex.includes('\\frac')));
const citation=buildMathAwareLines([{str:'论文的方法',x:30,y:100,w:60,h:12},{str:'[4]',x:91,y:104,w:10,h:8}]);
assert(citation[0].text==='论文的方法[4]' && !citation[0].rich);
console.log('✓ 人名不会误识别为分式；中文上标引用保留原位置');
const dual=[];
for(let i=0;i<10;i++){dual.push({str:'Left '+i,x:40,y:700-i*16,w:210,h:12});dual.push({str:'Right '+i,x:330,y:700-i*16,w:210,h:12});}
const ordered=buildPageLines(dual,[],600);
assert(ordered.slice(0,10).every((l)=>l.text.startsWith('Left')));
assert(ordered.slice(10).every((l)=>l.text.startsWith('Right')));
console.log('✓ 双栏先左后右，不按纵坐标重新交错');
const line=(text,y,extra={})=>({text,tex:text,x0:40,x1:450,y,h:12,...extra});
const paragraphs=linesToBlocks([line('4.1数据核验',700),line('这是一段正文，有引用[3]。',680,{rich:true}),line('仍然属于同一段正文。',664),line('目录条目...........4',640)],1);
assert(paragraphs[0].type==='heading' && paragraphs[1].text.includes('仍然') && paragraphs[2].type==='list');
const table=linesToBlocks(Array.from({length:4},(_,i)=>line('名称 数值',700-i*16,{cells:[{x:40,text:'样本'+i},{x:190,text:String(i)}]})),1);
assert(table.length===1 && table[0].type==='table' && table[0].table.rows.length===4);
const baselineRows=[
  line('F1 mAP',700,{cells:[{x:260,x1:275,text:'F1'},{x:360,x1:390,text:'mAP'}]}),
  line('数据集 方法',696,{cells:[{x:40,x1:85,text:'数据集'},{x:150,x1:180,text:'方法'}]}),
  ...Array.from({length:3},(_,i)=>[
    line('S 0.8 0.9',680-i*20,{cells:[{x:40,x1:70,text:'S'},{x:260,x1:280,text:'0.8'},{x:360,x1:380,text:'0.9'}]}),
    line('本文方法',676-i*20,{cells:[{x:150,x1:200,text:'本文方法'}]})
  ]).flat()
];
const mixedTable=linesToBlocks(baselineRows,1)[0];
assert(mixedTable.type==='table' && mixedTable.table.rows.length===4 && mixedTable.table.cols===4);
assert.deepEqual(mixedTable.table.rows[0],['数据集','方法','F1','mAP']);
console.log('✓ 标题独立、目录分行、行内引用不拆段、对齐行重建表格');

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'paperinsight-reader-'));
let payload, broken=false;
const mock=http.createServer((req,res)=>{
  if(req.url==='/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'deepseek-flash'}]}));return;}
  let body=''; req.on('data',(chunk)=>body+=chunk);req.on('end',()=>{
    payload=JSON.parse(body); res.setHeader('Content-Type','text/event-stream');
    res.write('data: '+JSON.stringify({choices:[{delta:{content:'根据原文，验证应核对证据 [第3段]。'}}]})+'\n\n');
    if(!broken) res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\ndata: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r)=>mock.listen(0,'127.0.0.1',r));
const upstream='http://127.0.0.1:'+mock.address().port;
const appPort=process.env.READER_TEST_PORT || '8793';
const app=spawn(process.execPath,['server/index.js'],{cwd:root,env:{...process.env,PORT:appPort,PAPERINSIGHT_DATA_DIR:temp,DEEPSEEK_API_KEY:'mock-reader-only',DEEPSEEK_BASE_URL:upstream,DEEPSEEK_MODEL:'deepseek-flash'},stdio:'ignore',windowsHide:true});
const base='http://127.0.0.1:'+appPort;
const request=async(route,body,method='POST')=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});return {status:r.status,data:await r.json()};};
try {
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{} await new Promise((r)=>setTimeout(r,100));}assert(ready,'测试服务应启动');
  await request('/api/config',{apiKey:'mock-persisted-key',contextMode:'full'});
  await request('/api/config',{apiKey:'',temperature:.2});
  const conf=(await request('/api/config',null,'GET')).data;
  assert(conf.hasKey && conf.apiKeySource==='config' && conf.contextMode==='full');
  assert(!JSON.stringify(conf).includes('mock-persisted-key'));
  assert((await request('/api/config',{temperature:'not-a-number'})).status===400);
  console.log('✓ 修改设置保留已存密钥；返回值掩码；无效数字被拒绝');
  const created=(await request('/api/documents',{title:'问答测试',pastedText:'摘要\n\n介绍研究背景。\n\n1. 方法\n\n验证结论需要引用依据。'})).data.document;
  const stream=await(await fetch(base+'/api/documents/'+created.id+'/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paragraphId:'p2',question:'如何验证？'})})).text();
  assert(stream.includes('"type":"done"') && payload.thinking.type==='disabled');
  assert(payload.messages[1].content.includes('验证结论') && payload.messages[0].content.includes('[第N段]'));
  const stored=(await request('/api/documents/'+created.id,null,'GET')).data.document;
  assert(stored.threads.p2.messages.at(-1).includedParagraphIds.length===created.paragraphs.length);
  broken=true;
  const brokenStream=await(await fetch(base+'/api/documents/'+created.id+'/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paragraphId:'p2',question:'断流测试'})})).text();
  assert(brokenStream.includes('"type":"error"') && !brokenStream.includes('"type":"done"'));
  await request('/api/documents/'+created.id,{title:'更新标题'},'PATCH');
  assert((await request('/api/documents/'+created.id,null,'GET')).data.document.title==='更新标题');
  const exported=await(await fetch(base+'/api/documents/'+created.id+'/export?format=markdown')).text();assert(exported.includes('如何验证'));
  console.log('✓ 问答流、参考段落持久化、异常断流提示、标题保存和笔记导出');
  const pdfPath=path.join(root,'data','samples','sample.pdf');
  if(fs.existsSync(pdfPath)) {
    broken=false;
    const form=new FormData(); form.append('file',new Blob([fs.readFileSync(pdfPath)],{type:'application/pdf'}),'sample.pdf');
    const uploaded=await(await fetch(base+'/api/documents',{method:'POST',body:form})).json();
    assert(uploaded.document,'PDF 样例应上传成功');
    const pdfDoc=uploaded.document;
    const pdfTable=pdfDoc.paragraphs.find(p=>p.type==='table');
    assert(pdfTable?.table.rows.length===5 && pdfTable.table.cols===4,'混合中文和数字的 PDF 表格应保留行列');
    const formula=pdfDoc.paragraphs.find(p=>p.type==='formula'); assert(formula?.source?.pageHeight);
    const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX8sAAAAASUVORK5CYII=';
    const vision=await(await fetch(base+'/api/documents/'+pdfDoc.id+'/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paragraphId:formula.id,question:'解释公式',sourceImage:png})})).text();
    assert(vision.includes('"imageProvided":true'));
    assert(payload.messages.at(-1).content[1].image_url.url===png);
    const reparse=(await request('/api/documents/'+pdfDoc.id+'/reparse',{})).data.document;
    assert(reparse.id!==pdfDoc.id && reparse.meta.reparsedFrom===pdfDoc.id);
    const original=(await request('/api/documents/'+pdfDoc.id,null,'GET')).data.document;
    assert(original.threads[formula.id].messages.length===2,'重新解析不得覆盖旧问答');
    assert(!JSON.stringify(original.threads).includes(png),'问答记录不保存大幅截图');
    assert((await request('/api/documents/'+pdfDoc.id+'/ask',{paragraphId:formula.id,question:'test',sourceImage:'bad-data'})).status===400);
    console.log('✓ PDF 原图发送、截图校验、新版重解析、旧文档与问答保留');
  }
  console.log('Reader regression checks passed.');
} finally {app.kill();mock.close();}
