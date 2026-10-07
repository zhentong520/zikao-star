/**
 * 自考星 · 全量冒烟测试
 *
 * 覆盖：
 *   A. API 层 —— 18 个路由全部请求一遍，断言结构与数值合理性
 *   B. 前端层 —— Edge 无头渲染 6 个页面，dump DOM 断言关键内容
 *   C. 写操作 —— 成绩录入/删除、状态修改、变动确认（需演示库，勿用真实库！）
 *
 * 用法：
 *   node tests/smoke.js <端口> [baseUrl]
 *   前置：服务已启动（建议用演示库：ZK_DB=data-demo/zikao.db npm start）
 *
 * 退出码：0=全部通过，1=有失败
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.argv[2] || process.env.PORT || '5173';
const BASE = process.argv[3] || `http://127.0.0.1:${PORT}`;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` —— ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, body, text };
}

/* ============ A. API 层 ============ */
async function testAPIs() {
  console.log('\n━━━ A. API 接口测试 ━━━');

  // 1. bootstrap：全局骨架
  {
    const { status, body } = await api('/api/bootstrap');
    ok('GET /bootstrap 返回 200', status === 200);
    ok('  profile 存在', !!body?.profile?.nickname);
    ok('  group 含院校名', /大学/.test(body?.group?.school_name || ''), JSON.stringify(body?.group).slice(0, 80));
    ok('  progress 数值合理', body?.progress?.total > 0 && body?.progress?.percent >= 0);
    ok('  degree.avg 合理', body?.degree?.avg === null || (body?.degree?.avg >= 0 && body?.degree?.avg <= 100));
    ok('  stats.newsTotal > 0', (body?.stats?.newsTotal || 0) > 0, 'newsTotal=' + body?.stats?.newsTotal);
  }

  // 2. courses：科目列表
  let firstCode = '00023';
  {
    const { status, body } = await api('/api/courses');
    ok('GET /courses 返回 200', status === 200);
    const n = body?.courses?.length || 0;
    ok('  必考课程 ≥ 20 门', n >= 20, '实际 ' + n);
    ok('  无 null 状态', body?.courses?.every(c => c.status && c.status !== 'null'));
    const badType = body?.courses?.filter(c => typeof c.credits !== 'number');
    ok('  credits 均为数字', !badType?.length, badType?.slice(0, 2).map(c => c.code).join(','));
    ok('  addOn 结构完整', Array.isArray(body?.addOn?.active));
    firstCode = body?.courses?.find(c => !c.is_thesis)?.code || firstCode;
  }

  // 3. course：科目详情
  {
    const { status, body } = await api(`/api/course?code=${firstCode}`);
    ok(`GET /course?code=${firstCode} 返回 200`, status === 200);
    ok('  含成绩数组', Array.isArray(body?.scores));
    ok('  状态非 null', !!body?.status && body.status !== 'null');
    ok('  资讯 TOP3 字段存在', Array.isArray(body?.news));
  }

  // 4. degree：学位计算
  {
    const { status, body } = await api('/api/degree');
    ok('GET /degree 返回 200', status === 200);
    ok('  avg 在 0-100', body?.avg === null || (body.avg >= 0 && body.avg <= 100), 'avg=' + body?.avg);
    ok('  totalCredits > countedCredits 或相等', body?.totalCredits >= body?.countedCredits);
    ok('  模拟器 ≤ 8 个目标', (body?.simTargets?.length || 0) <= 8);
    const bad = (body?.simTargets || []).flatMap(t => t.table).filter(r => r.avg < 0 || r.avg > 100);
    ok('  模拟器数值全部在 0-100', bad.length === 0, bad.slice(0, 2).map(r => JSON.stringify(r)).join(','));
    const mono = (body?.simTargets || []).every(t =>
      t.table.every((r, i) => i === 0 || r.avg >= t.table[i - 1].avg - 0.05));
    ok('  模拟器随分数单调递增', mono);
    ok('  建议文案非空', typeof body?.advice === 'string' && body.advice.length > 10);
    ok('  条件自查 4 项', (body?.items?.length || 0) === 4);
  }

  // 5. news：资讯
  {
    const { status, body } = await api('/api/news?limit=10');
    ok('GET /news 返回 200', status === 200);
    ok('  返回数组', Array.isArray(body));
    ok('  每条含来源/分类', body?.every(n => n.source_name && n.category));
    if (body?.length) {
      // PC 端 API 的主键是数字 id（移动端 IndexedDB 才用 hash）
      const key = body[0].id !== undefined ? body[0].id : body[0].hash;
      const d = await api(`/api/news/detail?id=${encodeURIComponent(key)}`);
      ok('GET /news/detail 返回 200', d.status === 200);
      ok('  详情含正文', (d.body?.content || '').length > 20 || (d.body?.summary || '').length > 5,
        `content=${(d.body?.content || '').length} summary=${(d.body?.summary || '').length}`);
    }
  }

  // 6. calendar / changes / groups / directions / sources / crawl-log
  {
    const { status, body } = await api('/api/calendar');
    ok('GET /calendar 返回 200', status === 200);
    ok('  事件按日期升序', (body || []).every((e, i, a) => i === 0 || a[i - 1].date <= e.date));

    const ch = await api('/api/changes');
    ok('GET /changes 返回 200', ch.status === 200 && Array.isArray(ch.body));

    const g = await api('/api/groups');
    ok('GET /groups 返回 200', g.status === 200);
    ok('  至少 2 个课程组', (g.body?.length || 0) >= 2);

    const t = await api('/api/thesis/directions');
    ok('GET /thesis/directions 返回 200', t.status === 200);
    ok('  题目库 ≥ 10 条', (t.body?.length || 0) >= 10);

    const s = await api('/api/sources');
    ok('GET /sources 返回 200', s.status === 200);

    const l = await api('/api/crawl/log');
    ok('GET /crawl/log 返回 200', l.status === 200);
  }

  // 7. 写操作：状态修改 → 成绩录入 → 成绩删除（演示库专用）
  {
    const testCode = '02324'; // 离散数学（演示库中未考）
    const st = await api('/api/course/status', { method: 'POST', body: JSON.stringify({ code: testCode, status: '已报名', planned_exam_date: '2026-10-24', is_selected: 1 }) });
    ok('POST /course/status 成功', st.status === 200 && st.body?.ok !== false, st.text.slice(0, 100));

    const c1 = await api(`/api/course?code=${testCode}`);
    ok('  状态已生效', c1.body?.status === '已报名', '实际=' + c1.body?.status);
    ok('  考试日期已生效', c1.body?.planned_exam_date === '2026-10-24');

    const sv = await api('/api/score/save', { method: 'POST', body: JSON.stringify({ code: testCode, score: 77, exam_date: '2026-10-25', score_type: '正常', remark: '冒烟测试' }) });
    ok('POST /score/save 成功', sv.status === 200 && sv.body?.ok !== false, sv.text.slice(0, 100));
    ok('  返回最高分 77', sv.body?.bestScore === 77 || sv.body?.record?.bestScore === 77, JSON.stringify(sv.body).slice(0, 120));

    const c2 = await api(`/api/course?code=${testCode}`);
    const rec = c2.body?.scores?.find(r => r.score === 77);
    ok('  成绩已入库', !!rec);

    // 状态应为已通过（成绩优先推导）
    ok('  状态自动推导为已通过', c2.body?.status === '已通过', '实际=' + c2.body?.status);

    if (rec) {
      const del = await api('/api/score/delete', { method: 'POST', body: JSON.stringify({ code: testCode, recordId: rec.id }) });
      ok('POST /score/delete 成功', del.status === 200 && del.body?.ok !== false);
      const c3 = await api(`/api/course?code=${testCode}`);
      ok('  删除后无该成绩', !c3.body?.scores?.some(r => r.id === rec.id));
      ok('  删除后状态回退', c3.body?.status === '已报名' || c3.body?.status === '备考中' || c3.body?.status === '未开始', '实际=' + c3.body?.status);
    }

    // 恢复现场：改回未开始
    await api('/api/course/status', { method: 'POST', body: JSON.stringify({ code: testCode, status: '未开始', planned_exam_date: null }) });

    // change/ack（若有未读变动）
    const chs = await api('/api/changes');
    if (chs.body?.length) {
      const ack = await api('/api/change/ack', { method: 'POST', body: JSON.stringify({ id: chs.body[0].id }) });
      ok('POST /change/ack 成功', ack.status === 200);
    }
  }

  // 8. 异常路径
  {
    const nf = await api('/api/course?code=99999');
    ok('GET 不存在的课程 返回 200+null 或 404', nf.status === 404 || nf.body === null || nf.body?.code === undefined, 'status=' + nf.status);
    const bad = await api('/api/score/save', { method: 'POST', body: JSON.stringify({ code: '02324', score: 999 }) });
    ok('POST 非法分数被拒绝', bad.status >= 400 || bad.body?.ok === false || /0-100|分数/.test(bad.text), 'status=' + bad.status);
  }
}

/* ============ B. 前端页面 DOM ============ */
/**
 * 页面 DOM 由外层 bash 脚本（tests/smoke.sh）用 Edge --dump-dom 预先 dump
 * 到 DOM_DIR 目录，这里只负责读取文件做断言。
 *
 * 为什么不让 Node spawn Edge：本机环境的 Node 带 spawn 安全 shim（EBUSY），
 * bash 直接调 Edge 才是可靠通道。
 */
function dumpDom(url) {
  return ''; // 兼容占位（不使用）
}

async function testPages() {
  console.log('\n━━━ B. 前端页面渲染测试（DOM 由 bash 层 dump）━━━');

  const domDir = process.env.ZK_DOM_DIR || '';
  if (!domDir || !fs.existsSync(domDir)) {
    console.log('  ⚠️ 未设置 ZK_DOM_DIR 或目录不存在，跳过页面测试');
    console.log('     正确用法：bash tests/smoke.sh <端口>');
    return;
  }

  const pages = [
    { name: '首页', file: '01-home.html', checks: [
      ['院校名', /华南师范大学|深圳大学/],
      ['资讯板块', /本专业资讯/],
      ['进度模块', /毕业进度|学位课程平均|已载入/],
    ]},
    { name: '科目列表', file: '02-courses.html', checks: [
      ['标题', /我的科目/],
      ['状态分组出现', /已通过|未开始|已报名/],
    ]},
    { name: '科目详情', file: '03-course-detail.html', checks: [
      ['课程名(高等数学)', /高等数学/],
      ['成绩模块', /我的成绩|成绩记录|最高分|录入/],
      ['均分影响', /均分|学位/],
      ['资讯TOP3', /资讯/],
      ['注意事项', /注意事项/],
    ]},
    { name: '学位看板', file: '04-degree.html', checks: [
      ['均分仪表盘', /学位课程平均|分线/],
      ['条件自查', /申请条件自查/],
      ['外语途径', /英语|PETS|外语/],
      ['论文看板', /论文/],
      ['题目库', /题目库/],
    ]},
    { name: '资讯页', file: '05-news.html', checks: [
      ['分类标签', /全部|考纲|时间|学位/],
      ['资讯列表非空', /考试|通知|公告|报名/],
    ]},
    { name: '日历', file: '06-calendar.html', checks: [
      ['标题', /日历|考试|倒计时/],
    ]},
  ];

  for (const p of pages) {
    const file = path.join(domDir, p.file);
    console.log(`\n  ▶ ${p.name}  (${p.file})`);
    if (!fs.existsSync(file)) { ok(`${p.name} DOM 文件存在`, false, file); continue; }
    const html = fs.readFileSync(file, 'utf8');
    ok(`${p.name} DOM 非空`, html.length > 3000, html.length + ' 字符');
    // 启动成功与否由下面的内容断言覆盖（如课程列表/题目库等均为 JS 渲染）。
    // 说明：#boots（"已载入 N 门课程"）在启动遮罩 #boot 内部，遮罩 700ms 后被
    // remove，dump 时早已不存在，所以不能用"已载入"判断启动成功。
    for (const [label, re] of p.checks) {
      ok(`  ${label}`, re.test(html));
    }
  }
}

/* ============ 运行 ============ */
(async () => {
  console.log(`🧪 自考星冒烟测试`);
  console.log(`   目标：${BASE}`);
  console.log(`   时间：${new Date().toLocaleString('zh-CN')}`);

  // 前置检查
  const ping = await api('/api/bootstrap');
  if (ping.status !== 200) {
    console.error(`\n❌ 服务不可达（${BASE}），请先启动服务`);
    process.exit(1);
  }
  const isDemo = (ping.body?.profile?.nickname || '').includes('小鹿');
  console.log(`   数据库：${isDemo ? '演示库 ✓（可安全执行写操作）' : '⚠️ 非演示库，写操作将使用测试科目并恢复现场'}`);

  await testAPIs();
  await testPages();

  console.log('\n━━━━━━━━━━━━━━━━━━━━');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  } else {
    console.log('🎉 全部通过');
  }
})().catch(e => { console.error('❌ 测试执行异常:', e.message); process.exit(1); });
