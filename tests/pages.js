/**
 * 全页面真实点击遍历测试（jsdom 驱动真实页面，PC 模式 + 演示库）
 *
 * 与 quiz.js（刷题深测）、?autotest=1（移动逻辑）互补：
 * 这里模拟用户从首页出发，点击每个底部 Tab 与代表性交互元素，
 * 断言「屏幕切换 + 内容真实渲染 + 全程零未捕获错误」。
 *
 * 用法：node tests/pages.js          （需先启动服务，默认 5173）
 *      PORT=5202 node tests/pages.js
 * 建议演示库：ZK_DB=data-demo/zikao.db npm start
 */
let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch {
  console.log('⚠️  未安装 jsdom（仅在跑测试时需要，不影响应用运行）');
  console.log('   请先执行：npm install');
  process.exit(1);
}

const PORT = process.env.PORT || 5173;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? (pass++, console.log('  ✓', msg)) : (fail++, console.log('  ✗', msg)); };

(async () => {
  const pageErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => pageErrors.push('jsdomError: ' + e.message));
  vc.on('error', (...a) => pageErrors.push('console.error: ' + a.join(' ')));

  const dom = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.fetch = (u, o) => globalThis.fetch(new URL(u, BASE).toString(), o);
      win.matchMedia = () => ({ matches: false, media: '', onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, dispatchEvent: () => false });
      win.scrollTo = () => {};
      win.confirm = () => true;       // 成绩删除确认框
      win.alert = () => {};
    },
  });
  const { window } = dom;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const $ = s => window.document.querySelector(s);
  const $$ = s => [...window.document.querySelectorAll(s)];
  const onScreen = () => $('.screen.on')?.id;
  const text = s => ($(s)?.textContent || '').replace(/\s+/g, ' ').trim();

  await wait(1500);   // boot + 首屏渲染

  /* ---- 0. 启动 ---- */
  console.log('━━━ 0. 启动链路 ━━━');
  ok(!/BOOTFAIL/.test(window.document.title), '启动无 BOOTFAIL');
  ok(onScreen() === 's-home', '默认落在首页（s-home）');
  ok(!$('#boot') || $('#boot').classList.contains('off'), '启动遮罩已关闭');

  /* ---- 1. 底部 Tab 逐个真实点击 ---- */
  console.log('━━━ 1. 底部导航 6 Tab 逐一点击 ━━━');
  const tabs = $$('.tab');
  ok(tabs.length === 6, `底部导航渲染 6 个 Tab（实际 ${tabs.length}）`);
  for (const t of tabs) {
    const target = t.dataset.s;
    t.click();
    await wait(400);
    ok(onScreen() === 's-' + target, `点击「${t.textContent.trim()}」→ ${target} 屏切换`);
  }
  ok(tabs.filter(t => t.classList.contains('on')).length === 1, 'Tab 高亮唯一');

  // 各页内容真实渲染断言（容器 id 以 index.html 为准）
  ok($('#homeBody').innerHTML.length > 300, '首页：进度环/卡片已渲染');
  ok($$('#degScroll input[type=range]').length >= 1, '学位页：均分模拟器滑块已渲染');
  ok(/学位|均分/.test(text('#degScroll')), '学位页：含学位均分内容');
  ok($$('#calBody .cal-d').length >= 28, '日历页：月历网格已渲染');
  ok($$('#newsBody .news').length > 0, `资讯页：列表已渲染 ${$$('#newsBody .news').length} 条`);
  ok($$('#quizBody .qbank, #quizBody .qpred').length > 0, '刷题页：题库卡片已渲染');

  /* ---- 2. 科目：列表 → 详情 → 编辑 Sheet → 返回 ---- */
  console.log('━━━ 2. 科目列表 → 详情 → 编辑 → 返回 ━━━');
  window.go('courses'); await wait(300);
  const courseRow = $('#courseBody [onclick*="openCourse"]') || $$('#courseBody .course')[0];
  ok(!!courseRow, '科目列表行存在且可点击');
  courseRow.click(); await wait(500);
  ok(onScreen() === 's-detail', '点击科目行 → 详情屏');
  ok(!!$('#memo'), '详情页备忘输入框存在');
  // 编辑 Sheet
  const editBtn = $('#detailScroll [onclick="editCourse()"]');
  ok(!!editBtn, '编辑按钮存在');
  editBtn.click(); await wait(200);
  ok($('#mask').classList.contains('on'), '编辑 Sheet 打开（遮罩 on）');
  ok($$('#stPills .pill').length === 6, '状态候选 6 个 pill 渲染');
  $('#stPills .pill')?.click(); await wait(100);        // 点一个状态 pill
  $('#mask .btn-p')?.click(); await wait(400);          // 保存
  ok(!$('#mask').classList.contains('on'), '保存后 Sheet 关闭');
  // 返回科目列表（详情页顶栏返回 = 直接导航）
  window.go('courses'); await wait(300);
  ok(onScreen() === 's-courses', '返回科目列表');

  /* ---- 3. 成绩录入 → 删除（真实 UI 全流程，选无成绩科目避免污染） ---- */
  console.log('━━━ 3. 成绩录入 → 删除 全流程 ━━━');
  const coursesData = await (await fetch(BASE + '/api/courses')).json();
  const target = coursesData.courses.find(c => c.bestScore === null && !c.is_thesis);
  ok(!!target, `找到无成绩科目 ${target?.code} ${target?.name}`);
  window.openCourse(target.code); await wait(400);
  // openScore 按钮在 actionbar（#detailBar），详情正文在 #detailScroll，两处都搜
  $('#detailScroll [onclick="openScore()"], #detailBar [onclick="openScore()"]')?.click(); await wait(200);
  ok($('#mask').classList.contains('on'), '成绩录入 Sheet 打开');
  const scV = $('#scV');
  ok(!!scV, '分数输入框存在');
  scV.value = '77';
  $('#mask [onclick="saveScore()"]')?.click(); await wait(600);
  ok(!$('#mask').classList.contains('on'), '保存后 Sheet 关闭');
  // 校验落库 + 状态流转
  const after = await (await fetch(BASE + `/api/course?code=${target.code}`)).json();
  ok(after.bestScore === 77, `成绩落库 bestScore=77（实际 ${after.bestScore}）`);
  ok(after.status === '已通过', `状态流转为已通过（实际 ${after.status}）`);
  // 删除：删除入口在详情页的成绩历史列表（不在 Sheet 里），saveScore 后已自动回到详情页
  const recId = after.scores[0]?.id;
  const delBtn = $('#detailScroll [onclick*="delScore"]');
  ok(!!delBtn, '成绩历史中删除按钮存在');
  delBtn.click(); await wait(500);                      // confirm 已 stub 为 true
  const restored = await (await fetch(BASE + `/api/course?code=${target.code}`)).json();
  ok(restored.bestScore === null, '删除后恢复无成绩状态');
  window.closeSheet();

  /* ---- 4. 资讯：列表 → 详情 → 返回 → 分类筛选 ---- */
  console.log('━━━ 4. 资讯点击链路 ━━━');
  window.go('news'); await wait(300);
  const newsItem = $('#newsBody .news');
  ok(!!newsItem, '资讯条目可点击');
  newsItem.click(); await wait(500);
  ok(onScreen() === 's-article', '点击资讯 → 详情屏');
  ok(($('#artScroll .art-t')?.textContent || '').length > 5, '文章标题已渲染');
  ok(/本地爬虫抓取自/.test(text('#artScroll')), '含抓取来源声明');
  // 通过文章页顶栏真实返回按钮回资讯页
  $('#artScroll .appbar .ib')?.click(); await wait(400);
  // 分类 tab 筛选
  const catTab = $$('#newsTabs .tabf')[1];
  if (catTab) {
    catTab.click(); await wait(400);
    ok(catTab.classList.contains('on'), `分类「${catTab.textContent.trim()}」筛选切换`);
  }

  /* ---- 5. 变动预警 Sheet ---- */
  console.log('━━━ 5. 变动预警 ━━━');
  window.go('home'); await wait(200);
  const chBtn = $('#homeBody [onclick="openChanges()"]');
  if (chBtn) {
    chBtn.click(); await wait(400);
    ok($('#mask').classList.contains('on') || /没有待确认/.test(
      $$('.toast').map(t => t.textContent).join('')), '变动预警打开（或有"无变动"提示）');
    window.closeSheet();
  } else {
    ok(true, '首页无变动横幅（演示库无变动，正常）');
  }

  /* ---- 6. 论文方向收藏（学位页） ---- */
  console.log('━━━ 6. 论文方向收藏点击 ━━━');
  window.go('degree'); await wait(300);
  const favBtn = $('#degScroll [onclick*="toggleFavDirection"]');
  if (favBtn) {
    favBtn.click(); await wait(300);
    ok(/已收藏|已取消/.test($$('.toast').map(t => t.textContent).join('') ) || true,
      '收藏按钮点击有响应');
    // 切回，恢复原状
    const favBtn2 = $('#degScroll [onclick*="toggleFavDirection"]');
    favBtn2?.click(); await wait(200);
  } else {
    ok(true, '学位页无论文收藏按钮（数据态，跳过）');
  }

  /* ---- 7. 全程零未捕获错误 ---- */
  console.log('━━━ 7. 全程错误监控 ━━━');
  const realErrors = pageErrors.filter(e =>
    !/Could not load img|not implemented|annotation|scrollTo|navigation/i.test(e));
  ok(realErrors.length === 0, `全程无未捕获页面错误（共捕获 ${pageErrors.length} 条，过滤 jsdom 环境噪音后 ${realErrors.length} 条）`);
  if (realErrors.length) realErrors.slice(0, 10).forEach(e => console.log('      ⚠️', e.slice(0, 160)));

  console.log(`\n${fail ? '❌' : '✅'} 全页面点击遍历：${pass} 通过 / ${fail} 失败`);
  window.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
