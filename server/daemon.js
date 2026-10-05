/**
 * 爬虫守护进程 —— 让资讯"自己会更新"，不用手动点。
 * 用法：node server/daemon.js
 * 建议：Windows 计划任务开机自启，或用 pm2 常驻
 */
const path = require('path');
const { Crawler } = require('./crawler');

const DB = process.env.ZK_DB || path.join(__dirname, '..', 'data', 'zikao.db');
const c = new Crawler(DB);

console.log(`
🕷  自考星 爬虫守护进程
   数据库：${DB}
   频率：自适应提频（报名期/考前 30 天自动加密到 10 分钟级）
   停止：Ctrl+C
`);

let tick = 0;
async function loop() {
  tick++;
  try {
    const r = await c.runOnce(false);
    const now = new Date().toLocaleTimeString('zh-CN');
    if (r.skipped) {
      process.stdout.write(`   [${now}] 暂无到期数据源，等待下一轮\n`);
    } else {
      console.log(`   [${now}] 源 ${r.sources} · 成功 ${r.ok} · 失败 ${r.failed} · 新增 ${r.added} 条 · 变动 ${r.changes} 项`);
      if (r.added > 0) {
        const latest = c.db.prepare('SELECT title,category FROM news ORDER BY id DESC LIMIT 3').all();
        latest.forEach(n => console.log(`      📰 [${n.category}] ${n.title.slice(0, 46)}`));
      }
      if (r.changes > 0) {
        const ch = c.db.prepare("SELECT risk_level,title FROM change_record WHERE acknowledged_at IS NULL ORDER BY detected_at DESC LIMIT 3").all();
        ch.forEach(x => console.log(`      🔔 [${x.risk_level}] ${x.title.slice(0, 46)}`));
      }
    }
  } catch (e) {
    console.error('   [错误]', e.message);
  }
  // 每 10 轮做一次全量刷新（每天至少一次完整重爬）
  const waitMs = (tick % 10 === 0) ? 30 * 60000 : 3 * 60000;
  setTimeout(loop, waitMs);
}

process.on('SIGINT', () => {
  console.log('\n👋 已停止。再见！');
  process.exit(0);
});

loop();
