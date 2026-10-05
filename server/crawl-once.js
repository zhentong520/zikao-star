/** 一次性全量抓取（命令行用）  用法：node server/crawl-once.js */
const path = require('path');
const { Crawler } = require('./crawler');

const DB = process.env.ZK_DB || path.join(__dirname, '..', 'data', 'zikao.db');

(async () => {
  const c = new Crawler(DB);
  console.log('🕷  开始全量抓取…\n');
  const r = await c.runOnce(true);
  console.log(`\n✅ 完成：源 ${r.sources} · 成功 ${r.ok} · 失败 ${r.failed} · 发现 ${r.found} · 新增 ${r.added} · 变动 ${r.changes}`);

  const srcs = c.db.prepare('SELECT key,name,last_success_at,fail_count,note FROM source WHERE enabled=1').all();
  console.log('\n📡 数据源状态：');
  srcs.forEach(s => {
    const ok = s.fail_count === 0 && s.last_success_at;
    console.log(`   ${ok ? '✅' : '⚠️ '} ${s.name.padEnd(24, '　')} ${s.last_success_at || '未成功'}${s.fail_count ? ` (失败${s.fail_count}次)` : ''}`);
  });

  const ch = c.db.prepare('SELECT risk_level,title,detected_at FROM change_record WHERE acknowledged_at IS NULL').all();
  if (ch.length) {
    console.log(`\n🔔 待确认变动 ${ch.length} 项：`);
    ch.forEach(x => console.log(`   [${x.risk_level}] ${x.title.slice(0, 60)}`));
  }
  const total = c.db.prepare('SELECT COUNT(*) n FROM news').get().n;
  console.log(`\n📰 本地资讯库共 ${total} 条`);
  process.exit(0);
})();
