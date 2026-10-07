/**
 * 通过 GitHub API 推送代码（纯 Node fetch，不依赖 git 协议、不 spawn 任何程序）
 *
 * 为什么不用 git push：
 *   部分网络环境的代理只放行 GitHub API，git 的 HTTPS CONNECT 被拦截（502），
 *   SSH 需要配公钥。GitHub API（HTTP）是唯一稳定通道。
 *
 * 为什么不 spawn gh：
 *   部分托管 Node 带 spawn 安全 shim（EBUSY），spawn gh.exe/cmd.exe 都会被拦。
 *   纯 fetch + token 完全绕开。
 *
 * 用法（由 push-via-gh.sh 编排，也可手动）：
 *   node scripts/push-core.mjs <repo> <token> <文件清单文件> <commit消息文件>
 *
 * 文件清单由外层 bash 的 `git ls-files` 生成（天然处理 .gitignore）。
 */
import fs from 'fs';
import path from 'path';

const [repo, token, listFile, msgFile] = process.argv.slice(2);
if (!repo || !token || !listFile || !msgFile) {
  console.error('用法: node push-core.mjs <repo> <token> <文件清单> <消息文件>');
  process.exit(1);
}
const API = 'https://api.github.com';
const ROOT = process.cwd();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 带重试的 API 调用：GitHub 偶发 500/502，指数退避重试 4 次 */
async function api(pathname, opts = {}, retries = 4) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(API + pathname, {
        ...opts,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          ...(opts.headers || {}),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.status === 204 ? null : res.json();
    } catch (e) {
      // 4xx 客户端错误（除 429 限流）重试无意义
      const status = Number((e.message.match(/HTTP (\d+)/) || [])[1] || 0);
      if (status >= 400 && status < 500 && status !== 429) throw e;
      if (attempt >= retries) throw e;
      const wait = 1500 * 2 ** attempt;
      console.log(`   ⏳ ${e.message.slice(0, 60)} → ${wait / 1000}s 后重试 (${attempt + 1}/${retries})`);
      await sleep(wait);
    }
  }
}

const files = fs.readFileSync(listFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
  .filter(f => f !== 'package-lock.json' && fs.existsSync(f) && fs.statSync(f).isFile());

console.log(`📦 仓库: ${repo} ｜ 待上传 ${files.length} 个文件`);

// 基线
let base = null;
try {
  base = (await api(`/repos/${repo}/git/ref/heads/main`)).object.sha;
  console.log(`🔍 远端 main = ${base.slice(0, 7)}`);
} catch { console.log('🔍 远端暂无 main 分支，将新建'); }

// blob
const tree = [];
let i = 0;
for (const rel of files) {
  const content = fs.readFileSync(path.join(ROOT, rel));
  const blob = await api(`/repos/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  });
  tree.push({ path: rel.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.sha });
  if (++i % 20 === 0) console.log(`   ${i}/${files.length}`);
}
console.log(`✅ ${tree.length} 个 blob 上传完成`);

// tree
const t = await api(`/repos/${repo}/git/trees`, {
  method: 'POST',
  body: JSON.stringify(base ? { base_tree: base, tree } : { tree }),
});
console.log(`🌳 tree: ${t.sha.slice(0, 7)}`);

// commit
const message = fs.readFileSync(msgFile, 'utf8');
const body = { message, tree: t.sha };
if (base) body.parents = [base];
const commit = await api(`/repos/${repo}/git/commits`, { method: 'POST', body: JSON.stringify(body) });
console.log(`✅ commit: ${commit.sha.slice(0, 7)}`);

// ref
if (base) {
  await api(`/repos/${repo}/git/refs/heads/main`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
} else {
  await api(`/repos/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.sha }),
  });
}
console.log(`\n🎉 推送完成 → https://github.com/${repo}`);
