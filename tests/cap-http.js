/**
 * CapacitorHttp 抓取路径单测 —— APK 内资讯抓取的唯一通道。
 *
 * 背景：WebView 里 fetch 外部站点被 CORS 拦截（政府站无 CORS 头），
 * 必须走 CapacitorHttp 原生请求。本测试 mock 插件验证：
 *   ① APK 环境下走 CapacitorHttp 而非 fetch
 *   ② 正常响应解析 / 非 200 拒绝 / 重试后成功 / 空响应拒绝
 *
 * 用法：node tests/cap-http.js
 */
const path = require('path');

const mem = {};
global.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
global.window = global;
global.navigator = { userAgent: 'test' };
global.indexedDB = undefined;
global.TextDecoder = require('util').TextDecoder;
global.fetch = () => { throw new Error('浏览器 fetch 不应在 APK 环境被调用'); };

// mock Capacitor 插件
const FAKE_HTML = '<html><head><title>测试公告标题_广东省教育考试院</title></head><body>' + '正文内容测试。'.repeat(80) + '</body></html>';
let callLog = [];
let responses = [];   // 队列：依次返回；抛错对象表示失败
global.Capacitor = { Plugins: { CapacitorHttp: {
  async get(opts) {
    callLog.push({ url: opts.url, responseType: opts.responseType });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r;
  },
} } };

require(path.join(__dirname, '..', 'shared', 'rules.js'));
require(path.join(__dirname, '..', 'shared', 'crawler-web.js'));
const C = global.ZKCrawler;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` —— ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

(async () => {
  console.log('🧪 CapacitorHttp 抓取路径单测\n');

  // 1. 正常响应
  callLog = []; responses = [{ status: 200, data: FAKE_HTML }];
  const html = await C.fetchHtml('https://example.gov.cn/a.html');
  ok('正常响应返回 HTML', html === FAKE_HTML);
  ok('走 CapacitorHttp（非 fetch）', callLog.length === 1 && callLog[0].responseType === 'TEXT');

  // 2. 非 200 → 抛错
  responses = [{ status: 403, data: 'forbidden' }];
  let threw = false;
  try { await C.fetchHtml('https://example.gov.cn/b.html', { retries: 0 }); } catch (e) { threw = /403/.test(e.message); }
  ok('非 200 状态拒绝并抛错', threw);

  // 3. 失败重试后成功
  callLog = []; responses = [new Error('网络抖动'), { status: 200, data: FAKE_HTML }];
  const html2 = await C.fetchHtml('https://example.gov.cn/c.html', { retries: 2 });
  ok('失败后重试成功', html2 === FAKE_HTML && callLog.length === 2);

  // 4. 重试耗尽 → 抛最后一次错误
  responses = [new Error('超时1'), new Error('超时2'), new Error('超时3')];
  threw = false;
  try { await C.fetchHtml('https://example.gov.cn/d.html', { retries: 2 }); } catch (e) { threw = /超时/.test(e.message); }
  ok('重试耗尽抛最后错误', threw);

  // 5. 空响应拒绝
  responses = [{ status: 200, data: 'x' }];
  threw = false;
  try { await C.fetchHtml('https://example.gov.cn/e.html', { retries: 0 }); } catch (e) { threw = /过短/.test(e.message); }
  ok('空/过短响应拒绝', threw);

  // 6. 端到端：Crawler 用 mock 源真实跑一轮入库
  {
    // 造一个 mock store
    const news = [];
    const store = {
      idbAll: async () => news.slice(),
      idbPut: async (recs) => { news.push(...recs); return true; },
      idbClear: async () => { news.length = 0; return true; },
      SYLLABUS: { sources: [{ key: 't1', name: '测试源', url: 'https://example.gov.cn/list', type: '官方', category: '政策', interval_min: 60 }] },
      loadState: () => ({ sourceLog: {}, settings: { crawlMultiplier: 1 } }),
      setSetting: () => {},
      recordSourceCrawl: () => {},
    };
    // 列表页含一个相关链接（fetchHtml 有"响应过短"校验，mock 需足够长）
    responses = [{ status: 200, data: '<html><head><title>测试源列表页</title></head><body>' + '站点导航内容。'.repeat(30) + '<a href="/n1.html">广东省2026年10月自学考试成绩公布通知</a></body></html>' }];
    const cr = new C.Crawler(store);
    const stat = await cr.runOnce(true);
    ok('Crawler 端到端：抓到并入库 1 条', stat.added === 1 && news.length === 1);
    ok('入库记录为列表级（正文延迟）', news[0] && news[0].need_fetch === 1 && news[0].content === null);
    ok('标题级变动检测生效', news[0] && news[0].change_type === 'SCORE_RELEASE');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('🎉 CapacitorHttp 路径全部通过');
})().catch(e => { console.error('❌ 异常:', e.message); process.exit(1); });
