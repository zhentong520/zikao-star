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
