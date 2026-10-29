/**
 * 自考星 · 纯函数计算核心（PC 端与手机端共用，双端唯一真相）
 *
 * 为什么要有这个文件：
 *   computeProgress / computeDegree / convertScore 此前在 server/index.js（SQL 版）
 *   和 shared/store.js（localStorage 版）各写一份，已经因双端不一致修过两次 bug
 *   （bestScore 语义、items 字段名），failedCourses 恒为 0 的 bug 也是两边同时存在。
 *   现在算法只此一份：输入是普通数组/对象，输出字段与两端旧版严格一致。
 *   PC 端查完库组装输入，手机端从 state 组装输入。
 *
 * 不依赖任何运行环境 API（无 window / 无 require / 无 DOM），可在 Node 与 WebView 直接运行。
 */
(function (root) {
  'use strict';

  /* ============ 五级制/文字成绩 → 数值 ============ */
  const CONVERT_MAP = { 优秀: 95, 良好: 85, 中等: 75, 及格: 65, 满分: 100 };

  function convertScore(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') return raw;
    return CONVERT_MAP[raw] ?? (parseFloat(raw) || null);
  }

  /**
   * 单科最高有效分（**含不及格**，免考不计）。
   * 及格线过滤由调用方（computeProgressCore/computeDegreeCore）负责 ——
   * 此前 store.js 误过滤 <60 导致双端状态推导不一致（录 55 分手机端显示已考待出分）。
   */
  function bestScoreOf(records) {
    const arr = records || [];
    const valid = arr
      .filter(r => r.score !== null && r.score !== undefined && r.score_type !== '免考')
      .map(r => convertScore(r.score))
      .filter(s => !isNaN(s));
    return valid.length ? Math.max(...valid) : null;
  }

  /* ============ 毕业进度 ============ */
  /**
   * @param {Array}  courses      应考课程（不含论文），[{code, credits, ...}]
   * @param {Object} scoresByCode { [code]: [{score, score_type}] }
   * @param {Number|null} thesisScore 论文最高分（null=未考）
   */
  function computeProgressCore({ courses, scoresByCode, thesisScore }) {
    const map = scoresByCode || {};
    let earned = 0, total = 0, passedCount = 0, failCount = 0;
    for (const c of courses) {
      total += c.credits;
      const s = bestScoreOf(map[c.code]);
      if (s !== null && s >= 60) { earned += c.credits; passedCount++; }
      else if (s !== null) failCount++;
    }
    return {
      earned, total, passedCount, failCount,
      requiredCount: courses.length + 1,        // + 毕业论文
      percent: total ? Math.round((earned / total) * 1000) / 10 : 0,
      thesisDone: thesisScore !== null && thesisScore !== undefined,
      thesisScore: thesisScore ?? null,
    };
  }

  /* ============ 学位均分 ============ */
  /**
   * 口径（华师教学〔2025〕9 号）：
   *   真实均分 = Σ(成绩×学分) / Σ(已过课程学分)，免考不计、补考及格按 60、同科取最高
   *   预测均分 = Σ(成绩×学分 + 未过×70) / Σ(全部应考学分)
   *
   * @param {Array}  courses      应考课程（不含论文），[{code, name, credits}]
   * @param {Object} scoresByCode { [code]: [{score, score_type}] }
   * @param {Number} minAvg       学位均分线（如 70）
   * @param {Number|null} thesisMinScore 论文最低分要求（null → 「毕业论文合格」）
   * @param {Number|null} thesisScore 论文最高分
   */
  function computeDegreeCore({ courses, scoresByCode, minAvg, thesisMinScore, thesisScore }) {
    const map = scoresByCode || {};
    minAvg = minAvg || 70;

    // 逐科收集：已过用真实成绩，未过留空（预测均分按 assumed 计入）
    const items = [];
    let failedCount = 0;
    for (const c of courses) {
      const records = map[c.code] || [];
      // 先取最高有效分（不过滤及格线），才能识别「全部不及格」的科目；
      // 此前两端都预过滤 s>=60，导致 failedCourses 分支永远不可达（恒为 0）
      const allValid = records
        .filter(r => r.score_type !== '免考' && r.score !== null && r.score !== undefined)
        .map(r => convertScore(r.score))
        .filter(s => s !== null);
      const best = allValid.length ? Math.max(...allValid) : null;
      if (best !== null && best < 60) { failedCount++; continue; }
      const isMakeup = records.some(r => r.score_type === '补考');
      const use = best === null ? null : (isMakeup && best < 70 ? 60 : best);
      items.push({ code: c.code, name: c.name, credits: c.credits, score: use, passed: use !== null });
    }

    const totalCredits = items.reduce((s, c) => s + c.credits, 0);
    const passedItems = items.filter(c => c.passed);
    const earnedSum = passedItems.reduce((s, c) => s + c.score * c.credits, 0);
    const earnedCredits = passedItems.reduce((s, c) => s + c.credits, 0);
    const avg = earnedCredits > 0 ? Math.round((earnedSum / earnedCredits) * 10) / 10 : null;

    /** 预测均分：未过课程按 assumed 分计入，分母为全部应考学分 */
    const predict = (assumed) => {
      if (!totalCredits) return null;
      let s = earnedSum;
      for (const c of items) if (!c.passed) s += assumed * c.credits;
      return Math.round((s / totalCredits) * 10) / 10;
    };

    // 模拟器：每个候选科目「该科考 v 分 → 预测均分」对照表（未过优先，学分大优先）
    const simTargets = items.filter(c => c.credits > 0)
      .sort((a, b) => (a.passed !== b.passed) ? (a.passed ? 1 : -1) : (b.credits - a.credits))
      .slice(0, 8)
      .map(c => {
        const table = [];
        for (let v = 0; v <= 100; v += 5) {
          let s = earnedSum - (c.passed ? c.score * c.credits : 0);
          for (const o of items) {
            if (o.passed) continue;
            s += (o.code === c.code ? v : 70) * o.credits;
          }
          if (c.passed) s += v * c.credits;
          table.push({ score: v, avg: Math.round((s / totalCredits) * 10) / 10 });
        }
        return { code: c.code, name: c.name, credits: c.credits, score: c.score, passed: c.passed, table };
      });

    // 提分建议（基于预测均分口径）
    const remain = items.filter(c => !c.passed);
    const p70 = predict(70);
    let advice;
    if (!remain.length) {
      advice = `全部 ${items.length} 门课程已通过，真实均分 ${avg} 分${avg >= minAvg ? '，已满足学位要求 ✓' : `，未达 ${minAvg} 分线，需申请时复核`}。`;
    } else {
      const remainCredits = remain.reduce((s, c) => s + c.credits, 0);
      const needOnRemain = (minAvg * totalCredits - earnedSum) / (remainCredits || 1);
      if (avg !== null && avg >= minAvg) {
        advice = `真实均分 ${avg} 分已达标。但剩下 ${remain.length} 门（${remainCredits} 学分）还没考，若全部按 70 分算最终均分约 ${p70} 分${p70 >= minAvg ? '，仍安全 ✓' : `，会掉到 ${minAvg} 分以下 ⚠️，建议稳在 75 分以上`}。`;
      } else if (needOnRemain <= 60) {
        advice = `真实均分 ${avg ?? '—'} 分，还差 ${(minAvg - avg).toFixed(1)} 分。剩下 ${remain.length} 门（${remainCredits} 学分）平均考 ${needOnRemain.toFixed(1)} 分即可达标，压力不大。`;
      } else if (needOnRemain <= 100) {
        const big = remain.filter(c => c.credits >= 6).map(c => c.name);
        advice = `真实均分 ${avg ?? '—'} 分，还差 ${(minAvg - avg).toFixed(1)} 分。剩下 ${remain.length} 门（${remainCredits} 学分）需平均考 ${needOnRemain.toFixed(1)} 分才够线。` +
          (big.length ? `建议重点抓高学分科目（${big.join('、')}），同样提分效率最高。` : '优先提分学分大的科目。');
      } else {
        advice = `真实均分 ${avg ?? '—'} 分，还差 ${(minAvg - avg).toFixed(1)} 分。剩余学分不足以补齐，需下轮重考已过科目中最低分的 1-2 门。`;
      }
    }

    // 学位条件清单（4 项；外语项文案含本专业数据，扩专业时改为参数传入）
    const conditions = [
      { key: 'avg', label: `课程平均分 ≥ ${minAvg} 分`, pass: avg !== null && avg >= minAvg,
        detail: avg === null ? '暂无成绩记录' : `当前 ${avg} 分（加权，${passedItems.length} 门参与计算）${failedCount ? ` · ${failedCount} 门未通过不计入` : ''}` },
      { key: 'foreign', label: '学位外语成绩合格', pass: null,
        detail: '最省事路径：自考「英语(专升本)」13000 统考合格即可自动达标（本专业开设该科）' },
      { key: 'thesis', label: thesisMinScore != null ? `毕业论文答辩 ≥ ${thesisMinScore} 分` : '毕业论文合格',
        pass: thesisScore !== null && thesisScore !== undefined && (thesisMinScore == null || thesisScore >= thesisMinScore),
        detail: (thesisScore !== null && thesisScore !== undefined) ? `当前 ${thesisScore} 分` : '2025-09 后毕业者适用，需提前启动' },
      { key: 'graduate', label: '毕业证书已取得', pass: false, detail: '全部课程通过后可申请' },
    ];

    return {
      avg, minAvg,
      countedCredits: earnedCredits, totalCredits,
      passedCourses: passedItems.length, failedCourses: failedCount,
      predictAvg70: p70, simTargets, advice,
      items: conditions,
      passedCount: conditions.filter(c => c.pass === true).length,
      pendingCount: conditions.filter(c => c.pass === null).length,
    };
  }

  const ZKCalc = { convertScore, bestScoreOf, computeProgressCore, computeDegreeCore };

  /* 双端导出：Node 走 module.exports，WebView 挂 globalThis.ZKCalc */
  if (typeof module !== 'undefined' && module.exports) module.exports = ZKCalc;
  root.ZKCalc = ZKCalc;
})(typeof window !== 'undefined' ? window : globalThis);
