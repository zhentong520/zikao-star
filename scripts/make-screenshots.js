/**
 * 生成 README 界面截图
 *
 * 用本机已装的 Edge 无头模式，不需要下载 Chromium（几百 MB）。
 * 前置：先用演示数据库启动服务（避免截图泄露真实成绩）
 *   node server/make-demo-db.js
 *   ZK_DB=data-demo/zikao.db npm start
 *
 * 用法：node scripts/make-screenshots.js [端口]
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.join(__dirname, '..', 'docs', 'images');
const PORT = process.argv[2] || process.env.PORT || '5173';
const BASE = `http://127.0.0.1:${PORT}/`;

if (!fs.existsSync(EDGE)) {
  console.error('❌ 未找到 Edge，请改用其他无头浏览器或手动截图');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

/** Edge 的 --screenshot 参数在 Windows 上需要反斜杠绝对路径 */
const winPath = (p) => p.replace(/\//g, '\\');

const SHOTS = [
  ['01-home', '', 1620],
  ['02-courses', 'courses', 1720],
  ['03-course-detail', 'course=00023', 2150],
  ['04-degree', 'degree', 2100],
  ['05-news', 'news', 1500],
  ['06-calendar', 'cal', 1600],
];

console.log('📸 生成界面截图');
console.log(`   服务：${BASE}`);
console.log('');

let ok = 0;
for (const [name, query, h] of SHOTS) {
  const out = path.join(OUT, name + '.png');
  if (fs.existsSync(out)) fs.unlinkSync(out);
  try {
    execFileSync(EDGE, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      `--window-size=750,${h}`,
      `--screenshot=${winPath(out)}`,
      '--virtual-time-budget=11000',
      '--disable-features=ServiceWorker',
      `${BASE}?shot=${query}`,
    ], { stdio: 'pipe', timeout: 90000 });
  } catch (e) { /* Edge 常把告警写 stderr，忽略 */ }
  if (fs.existsSync(out)) {
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    console.log(`  ✓ ${name}.png  ${kb} KB`);
    ok++;
  } else {
    console.log(`  ✗ ${name}.png  失败`);
  }
}

console.log('');
console.log(`完成 ${ok}/${SHOTS.length} → docs/images/`);
if (ok < SHOTS.length) process.exit(1);
