/**
 * 刷题模块冒烟测试（jsdom 驱动真实页面，验证渲染与判题逻辑）
 * 用法：node tests/quiz.js            （需先启动服务，默认 5173 端口）
 *      PORT=5199 node tests/quiz.js
 *
 * 为什么要有这个测试：
 *   刷题是纯前端逻辑，报错只会在手机上白屏，用 jsdom 跑一遍能在提交前抓到
 *   渲染异常、判题错误、错题本不落库这类问题。
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
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.log('  [jsdom]', e.message));
  vc.on('error', e => console.log('  [console.error]', e));

  const dom = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    // jsdom 不实现 fetch / matchMedia，页面代码会直接抛错，这里补上垫片
    beforeParse(win) {
      win.fetch = (u, o) => globalThis.fetch(new URL(u, BASE).toString(), o);
      win.matchMedia = () => ({
        matches: false, media: '', onchange: null,
        addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {},
        dispatchEvent: () => false,
      });
      win.scrollTo = () => {};
    },
  });
  const { window } = dom;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(1200);   // 等 boot 流程 + fetch

  const $ = s => window.document.querySelector(s);
  // QB 是 const 声明（全局词法作用域），只能通过页面内 eval 取到
  const QB = () => window.eval('QB');
  const text = s => ($(s)?.textContent || '').replace(/\s+/g, ' ').trim();

  ok(!!$('#s-quiz'), '刷题页面（s-quiz）已挂载');
  ok(!!window.document.querySelector('.tab[data-s="quiz"]'), '底部导航有「刷题」入口');

  // --- 题库列表 ---
  window.go('quiz');
  await wait(900);
  const cards = window.document.querySelectorAll('#quizBody .qbank');
  const predCards = window.document.querySelectorAll('#quizBody .qpred');
  ok(cards.length === 3, `题库卡片渲染 3 个（实际 ${cards.length}）`);
  ok(/共 154 题/.test(text('#quizSub')), `顶部统计显示总题量：「${text('#quizSub')}」`);

  // --- 考点预测卡（历代真题频次） ---
  ok(predCards.length === 2, `考点预测卡渲染 2 个课程（实际 ${predCards.length}）`);
  ok(/×4 场/.test(text('#quizBody')), '预测卡显示考点频次（×N 场）');
  ok(/命题规律/.test(text('#quizBody')), '预测卡含命题规律折叠区');
  ok(/练 \d+ 题/.test(text('#quizBody')), '预测卡热点带「练 N 题」入口');
  ok(/考纲/.test(text('#quizSub')) || /考纲/.test(text('#quizBody')), '页面说明考纲匹配（只显示能刷的题）');

  // --- 考点聚焦练习：从预测卡入口进入，只练命中题 ---
  window.startBank('13005-sprint', '13005-sprint.json', 'all', 'DFD|数据流图', '考点：DFD 数据流图');
  await wait(400);
  ok($('#s-run')?.classList.contains('on'), '考点聚焦进入答题页');
  ok(QB().list.length > 0 && QB().list.length < 50, `聚焦列表是子集（${QB().list.length} 题 < 50）`);
  ok(QB().list.every(q => /DFD|数据流图/.test((q.kp || '') + (q.stem || ''))), '聚焦列表每题都命中该考点');
  ok(/考点：DFD/.test(text('#runScroll .qt')), '答题页标题显示聚焦考点');
  window.go('quiz');
  await wait(600);

  // --- 进入第一个题库答题 ---
  window.startBank('15040-sprint', '15040-sprint.json');
  await wait(500);
  ok($('#s-run')?.classList.contains('on'), '进入答题页');
  ok(!!$('#runScroll .qstem'), '题干已渲染');
  ok(window.document.querySelectorAll('#runScroll .qopt').length === 4, '单选题渲染 4 个选项');

  // --- 答对一题：取正确选项点击 ---
  const q = QB().list[QB().idx];
  const correct = q.answer[0];
  window.pickOpt(correct);
  await wait(300);
  const rec = window.ZKStore.getPractice('15040-sprint').rec[q.id];
  ok(rec && rec.ok === 1, `答对后落库（${q.id} → ok=1）`);
  ok(/答对了/.test(text('#runScroll .qans')), '答对反馈文案显示');
  ok(/考点：/.test(text('#runScroll .qans')), '解析带考点');

  // --- 答错一题 ---
  window.stepQ(1);
  await wait(200);
  const q2 = QB().list[QB().idx];
  const wrongOpt = ['A', 'B', 'C', 'D'].find(k => k !== q2.answer);
  window.pickOpt(wrongOpt);
  await wait(300);
  ok(window.ZKStore.getPractice('15040-sprint').rec[q2.id].ok === 0, '答错后落库（ok=0）');
  ok(/答错了/.test(text('#runScroll .qans')), '答错反馈文案显示');

  // --- 错题本 ---
  const wrong = window.ZKStore.wrongQuestions('15040-sprint', QB().list);
  ok(wrong.length === 1 && wrong[0].id === q2.id, `错题本收录 1 题（${wrong.map(w => w.id)}）`);
  window.go('quiz');
  await wait(700);
  ok(/错题 1/.test(text('#quizBody')), '题库卡片显示错题数');

  // --- 多选判题 ---
  window.startBank('13005-sprint', '13005-sprint.json');
  await wait(400);
  const multiIdx = QB().list.findIndex(x => x.type === 'multi');
  ok(multiIdx >= 0, `软件工程题库含多选题（第 ${multiIdx + 1} 题）`);
  QB().idx = multiIdx;
  window.renderRun();
  await wait(200);
  const mq = QB().list[multiIdx];
  mq.answer.split('').forEach(k => window.pickOpt(k));
  await wait(150);
  ok(window.document.querySelectorAll('#runScroll .qopt.on').length === mq.answer.length, '多选题支持多选高亮');
  window.confirmMulti();
  await wait(300);
  ok(window.ZKStore.getPractice('13005-sprint').rec[mq.id].ok === 1, `多选题全选对判对（答案 ${mq.answer}）`);

  // --- 填空题自评 ---
  window.startBank('13005-yati', '13005-yati.json');
  await wait(400);
  const fillIdx = QB().list.findIndex(x => x.type === 'fill');
  QB().idx = fillIdx;
  window.renderRun();
  await wait(200);
  ok(/先自己写/.test(text('#runScroll')), '填空题先让用户自己写');
  window.revealAns();
  await wait(200);
  ok(!!text('#runScroll .qans'), '点开后显示参考答案');
  window.judgeSelf(true);
  await wait(250);
  ok(window.ZKStore.getPractice('13005-yati').rec[QB().list[fillIdx].id].ok === 1, '自评判对后落库');

  console.log(`\n${fail ? '❌' : '✅'} 刷题冒烟测试：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
