/**
 * 前端绑定自检：静态比对「方法调用」与「方法定义」，防止 APK 装到手机才发现
 * "xxx is not a function" 这类错误（PC 有后端兜底，只有移动模式才会炸）。
 *
 * 覆盖：ZKLocal / Local（web/index.html）与 ZKStore（shared/store.js）、ZKRules（rules.js）
 *
 * 用法：node tests/check-bindings.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const storeJs = fs.readFileSync(path.join(ROOT, 'shared', 'store.js'), 'utf8');
const rulesJs = fs.readFileSync(path.join(ROOT, 'shared', 'rules.js'), 'utf8');
const mobileJs = fs.readFileSync(path.join(ROOT, 'tests', 'mobile.js'), 'utf8');
const crawlerJs = fs.readFileSync(path.join(ROOT, 'shared', 'crawler-web.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` —— ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

/**
 * 提取对象字面量定义的方法名。
 * 用「声明行 → 行首 };" 」界定 body（对象字面量以行首 }; 结束，避免花括号计数
 * 被模板字符串 ${} 破坏），再按行匹配方法定义形态（行首缩进 + 可选 async + 名字( ）。
 */
function definedMethods(source, declLine) {
  const start = source.indexOf(declLine);
  if (start < 0) return [];
  const end = source.indexOf('\n};', start);
  const body = source.slice(start, end < 0 ? undefined : end);
  const methods = new Set();
  for (const m of body.matchAll(/^\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) methods.add(m[1]);
  return [...methods];
}

/** 提取 obj.method( 调用集合（objName 不含点） */
function calledMethods(source, objName) {
  const re = new RegExp('(?<![\\w$.])' + objName + '\\.([A-Za-z_$][\\w$]*)\\s*\\(', 'g');
  return [...new Set([...source.matchAll(re)].map(m => m[1]))];
}

console.log('🧪 前端绑定自检\n');

/* ---- ZKLocal ---- */
{
  const defs = definedMethods(html, 'const ZKLocal = {');
  const calls = calledMethods(html, 'ZKLocal');
  console.log(`ZKLocal：定义 ${defs.length} 个，调用 ${calls.length} 种`);
  const missing = calls.filter(c => !defs.includes(c));
  ok('ZKLocal 所有调用均有定义', missing.length === 0, '缺失: ' + missing.join(', '));
  const unused = defs.filter(d => !calls.includes(d));
  if (unused.length) console.log(`  ℹ️ 定义未调用: ${unused.join(', ')}`);
}

/* ---- Local ---- */
{
  const defs = definedMethods(html, 'const Local = {');
  const calls = calledMethods(html, 'Local').filter(c => c !== 'Storage');
  console.log(`Local：定义 ${defs.length} 个，调用 ${calls.length} 种`);
  const missing = calls.filter(c => !defs.includes(c));
  ok('Local 所有调用均有定义', missing.length === 0, '缺失: ' + missing.join(', '));
}

/* ---- ZKStore（store.js 用简写列表导出，需验证每个名字有实体声明）---- */
{
  const start = storeJs.indexOf('window.ZKStore = {');
  const body = storeJs.slice(start, storeJs.indexOf('\n};', start));
  // 简写导出项：identifier,（行内逗号分隔），排除方法调用/属性访问形态
  const exported = new Set();
  for (const m of body.matchAll(/(?:^|[,{]\s*)([A-Za-z_$][\w$]*)\s*(?=[,}])/gm)) exported.add(m[1]);
  // 验证每个导出名在 store.js 有 function/const 声明
  const missingDecl = [...exported].filter(n =>
    n !== 'SYLLABUS' && !new RegExp('(function\\s+' + n + '\\b|const\\s+' + n + '\\s*=)').test(storeJs));
  ok(`ZKStore 导出项均有实体声明（${exported.size} 项）`, missingDecl.length === 0, missingDecl.join(', '));

  // 调用一致性：index.html 与 mobile.js
  const callsHtml = calledMethods(html, 'window.ZKStore');
  const missingHtml = callsHtml.filter(c => !exported.has(c));
  console.log(`ZKStore：导出 ${exported.size} 个，index.html 调用 ${callsHtml.length} 种，mobile.js 调用 ${calledMethods(mobileJs, 'S').length} 种`);
  ok('index.html 对 ZKStore 的调用均有定义', missingHtml.length === 0, '缺失: ' + missingHtml.join(', '));
  const callsMobile = calledMethods(mobileJs, 'S');
  const missingMobile = callsMobile.filter(c => !exported.has(c));
  ok('mobile.js 对 ZKStore 的调用均有定义', missingMobile.length === 0, '缺失: ' + missingMobile.join(', '));
}

/* ---- ZKRules（rules.js 双端导出：module.exports + window.ZKRules）---- */
{
  const expStart = rulesJs.indexOf('const ZKRules = {');
  const expBody = rulesJs.slice(expStart, rulesJs.indexOf('\n};', expStart));
  // 导出名单可能一行多个（classify, isSelfStudyRelevant, ...），按逗号拆
  const exported = new Set();
  for (const line of expBody.split('\n').slice(1)) {
    for (const item of line.split(',')) {
      const t = item.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) exported.add(t);
    }
  }
  exported.delete('const');
  const calls = calledMethods(crawlerJs, 'R');
  console.log(`ZKRules：导出 ${exported.size} 个，crawler-web 调用 ${calls.length} 种`);
  const missing = calls.filter(c => !exported.has(c));
  ok('crawler-web 对 ZKRules 的调用均有导出', missing.length === 0, '缺失: ' + missing.join(', '));
  ok('rules.js 挂载 window.ZKRules（APK 爬虫依赖）', /window\.ZKRules\s*=\s*ZKRules/.test(rulesJs));
}

/* ---- onclick 全量审计：每个按钮的处理函数必须真实存在 ---- */
{
  const KEYWORDS = new Set(['if', 'for', 'while', 'return', 'confirm']);
  const fns = new Set();
  for (const m of html.matchAll(/onclick="([A-Za-z_$][\w$]*)\s*\(/g)) fns.add(m[1]);
  const missing = [...fns].filter(fn => !KEYWORDS.has(fn) && !new RegExp('function\\s+' + fn + '\\b').test(html));
  console.log(`onclick 审计：${fns.size} 个按钮处理函数，缺失 ${missing.length} 个`);
  ok('所有 onclick 处理函数均已定义', missing.length === 0, '缺失: ' + missing.join(', '));

  // 假动作审计：toast 文案用完成时态（"已xx"）= 欺骗性按钮，禁止。
  // 提示类文案（如"可截图保存"）允许。
  const fake = [...html.matchAll(/onclick="toast\('([^']+)'\)"/g)]
    .map(m => m[1]).filter(t => /^已|^完成|成功$/.test(t));
  ok('无「完成时态」的假按钮（只弹提示却声称已操作）', fake.length === 0, fake.join(' | '));
}

/* ---- 启动链路关键点 ---- */
{
  ok('detectMode 存在', /async function detectMode/.test(html));
  ok('mobile 分支后台触发抓取（到期制，不阻塞启动）', /ZKLocal\.crawl\(false\)\.then/.test(html) && !/await ZKLocal\.crawl\(\)/.test(html));
  ok('loadNews 移动分支走 ZKLocal.news', /ZKLocal\.news\(\{/.test(html));
  ok('移动端 newsDetail 有定义且被调用', defsHave(html, 'ZKLocal', 'newsDetail') && /ZKLocal\.newsDetail\(/.test(html));
}
function defsHave(source, obj, method) {
  return definedMethods(source, `const ${obj} = {`).includes(method);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log('🎉 绑定完整性检查全部通过');
}
