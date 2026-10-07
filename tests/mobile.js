/**
 * 移动端（APK）逻辑自测 —— 模拟 WebView 环境（无 Node API）
 *
 * 覆盖：shared/store.js 的全部业务函数 + shared/rules.js 规则 + crawler-web.js 规则联动
 * 环境：mock localStorage / window，IndexedDB 缺席时验证降级不崩
 *
 * 用法：node tests/mobile.js
 * 退出码：0=全过，1=有失败
 */
const path = require('path');

// ---- WebView 环境模拟 ----
const mem = {};
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; },
};
global.window = global;
global.navigator = { userAgent: 'test' };
global.indexedDB = undefined; // 故意缺席，验证 idbAll/idbPut 降级
global.TextDecoder = require('util').TextDecoder;
global.fetch = () => Promise.reject(new Error('无网络（测试环境）'));

// 加载共享模块（web/shared 与 shared 同源，测 shared/ 即可）
require(path.join(__dirname, '..', 'shared', 'rules.js'));
require(path.join(__dirname, '..', 'shared', 'store.js'));

const R = global.ZKRules || global.window.ZKRules;
const S = global.ZKStore;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` —— ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

(async () => {
  console.log('🧪 移动端逻辑自测（模拟 WebView）\n');

  /* ---- 1. 考纲与档案 ---- */
  console.log('━━━ 1. 考纲与档案 ━━━');
  const g = S.getGroup();
  ok('课程组存在', !!g?.school_name);
  ok('含加考规则', Object.keys(S.SYLLABUS.addOnRules).length >= 4);
  const exam = S.getExamCourses();
  ok('应考课程 ≥ 20 门', exam.length >= 20, '实际 ' + exam.length);
  ok('计学分课程 = 应考 - 论文', S.getCreditsCourses().length === exam.filter(c => !c.is_thesis).length);
  const addRule = S.getAddOnRule();
  ok('加考规则含描述', typeof addRule.desc === 'string' && addRule.desc.length > 5);

  /* ---- 2. 成绩录入与状态推导 ---- */
  console.log('\n━━━ 2. 成绩录入与状态推导 ━━━');
  S.saveScore('15040', { score: 86, exam_date: '2026-04-12', score_type: '正常' });
  S.saveScore('00023', { score: 81, exam_date: '2026-04-12', score_type: '正常' });
  S.saveScore('13000', { score: 72, exam_date: '2026-04-12', score_type: '正常' });
  ok('最高分计算', S.bestScore('15040') === 86, '实际 ' + S.bestScore('15040'));
  ok('成绩优先→已通过', S.effectiveStatus('15040') === '已通过');

  // 手动状态被成绩覆盖
  S.setCourseStatus('15040', { status: '已报名' });
  ok('有及格分时手动状态被覆盖', S.effectiveStatus('15040') === '已通过', '实际 ' + S.effectiveStatus('15040'));

  // 补考按 60 计
  S.saveScore('13009', { score: 55, exam_date: '2026-04-12', score_type: '补考' });
  ok('bestScore 返回最高分含不及格（双端一致）', S.bestScore('13009') === 55, '实际 ' + S.bestScore('13009'));
  const dDeg55 = S.computeDegree();
  ok('均分不计入不及格的 55 分', !dDeg55.simTargets.some(t => t.code === '13009' && t.score === 55) &&
     dDeg55.countedCredits === 3 + 10 + 7, 'counted=' + dDeg55.countedCredits);
  ok('未过状态推导', S.effectiveStatus('13009') === '未通过');

  // 补考及格按 60 计入
  S.saveScore('13009', { score: 68, exam_date: '2026-10-25', score_type: '补考' });
  const items13009 = S.allScores('13009');
  const d2 = S.computeDegree();
  const rec13009 = d2.simTargets.find(t => t.code === '13009');
  ok('补考及格后状态已通过', S.effectiveStatus('13009') === '已通过');
  // 华师细则：补考及格按 60 计（best=68 但 isMakeup → 60）
  ok('补考按 60 计入（口径校验）', (() => {
    // 找一门无补考的同 4 学分课对比不明显，直接验证均分公式
    const passed = 86 * 3 + 81 * 10 + 72 * 7 + 60 * 4; // 15040/00023/13000/13009(补60)
    const credits = 3 + 10 + 7 + 4;
    return Math.abs(d2.avg - Math.round(passed / credits * 10) / 10) < 0.01;
  })(), 'avg=' + d2.avg);

  // 删除成绩后状态回退
  S.deleteScore('13009', 1); // 删掉补考 68
  ok('删除后回退未通过', S.effectiveStatus('13009') === '未通过', '实际 ' + S.effectiveStatus('13009'));
  S.deleteScore('13009', 0); // 删掉首考 55
  ok('全部删除后回未开始', S.effectiveStatus('13009') === '未开始' || S.effectiveStatus('13009') === '备考中', '实际 ' + S.effectiveStatus('13009'));

  /* ---- 3. 均分与模拟器 ---- */
  console.log('\n━━━ 3. 均分与模拟器 ━━━');
  const d = S.computeDegree();
  ok('真实均分 0-100', d.avg === null || (d.avg >= 0 && d.avg <= 100), 'avg=' + d.avg);
  ok('totalCredits ≥ countedCredits', d.totalCredits >= d.countedCredits);
  ok('预测均分 ≤ 真实均分（剩余课按70预估时）', d.predictAvg70 === null || d.countedCredits === d.totalCredits || d.predictAvg70 <= d.avg + 0.01,
    `predict70=${d.predictAvg70} avg=${d.avg}`);
  ok('模拟器 ≤ 8 目标', d.simTargets.length <= 8);
  const badRange = d.simTargets.flatMap(t => t.table).filter(r => r.avg < 0 || r.avg > 100);
  ok('模拟器值域 0-100', badRange.length === 0);
  const mono = d.simTargets.every(t => t.table.every((r, i) => i === 0 || r.avg >= t.table[i - 1].avg - 0.05));
  ok('模拟器单调递增', mono);
  ok('建议文案', typeof d.advice === 'string' && d.advice.length > 10);
  ok('条件自查 4 项', d.conditions.length === 4);

  /* ---- 4. 进度 ---- */
  console.log('\n━━━ 4. 毕业进度 ━━━');
  const p = S.computeProgress();
  ok('进度百分比 0-100', p.percent >= 0 && p.percent <= 100, p.percent);
  ok('已过学分 ≤ 总学分', p.earned <= p.total);
  ok('论文状态独立', typeof p.thesisDone === 'boolean');

  /* ---- 5. 规则层（双端共用） ---- */
  console.log('\n━━━ 5. 规则层 rules.js ━━━');
  ok('分类：时间', R.classify('2026年10月自考开考课程考试时间安排', '') === '时间');
  ok('分类：报名', R.classify('自学考试课程报考缴费的通知', '') === '报名');
  ok('分类：学位', R.classify('学士学位申请工作的通知', '') === '学位');
  ok('相关性：广东本科 ✓', R.isSelfStudyRelevant('广东自考计算机科学与技术（本科）', '', '资讯') === true);
  ok('相关性：外省 ✗', R.isSelfStudyRelevant('宁夏自考计算机科学与技术（本科）', '', '资讯') === false);
  ok('相关性：专科目录 ✗', R.isSelfStudyRelevant('广东自考610201(专科段)专业信息', '', '资讯') === false);
  ok('变动：报名截止', R.detectChange('自考报名将于9月4日截止')?.type === 'ENROLL_DEADLINE');
  ok('变动：停考', R.detectChange('关于某某专业停考的通知')?.risk === 'HIGH');
  ok('课程码匹配', R.matchCourses('高数00023 英语13000 离散02324').join() === '00023,13000,02324');
  ok('hash 稳定', R.simpleHash('https://a.com') === R.simpleHash('https://a.com'));
  ok('HTML 解析', R.extractMainText('<div>' + '正文内容。'.repeat(50) + '</div>').length > 100);

  /* ---- 6. IndexedDB 降级（APK 老内核可能没有 IDB） ---- */
  console.log('\n━━━ 6. IndexedDB 降级 ━━━');
  const newsList = await S.idbAll();
  ok('IDB 缺席时 idbAll 返回空数组不崩', Array.isArray(newsList) && newsList.length === 0);
  const putOk = await S.idbPut([{ hash: 'x' }]);
  ok('IDB 缺席时 idbPut 优雅返回 false', putOk === false);

  /* ---- 7. 导入导出 ---- */
  console.log('\n━━━ 7. 导入导出 ━━━');
  const exported = S.exportAll();
  ok('导出为 JSON', typeof exported === 'string' && JSON.parse(exported).state);
  S.saveScore('13003', { score: 94, exam_date: '2026-10-25', score_type: '正常' });
  const before = S.bestScore('13003');
  const imp = S.importData(exported);   // 回滚到导出点
  ok('导入成功', imp.ok);
  ok('导入回滚成绩（13003 恢复未考）', S.bestScore('13003') === null, '实际 ' + S.bestScore('13003'));

  /* ---- 8. 爬虫（无网络降级） ---- */
  console.log('\n━━━ 8. 爬虫模块加载 ━━━');
  try {
    require(path.join(__dirname, '..', 'shared', 'crawler-web.js'));
    ok('crawler-web.js 可加载', typeof global.ZKCrawler === 'object');
    ok('Crawler 类存在', typeof global.ZKCrawler?.Crawler === 'function');
    ok('自适应提频函数存在', typeof global.ZKCrawler?.dynamicInterval === 'function');
    const iv = global.ZKCrawler.dynamicInterval(60, 1);
    ok('提频下限保护（≥10分钟）', iv >= 10, 'iv=' + iv);
  } catch (e) {
    ok('crawler-web.js 可加载', false, e.message);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  } else {
    console.log('🎉 移动端逻辑全部通过');
  }
})().catch(e => { console.error('❌ 测试异常:', e); process.exit(1); });
