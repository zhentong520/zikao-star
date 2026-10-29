/**
 * 构建前同步：把 shared/ 复制到 web/shared/。
 *
 * 为什么需要：
 *   Capacitor 只打包 webDir（web/），所以 web/shared/ 必须存在。
 *   但源码只有一份 shared/，避免两边改动不同步。
 *   cap sync 之前必须跑这个。
 *
 * 用法：node scripts/sync-shared.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'shared');
const DST = path.join(__dirname, '..', 'web', 'shared');

fs.mkdirSync(DST, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(SRC)) {
  if (!f.endsWith('.js')) continue;
  fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
  n++;
  console.log('  ✓', f);
}

// 题库 JSON（shared/banks/*.json）也要随 APK 打包，否则离线刷题没有题
const BANKS_SRC = path.join(SRC, 'banks');
const BANKS_DST = path.join(DST, 'banks');
if (fs.existsSync(BANKS_SRC)) {
  fs.mkdirSync(BANKS_DST, { recursive: true });
  let m = 0;
  for (const f of fs.readdirSync(BANKS_SRC)) {
    if (!f.endsWith('.json')) continue;
    fs.copyFileSync(path.join(BANKS_SRC, f), path.join(BANKS_DST, f));
    m++;
  }
  console.log(`  ✓ banks/ ${m} 个题库 JSON`);
  n += m;
}
console.log(`✅ 已同步 ${n} 个文件：shared/ → web/shared/`);

// ============ SW 缓存版本号自动打点 ============
// 此前 VERSION 是手写字符串（'zikao-v3'），忘记改就让用户永远吃旧缓存。
// 放在 sync-shared（cap:sync 的必经前置步骤）里，每次构建自动失效旧缓存。
// 注意：git 会看到 sw.js 变动，这是预期行为（版本号随构建变化）。
const SW = path.join(__dirname, '..', 'web', 'sw.js');
if (fs.existsSync(SW)) {
  const d = new Date();
  const pad = x => String(x).padStart(2, '0');
  const stamp = `zikao-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  let sw = fs.readFileSync(SW, 'utf8');
  const before = sw;
  sw = sw.replace(/const VERSION\s*=\s*'[^']*'/, `const VERSION = '${stamp}'`);
  if (sw !== before) {
    fs.writeFileSync(SW, sw);
    console.log(`  ✓ sw.js 缓存版本 → ${stamp}`);
  }
}
