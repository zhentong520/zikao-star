/**
 * 通过 gh CLI（而非 git 协议）推送代码到 GitHub。
 *
 * 背景：本机代理放行 GitHub API，但拦截 git 的 HTTPS CONNECT 隧道（502）。
 *   gh CLI 走 API 通道可通，因此这里用 gh api 逐个上传文件。
 *
 * 用法：node scripts/push-via-gh.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = process.env.GH_REPO || 'zhentong520/zikao-star';
const ROOT = path.join(__dirname, '..');
const GH = 'C:/Program Files/GitHub CLI/gh.exe';

function gh(args, input) {
  return execFileSync(GH, args, {
    encoding: input ? undefined : 'utf8',
    input,
    maxBuffer: 100 * 1024 * 1024,
  });
}
function ghJson(args) {
  return JSON.parse(gh(args));
}

/** 收集要上传的文件（按 .gitignore 过滤） */
function collectFiles() {
  const gi = path.join(ROOT, '.gitignore');
  const patterns = fs.existsSync(gi)
    ? fs.readFileSync(gi, 'utf8').split('\n').map(s => s.trim())
        .filter(s => s && !s.startsWith('#') && !s.startsWith('!'))
    : [];
  const ignored = (rel) => patterns.some(p => {
    if (p.endsWith('/')) return rel.startsWith(p) || rel.includes('/' + p.slice(0, -1) + '/');
    if (p.includes('*')) {
      const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
      return re.test(path.basename(rel)) || re.test(rel);
    }
    return rel === p || rel.endsWith('/' + p) || rel.includes('/' + p);
  });

  const files = [];
  (function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue;
      const full = path.join(dir, name);
      const rel = prefix ? prefix + '/' + name : name;
      if (fs.statSync(full).isDirectory()) { walk(full, rel); continue; }
      if (ignored(rel)) continue;
      const st = fs.statSync(full);
      if (st.size > 3 * 1024 * 1024) { console.log('  ⚠️ 跳过超大文件:', rel); continue; }
      files.push({ rel, full, size: st.size });
    }
  })(ROOT);
  return files;
}

/** 通过 gh api 创建 blob（走 stdin 传 base64，避免命令行长度限制） */
function createBlob(buffer) {
  const b64 = buffer.toString('base64');
  const payload = JSON.stringify({ content: b64, encoding: 'base64' });
  return JSON.parse(gh(['api', `repos/${REPO}/git/blobs`, '-X', 'POST', '--input', '-'], payload)).sha;
}

(async () => {
  console.log('📦 收集文件…');
  const files = collectFiles();
  const total = files.reduce((s, f) => s + f.size, 0);
  console.log(`   ${files.length} 个文件，共 ${(total / 1024).toFixed(0)} KB`);

  // 远端 ref
  let base = null;
  try {
    base = ghJson(['api', `repos/${REPO}/git/ref/heads/main`]).object.sha;
    console.log('   远端 main =', base.slice(0, 7));
  } catch (e) { console.log('   远端暂无 main 分支'); }

  console.log('📤 上传文件…');
  const tree = [];
  let done = 0;
  for (const f of files) {
    const sha = createBlob(fs.readFileSync(f.full));
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha });
    done++;
    if (done % 20 === 0) console.log(`   ${done}/${files.length}`);
  }
  console.log(`   ${tree.length} 个文件已上传`);

  const t = JSON.parse(gh(['api', `repos/${REPO}/git/trees`, '-X', 'POST', '--input', '-'],
    JSON.stringify({ base_tree: base, tree }))).sha;
  console.log('   tree:', t.slice(0, 7));

  const MSG = `feat: 自考星 v1.0 - 自考本科备考管理工具

- 选省份/院校/专业自动生成考纲（广东 080901 计算机科学与技术）
- 科目状态机 + 成绩录入，实时计算毕业进度与学位均分
- 双均分口径：真实均分（官方）+ 预测均分（模拟器），避免虚假安全感
- 多源爬虫 + 政策变动检测（风险分级），三层降噪
- 资讯详情本地缓存，离线可读
- 双运行模式：PC 端（Node + SQLite）/ Android 端（Capacitor 独立运行）
- 零第三方运行时依赖，使用 Node 22 内置 node:sqlite
- shared/ 让 PC 与手机共用同一套规则，保证结果一致

隐私：data/ 已 gitignore，仓库内为无个人数据的示例库`;
  const c = JSON.parse(gh(['api', `repos/${REPO}/git/commits`, '-X', 'POST', '--input', '-'],
    JSON.stringify({ message: MSG, tree: t, parents: base ? [base] : [] }))).sha;
  console.log('   commit:', c.slice(0, 7));

  if (base) {
    gh(['api', `repos/${REPO}/git/refs/heads/main`, '-X', 'PATCH', '--input', '-'],
      JSON.stringify({ sha: c, force: false }));
  } else {
    gh(['api', `repos/${REPO}/git/refs`, '-X', 'POST', '--input', '-'],
      JSON.stringify({ ref: 'refs/heads/main', sha: c }));
  }
  console.log('✅ 推送完成 → https://github.com/' + REPO);
})().catch(e => { console.error('❌ 失败:', String(e.message).slice(0, 400)); process.exit(1); });
