/**
 * computeDegree 学位均分算法单测（node:test，Node 22+）
 *
 * 覆盖最易错的口径（来自华师《学士学位授予工作细则》教学〔2025〕9 号）：
 *   1. 加权均分 = Σ(成绩×学分) / Σ(已过课程学分)
 *   2. 免考不计入
 *   3. 补考及格且 <70 → 按 60 计；补考 ≥70 → 按实际分计
 *   4. 同科取最高分
 *   5. 不及格不计入分母，计入 failedCourses
 *   6. 预测均分 = (已过加权总分 + 未过×70) / 全部应考学分
 *   7. 模拟器：已过科目按 v=原分时结果应回到 predictAvg70（守恒校验）
 *
 * 用法：npm run test:degree   （或 node --test tests/degree.test.js）
 */
const path = require('path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// ---- WebView 环境模拟（store.js 面向浏览器编写） ----
const mem = {};
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; },
};
global.window = global;
global.navigator = { userAgent: 'test' };
global.indexedDB = undefined;
global.TextDecoder = require('util').TextDecoder;

require(path.join(__dirname, '..', 'shared', 'rules.js'));
require(path.join(__dirname, '..', 'shared', 'calc.js'));
require(path.join(__dirname, '..', 'shared', 'store.js'));
const S = global.ZKStore;
const Calc = global.ZKCalc;

beforeEach(() => {
  // 注意：loadState 有 _state 内存缓存，仅 removeItem 不会重读，
  // 必须走 resetAll（清 LS + 置空 _state）才能真正回到默认态
  S.resetAll();
  S.loadState();
});

const round1 = x => Math.round(x * 10) / 10;

test('无成绩时 avg=null、学分计数为 0', () => {
  const d = S.computeDegree();
  assert.strictEqual(d.avg, null);
  assert.strictEqual(d.countedCredits, 0);
  assert.strictEqual(d.passedCourses, 0);
});

test('单科：86 分 3 学分 → avg=86', () => {
  S.saveScore('15040', { score: 86, score_type: '正常' });
  const d = S.computeDegree();
  assert.strictEqual(d.avg, 86);
  assert.strictEqual(d.countedCredits, 3);
});

test('加权均分：86×3 + 81×10 → (258+810)/13 ≈ 82.2', () => {
  S.saveScore('15040', { score: 86, score_type: '正常' });  // 3 学分
  S.saveScore('00023', { score: 81, score_type: '正常' });  // 10 学分
  const d = S.computeDegree();
  assert.strictEqual(d.avg, round1(1068 / 13));
});

test('免考不计入均分', () => {
  S.saveScore('15040', { score: 86, score_type: '正常' });
  S.saveScore('00023', { score: 90, score_type: '免考' });
  const d = S.computeDegree();
  assert.strictEqual(d.avg, 86);                    // 免考的 90 分不进计算
  assert.strictEqual(d.countedCredits, 3);          // 分母也只有已过的 3 学分
});

test('补考及格且 <70 → 按 60 计（华师细则）', () => {
  S.saveScore('13009', { score: 55, score_type: '补考' });
  S.saveScore('13009', { score: 68, score_type: '补考' });
  S.saveScore('15040', { score: 86, score_type: '正常' });
  const d = S.computeDegree();
  // 13009 补考最高 68 → 记 60；15040 记 86
  assert.strictEqual(d.avg, round1((86 * 3 + 60 * 4) / 7));
});

test('补考 ≥70 → 按实际分计', () => {
  S.saveScore('13009', { score: 60, score_type: '补考' });
  S.saveScore('13009', { score: 75, score_type: '补考' });
  S.saveScore('15040', { score: 86, score_type: '正常' });
  const d = S.computeDegree();
  assert.strictEqual(d.avg, round1((86 * 3 + 75 * 4) / 7));
});

test('同科取最高分（首考 62、二考 88 → 88）', () => {
  S.saveScore('15040', { score: 62, score_type: '正常' });
  S.saveScore('15040', { score: 88, score_type: '正常' });
  const d = S.computeDegree();
  assert.strictEqual(d.avg, 88);
});

test('不及格不计入分母，计入 failedCourses', () => {
  S.saveScore('15040', { score: 86, score_type: '正常' });
  S.saveScore('00023', { score: 55, score_type: '正常' });
  const d = S.computeDegree();
  assert.strictEqual(d.avg, 86);
  assert.strictEqual(d.failedCourses, 1);
  assert.strictEqual(d.passedCourses, 1);
});

test('五级制换算：优秀=95、良好=85、中等=75、及格=65、满分=100', () => {
  const cases = { '优秀': 95, '良好': 85, '中等': 75, '及格': 65, '满分': 100 };
  for (const [raw, num] of Object.entries(cases)) {
    assert.strictEqual(S.convertScore(raw), num, `${raw} → ${num}`);
  }
  assert.strictEqual(S.convertScore('88'), 88);
  assert.strictEqual(S.convertScore(null), null);
});

test('预测均分：86×3 已过 + 其余按 70 预估', () => {
  S.saveScore('15040', { score: 86, score_type: '正常' }); // 3 学分已过
  const d = S.computeDegree();
  // totalCredits = 全部应考学分（必考，不含论文）
  const list = S.getCreditsCourses();
  const total = list.reduce((s, c) => s + c.credits, 0);
  const remain = list.filter(c => c.code !== '15040').reduce((s, c) => s + c.credits, 0);
  const expect = round1((86 * 3 + 70 * remain) / total);
  assert.strictEqual(d.totalCredits, total);
  assert.strictEqual(d.predictAvg70, expect);
});

test('全部通过时 predictAvg70 === avg', () => {
  for (const c of S.getCreditsCourses()) {
    S.saveScore(c.code, { score: 78, score_type: '正常' });
  }
  const d = S.computeDegree();
  assert.strictEqual(d.avg, 78);
  assert.strictEqual(d.predictAvg70, 78);
  assert.strictEqual(d.passedCourses, S.getCreditsCourses().length);
});

test('模拟器守恒：已过科目代入 v=原分 → 回到 predictAvg70', () => {
  S.saveScore('15040', { score: 86, score_type: '正常' });
  S.saveScore('00023', { score: 66, score_type: '正常' });
  const d = S.computeDegree();
  for (const t of d.simTargets.filter(t => t.passed)) {
    const row = t.table.find(r => r.score === t.score);
    assert.ok(row, `科目 ${t.code} 缺 v=${t.score} 行`);
    assert.strictEqual(row.avg, d.predictAvg70, `${t.code} 在 v=原分 时应守恒`);
  }
});

test('模拟器未过科目 v=70 → predictAvg70', () => {
  S.saveScore('15040', { score: 86, score_type: '正常' });
  const d = S.computeDegree();
  for (const t of d.simTargets.filter(t => !t.passed)) {
    const row = t.table.find(r => r.score === 70);
    assert.ok(row, `科目 ${t.code} 缺 v=70 行`);
    assert.strictEqual(row.avg, d.predictAvg70);
  }
});

test('学位条件清单结构完整（items 4 项 / passedCount / pendingCount）', () => {
  const d = S.computeDegree();
  assert.strictEqual(d.items.length, 4);
  assert.strictEqual(d.passedCount, d.items.filter(i => i.pass === true).length);
  assert.strictEqual(d.pendingCount, d.items.filter(i => i.pass === null).length);
  assert.ok(typeof d.advice === 'string' && d.advice.length > 10);
  assert.strictEqual(d.minAvg, S.SYLLABUS.degreeRule.min_avg_score);
});

test('双端字段对齐：移动端必须提供 PC 端 renderDegree 全部字段', () => {
  const d = S.computeDegree();
  const FIELDS = ['avg', 'minAvg', 'items', 'passedCount', 'pendingCount', 'rule', 'advice',
    'countedCredits', 'totalCredits', 'passedCourses', 'failedCourses', 'predictAvg70', 'simTargets'];
  const missing = FIELDS.filter(f => !(f in d));
  assert.deepStrictEqual(missing, [], `缺少 PC 端对齐字段: ${missing.join(',')}`);
});
