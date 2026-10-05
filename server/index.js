/**
 * 自考星 本地服务
 * 零外部依赖：原生 node:http + node:sqlite
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Crawler } = require('./crawler');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DB_PATH = process.env.ZK_DB || path.join(ROOT, 'data', 'zikao.db');
const PORT = parseInt(process.env.PORT || '5173', 10);
const HOST = process.env.HOST || '0.0.0.0';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!fs.existsSync(DB_PATH)) {
  console.log('⚠️  未找到数据库，正在初始化…');
  require('./seed').seed();
}
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

// ============ 计算核心：进度 / 均分 / 学位 ============
function ensureProfile() {
  let p = db.prepare('SELECT * FROM profile ORDER BY id LIMIT 1').get();
  if (!p) {
    const g = db.prepare("SELECT id FROM major_group WHERE school_code='10574' AND plan_version='2026' LIMIT 1").get();
    db.prepare(`INSERT INTO profile (nickname,avatar_emoji,province_code,city,group_id,prior_category,has_degree_target,plan_version)
      VALUES ('我','🌷','440000','广州市',?,'其他',1,'2026')`).run(g?.id || null);
    p = db.prepare('SELECT * FROM profile ORDER BY id LIMIT 1').get();
  }
  return p;
}

function courseList(profileId, includeAddOn = false) {
  return db.prepare(`
    SELECT c.id AS course_id, c.seq, c.code, c.name, c.credits, c.course_type, c.exam_mode,
           c.is_thesis, c.parent_code, c.sort_order,
           uc.id AS uc_id, uc.status, uc.is_selected, uc.planned_exam_date, uc.booked_exam_session,
           uc.note, uc.starred
    FROM course c
    LEFT JOIN user_course uc ON uc.course_id=c.id AND uc.profile_id=?
    WHERE c.group_id=(SELECT group_id FROM profile WHERE id=?)
      ${includeAddOn ? '' : "AND c.course_type='必考'"}
    ORDER BY c.sort_order ASC
  `).all(profileId, profileId);
}

/** 加考课（按前置学历判定） */
function addOnCourses(profileId) {
  const p = db.prepare('SELECT prior_category, group_id FROM profile WHERE id=?').get(profileId);
  const rule = db.prepare('SELECT * FROM add_on_rule WHERE group_id=? AND prior_category=?')
    .get(p.group_id, p.prior_category || '其他')
    || db.prepare("SELECT * FROM add_on_rule WHERE group_id=? AND prior_category='任何'").get(p.group_id);
  const list = courseList(profileId, true).filter(c => c.course_type === '加考');
  if (!rule || !rule.add_codes) return { rule, courses: list, active: new Set() };
  const active = new Set(rule.add_codes.split(',').map(s => s.trim()).filter(Boolean));
  return { rule, courses: list, active };
}

function bestScore(ucId) {
  if (!ucId) return null;
  const r = db.prepare(`SELECT MAX(score) s FROM score_record
    WHERE user_course_id=? AND score IS NOT NULL AND score_type!='免考'`).get(ucId);
  return r?.s ?? null;
}

/**
 * 有效状态推导 —— 状态的唯一真相来源。
 *
 * 背景：user_course.status 可能为 NULL（该科从未建过记录），
 * 且可能与成绩矛盾（例：某科已有及格成绩却仍标"已报名"）。
 * 因此规则是「成绩优先于手动状态」：
 *   1. 有及格成绩  → 已通过（不可手工降级，避免与均分计算冲突）
 *   2. 有未及格成绩 → 未通过（待补考）
 *   3. 无成绩      → 用手动状态；为空则「未开始」
 */
function effectiveStatus(row) {
  const s = row.bestScore !== undefined ? row.bestScore : bestScore(row.uc_id);
  if (s !== null && s !== undefined) return s >= 60 ? '已通过' : '未通过';
  return row.status || '未开始';
}

/** 毕业进度：已过学分 / 总学分（必考 + 需加考的课程） */
function computeProgress(profileId) {
  const list = courseList(profileId);              // 必考
  const addOn = addOnCourses(profileId);
  const needAddOn = [...addOn.active];              // 需要加考的课程代码
  const addOnList = addOn.courses.filter(c => needAddOn.includes(c.code));

  // 实践课与其笔试课合并展示但学分独立计算
  const req = [...list, ...addOnList];
  let earned = 0, total = 0, passedCount = 0, failCount = 0;
  for (const c of req) {
    if (c.is_thesis) continue;          // 论文不计学分
    total += c.credits;
    const s = bestScore(c.uc_id);
    if (s !== null && s >= 60) { earned += c.credits; passedCount++; }
    else if (s !== null) failCount++;
  }
  const thesisRow = list.find(c => c.is_thesis);
  const thesisDone = thesisRow ? (bestScore(thesisRow.uc_id) ?? (thesisRow.status === '已通过' ? 60 : null)) : null;
  const creditsTotal = total || 1;
  return {
    earned, total, passedCount, failCount,
    requiredCount: req.length,
    addOnCount: addOnList.length,
    percent: Math.round((earned / creditsTotal) * 1000) / 10,
    thesisDone: thesisDone !== null,
    thesisScore: thesisDone,
  };
}

/** 学位均分（加权）。规则来自各校细则：
 *  免考不计 · 补考及格按60 · 含加考/选考/论文 · 同科取最高 · 非百分制折算 */
function convertScore(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;
  const map = { 优秀: 95, 良好: 85, 中等: 75, 及格: 65, 满分: 100 };
  return map[raw] ?? (parseFloat(raw) || null);
}

function computeDegree(profileId) {
  const p = db.prepare('SELECT * FROM profile WHERE id=?').get(profileId);
  const rule = db.prepare(`SELECT * FROM degree_rule
    WHERE school_code=(SELECT school_code FROM major_group WHERE id=?) AND major_code=?
    ORDER BY apply_year DESC LIMIT 1`).get(p.group_id, '080901') || {};
  // 均分口径：必考 + 需加考课程（华师细则：含加考、选考课程及毕业论文成绩）
  const addOn = addOnCourses(profileId);
  const list = [...courseList(profileId), ...addOn.courses.filter(c => addOn.active.has(c.code))];

  // 逐科收集：已过科目用真实成绩，未过科目留空（后续按预测分计入）
  const courseItems = [];
  let failed = 0;
  for (const c of list) {
    if (c.is_thesis) continue;
    const rows = db.prepare(`SELECT score,score_type FROM score_record WHERE user_course_id=?`).all(c.uc_id || -1);
    const valid = rows.filter(r => r.score_type !== '免考' && r.score !== null)
      .map(r => convertScore(r.score))
      .filter(s => s !== null && s >= 60);
    const best = valid.length ? Math.max(...valid) : null;
    if (best !== null && best < 60) { failed++; continue; }
    // 补考及格按 60 计（华师细则）
    const isMakeup = rows.some(r => r.score_type === '补考');
    const use = best === null ? null : (isMakeup && best < 70 ? 60 : best);
    courseItems.push({ ...c, score: use, passed: use !== null });
  }

  const totalCredits = courseItems.reduce((s, c) => s + c.credits, 0);   // 分母：全部应考学分
  const passedItems = courseItems.filter(c => c.passed);
  const earnedSum = passedItems.reduce((s, c) => s + c.score * c.credits, 0);
  const earnedCredits = passedItems.reduce((s, c) => s + c.credits, 0);
  const credits = earnedCredits;                                   // 兼容旧字段名
  const sum = earnedSum;

  /**
   * 均分口径（华师教学〔2025〕9 号）：
   *   真实均分 = Σ(成绩×学分) / Σ(已过课程学分)
   *   —— 官方口径只算已过课程，不足 20 门时属于「阶段性均分」。
   *   预测均分 = Σ(成绩×学分 + 未过课程预测分×学分) / Σ(全部应考学分)
   *   —— 模拟器用这个，才能回答「剩下的课要考多少分才够」。
   */
  const avg = earnedCredits > 0 ? Math.round((earnedSum / earnedCredits) * 10) / 10 : null;
  const minAvg = rule.min_avg_score || 70;

  /** 预测均分：把未过课程按 assumed 分计入，分母为全部应考学分 */
  const predictAvg = (assumed = 70) => {
    if (totalCredits <= 0) return null;
    let s = earnedSum;
    for (const c of courseItems) if (!c.passed) s += assumed * c.credits;
    return Math.round((s / totalCredits) * 10) / 10;
  };

  // 模拟器：每个候选科目生成「该科考 v 分 → 预测均分」对照表
  const simTargets = courseItems
    .filter(c => c.credits > 0)
    .sort((a, b) => {
      if (a.passed !== b.passed) return a.passed ? 1 : -1;   // 未通过优先
      return b.credits - a.credits;                          // 学分大的提分效率高
    })
    .slice(0, 8)
    .map(c => {
      const table = [];
      for (let v = 0; v <= 100; v += 5) {
        // earnedSum 已含所有已过科目，故这里只处理「未过科目」：
        //   未过且非本门 → 按 70 分预估；本门 → 按 v 分
        // 若本门已过（重考提分），需先从 earnedSum 中扣掉旧分再加新分。
        let s = earnedSum - (c.passed ? c.score * c.credits : 0);
        for (const o of courseItems) {
          if (o.passed) continue;
          if (o.code === c.code) s += v * o.credits;
          else s += 70 * o.credits;
        }
        if (c.passed) s += v * c.credits;
        table.push({ score: v, avg: Math.round((s / totalCredits) * 10) / 10 });
      }
      return { code: c.code, name: c.name, credits: c.credits, score: c.score, passed: c.passed, table };
    });

  const thesisRule = list.find(c => c.is_thesis);
  const thesisScore = thesisRule ? bestScore(thesisRule.uc_id) : null;

  const items = [
    { key: 'avg', label: `课程平均分 ≥ ${minAvg} 分`, pass: avg !== null && avg >= minAvg,
      detail: avg === null ? '暂无成绩记录' : `当前 ${avg} 分（加权，${courseItems.filter(c=>c.passed).length} 门参与计算）${failed ? ` · ${failed} 门未通过不计入` : ''}` },
    { key: 'foreign', label: '学位外语成绩合格', pass: null,
      detail: '最省事路径：自考「英语(专升本)」13000 统考合格即可自动达标（本专业开设该科）' },
    { key: 'thesis', label: rule.thesis_min_score ? `毕业论文答辩 ≥ ${rule.thesis_min_score} 分` : '毕业论文合格',
      pass: thesisScore !== null && (!rule.thesis_min_score || thesisScore >= rule.thesis_min_score),
      detail: thesisScore !== null ? `当前 ${thesisScore} 分` : '2025-09 后毕业者适用，预计 2027-04 毕业需提前启动' },
    { key: 'graduate', label: '毕业证书已取得', pass: false,
      detail: '全部课程通过后可申请，距预计毕业还有约 6 个月' },
  ];
  const passedCount = items.filter(i => i.pass === true).length;
  const pendingCount = items.filter(i => i.pass === null).length;

  // 缺口测算（基于预测均分：未过课程按目标线计）
  let advice = null;
  const remain = courseItems.filter(c => !c.passed);
  if (remain.length === 0) {
    advice = `全部 ${courseItems.length} 门课程已通过，当前真实均分 ${avg} 分${avg >= minAvg ? '，已满足学位要求 ✓' : `，但未达 ${minAvg} 分线，需申请时复核`}。`;
  } else {
    // 让预测均分刚好达标所需的「剩余课程平均分」
    const needSum = minAvg * totalCredits;              // 目标加权总分
    const remainCredits = remain.reduce((s, c) => s + c.credits, 0);
    const needOnRemain = (needSum - earnedSum) / (remainCredits || 1);
    const p70 = predictAvg(70);
    if (avg !== null && avg >= minAvg) {
      advice = `当前真实均分 ${avg} 分已达标。但要注意：剩下 ${remain.length} 门（${remainCredits} 学分）还没考，` +
        `若全部按 70 分算，最终均分约 ${p70} 分${p70 >= minAvg ? '，仍安全 ✓' : `，会掉到 ${minAvg} 分以下 ⚠️，建议稳在 75 分以上`}。`;
    } else if (needOnRemain <= 60) {
      advice = `真实均分 ${avg ?? '—'} 分，还差 ${(minAvg - avg).toFixed(1)} 分。剩下 ${remain.length} 门（${remainCredits} 学分）只要平均考 ${needOnRemain.toFixed(1)} 分就能达标，压力不大。`;
    } else if (needOnRemain <= 100) {
      advice = `真实均分 ${avg ?? '—'} 分，还差 ${(minAvg - avg).toFixed(1)} 分。剩下 ${remain.length} 门（${remainCredits} 学分）需平均考 ${needOnRemain.toFixed(1)} 分才够线。` +
        (remain.some(c => c.credits >= 6) ? `建议重点抓高学分科目（${remain.filter(c=>c.credits>=6).map(c=>c.name).join('、')}），同样的提分在它们身上效率最高。` : '优先提分学分大的科目，同样努力效果更好。');
    } else {
      advice = `真实均分 ${avg ?? '—'} 分，还差 ${(minAvg - avg).toFixed(1)} 分。剩余学分不足以补齐，需要下轮重考已过科目中最低分的 1-2 门。`;
    }
  }

  return {
    avg, minAvg, items, passedCount, pendingCount, rule, advice,
    countedCredits: earnedCredits, totalCredits,
    passedCourses: passedItems.length, failedCourses: failed,
    predictAvg70: predictAvg(70),
    simTargets,
  };
}

/** 科目详情：资讯 TOP3 + 状态 + 成绩 */
function courseDetail(profileId, courseCode) {
  const c = db.prepare(`
    SELECT c.*, uc.id AS uc_id, uc.status, uc.planned_exam_date, uc.booked_exam_session, uc.note, uc.starred
    FROM course c LEFT JOIN user_course uc ON uc.course_id=c.id AND uc.profile_id=?
    WHERE c.code=? AND c.group_id=(SELECT group_id FROM profile WHERE id=?)
    LIMIT 1`).get(profileId, courseCode, profileId);
  if (!c) return null;

  const scores = db.prepare('SELECT * FROM score_record WHERE user_course_id=? ORDER BY exam_date DESC')
    .all(c.uc_id || -1);
  const best = bestScore(c.uc_id);

  // 状态同样走 effectiveStatus，保证详情页与列表页一致
  const status = effectiveStatus({ ...c, bestScore: best });

  // 科目资讯 TOP3：课程代码精确匹配 > 关键词匹配 > 兜底（时间/政策类）
  const kw = c.name.replace(/\(.*?\)/g, '').trim();
  const kw2 = kw.replace(/[（(].*?[）)]/g, '');
  const rows = db.prepare(`
    SELECT id,title,url,source_name,category,summary,published_at,relevance,matched_courses,change_flag,length(content) len
    FROM news WHERE is_hide=0
    ORDER BY (CASE
        WHEN ','||COALESCE(matched_courses,'')||',' LIKE '%,'||?||',%' THEN 0
        WHEN title LIKE '%'||?||'%' OR content LIKE '%'||?||'%' THEN 1
        WHEN category IN ('时间','政策','报名','考纲') THEN 2
        ELSE 3 END),
      ABS(julianday('now') - julianday(COALESCE(published_at, crawled_at))) ASC
    LIMIT 3`).all(c.code, kw, kw2);

  // 考试安排
  let exam = db.prepare(`SELECT * FROM exam_arrangement
    WHERE course_code=? ORDER BY exam_date DESC LIMIT 1`).get(c.code) || null;

  return {
    ...c,
    scores, bestScore: best,
    // status 覆盖掉数据库里的原始 NULL / 矛盾值
    status,
    rawStatus: c.status || null,
    pass: best !== null && best >= 60,
    news: rows,
    exam,
    credits: c.credits,
  };
}

// ============ 路由 ============
const routes = {
  'GET /api/bootstrap': () => {
    const p = ensureProfile();
    const g = db.prepare(`SELECT mg.*, s.name school_name, s.city FROM major_group mg
      JOIN school s ON s.code=mg.school_code WHERE mg.id=?`).get(p.group_id) || {};
    return {
      profile: p,
      group: g,
      progress: computeProgress(p.id),
      degree: computeDegree(p.id),
      stats: {
        newsTotal: db.prepare('SELECT COUNT(*) c FROM news').get().c,
        changePending: db.prepare('SELECT COUNT(*) c FROM change_record WHERE acknowledged_at IS NULL').get().c,
        sourceOk: db.prepare('SELECT COUNT(*) c FROM source WHERE enabled=1 AND fail_count=0').get().c,
        sourceTotal: db.prepare('SELECT COUNT(*) c FROM source WHERE enabled=1').get().c,
        lastCrawl: db.prepare("SELECT value FROM setting WHERE key='last_crawl_at'").get()?.value || '',
      },
    };
  },

  'GET /api/groups': () => db.prepare(`SELECT mg.*, s.name school_name, s.city, s.site_url
    FROM major_group mg JOIN school s ON s.code=mg.school_code
    WHERE mg.province_code='440000' ORDER BY mg.school_code`).all(),

  'GET /api/courses': () => {
    const p = ensureProfile();
    const main = courseList(p.id).map(c => {
      const best = bestScore(c.uc_id);
      return {
        ...c,
        bestScore: best,
        // 状态以成绩为准，杜绝「有及格成绩却显示未通过」这类矛盾
        status: effectiveStatus({ ...c, bestScore: best }),
        rawStatus: c.status || null,
        pass: best !== null && best >= 60,
        hasRecord: !!c.uc_id,
      };
    });
    const addOn = addOnCourses(p.id);
    return {
      courses: main,
      addOn: {
        rule: addOn.rule,
        active: [...addOn.active],
        courses: addOn.courses.map(c => {
          const best = bestScore(c.uc_id);
          return {
            ...c,
            required: addOn.active.has(c.code),
            bestScore: best,
            status: effectiveStatus({ ...c, bestScore: best }),
            rawStatus: c.status || null,
          };
        }),
      },
    };
  },

  'GET /api/course': (q) => {
    const p = ensureProfile();
    return courseDetail(p.id, q.code);
  },

  'GET /api/news': (q) => {
    const p = ensureProfile();
    const list = courseList(p.id);
    const codes = list.map(c => c.code);
    const where = [];
    const args = [];
    if (q.category && q.category !== '全部') { where.push('category=?'); args.push(q.category); }
    if (q.code) { where.push("(','||COALESCE(matched_courses,'')||',') LIKE '%,'||?||',%' OR title LIKE '%'||?||'%'"); args.push(q.code, q.code); }
    if (q.q) { where.push('(title LIKE ? OR content LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
    const sql = `SELECT id,title,url,source_name,category,summary,published_at,relevance,change_flag,is_read,is_starred,matched_courses,length(content) len
      FROM news WHERE is_hide=0 ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ORDER BY change_flag DESC, relevance DESC, COALESCE(published_at,crawled_at) DESC LIMIT ?`;
    args.push(parseInt(q.limit || '50', 10));
    return db.prepare(sql).all(...args);
  },

  'GET /api/news/detail': (q) => {
    const row = db.prepare('SELECT * FROM news WHERE id=?').get(parseInt(q.id, 10));
    if (!row) return null;
    db.prepare('UPDATE news SET is_read=1 WHERE id=?').run(row.id);
    return row;
  },

  'GET /api/changes': () => db.prepare(`SELECT * FROM change_record
    WHERE acknowledged_at IS NULL ORDER BY CASE risk_level WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, detected_at DESC`).all(),

  'POST /api/change/ack': (q, body) => {
    db.prepare("UPDATE change_record SET acknowledged_at=datetime('now','localtime') WHERE id=?")
      .run(parseInt(body.id, 10));
    return { ok: true };
  },

  'GET /api/degree': () => computeDegree(ensureProfile().id),

  'GET /api/thesis/directions': () => db.prepare(`SELECT * FROM thesis_direction
    WHERE major_code='080901' ORDER BY heat DESC`).all(),

  'GET /api/sources': () => db.prepare('SELECT * FROM source ORDER BY type, name').all(),

  'GET /api/crawl/log': () => db.prepare('SELECT * FROM crawl_log ORDER BY id DESC LIMIT 50').all(),

  'POST /api/crawl/run': async () => {
    const c = new Crawler(DB_PATH);
    const r = await c.runOnce(true);
    return r;
  },

  'POST /api/course/status': (q, body) => {
    const p = ensureProfile();
    const c = db.prepare(`SELECT c.id, c.name FROM course c WHERE c.code=? AND c.group_id=?
      `).get(body.code, p.group_id);
    if (!c) return { ok: false, msg: '课程不存在' };
    const exist = db.prepare('SELECT id FROM user_course WHERE profile_id=? AND course_id=?').get(p.id, c.id);
    if (exist) {
      db.prepare('UPDATE user_course SET status=?, planned_exam_date=?, note=?, starred=?, is_selected=? WHERE id=?')
        .run(body.status, body.planned_exam_date || null, body.note || null,
             body.starred ? 1 : 0, body.is_selected ? 1 : 0, exist.id);
    } else {
      db.prepare(`INSERT INTO user_course (profile_id,course_id,status,planned_exam_date,note,starred,is_selected)
        VALUES (?,?,?,?,?,?,?)`).run(p.id, c.id, body.status || '未开始',
        body.planned_exam_date || null, body.note || null, body.starred ? 1 : 0, body.is_selected ? 1 : 0);
    }
    return { ok: true, progress: computeProgress(p.id), degree: computeDegree(p.id) };
  },

  'POST /api/score/save': (q, body) => {
    const p = ensureProfile();
    const c = db.prepare('SELECT id FROM course WHERE code=? AND group_id=?').get(body.code, p.group_id);
    if (!c) return { ok: false, msg: '课程不存在' };
    let uc = db.prepare('SELECT id FROM user_course WHERE profile_id=? AND course_id=?').get(p.id, c.id);
    if (!uc) {
      db.prepare(`INSERT INTO user_course (profile_id,course_id,status) VALUES (?,?,'已考待出分')`).run(p.id, c.id);
      uc = db.prepare('SELECT id FROM user_course WHERE profile_id=? AND course_id=?').get(p.id, c.id);
    }
    const score = body.score === '' || body.score === null || body.score === undefined ? null : parseFloat(body.score);
    if (score !== null && (isNaN(score) || score < 0 || score > 100)) return { ok: false, msg: '分数需在 0-100 之间' };

    if (body.recordId) {
      db.prepare('UPDATE score_record SET score=?,exam_date=?,exam_session=?,score_type=?,remark=? WHERE id=? AND user_course_id=?')
        .run(score, body.exam_date || null, body.exam_session || null, body.score_type || '正常', body.remark || null,
             parseInt(body.recordId, 10), uc.id);
    } else {
      db.prepare(`INSERT INTO score_record (user_course_id,score,exam_date,exam_session,score_type,remark)
        VALUES (?,?,?,?,?,?)`).run(uc.id, score, body.exam_date || null,
        body.exam_session || null, body.score_type || '正常', body.remark || null);
    }
    // 自动流转状态
    const best = bestScore(uc.id);
    const newStatus = best === null ? '已考待出分' : (best >= 60 ? '已通过' : '未通过');
    db.prepare('UPDATE user_course SET status=? WHERE id=?').run(newStatus, uc.id);

    return {
      ok: true, bestScore: best, status: newStatus,
      progress: computeProgress(p.id), degree: computeDegree(p.id),
      message: best === null ? '已记录（未出分）'
        : (best >= 60 ? `已记录 ${best} 分 · 科目通过` : `已记录 ${best} 分 · 未及格，标记为待补考`),
    };
  },

  'POST /api/score/delete': (q, body) => {
    const p = ensureProfile();
    const c = db.prepare('SELECT id FROM course WHERE code=? AND group_id=?').get(body.code, p.group_id);
    if (!c) return { ok: false };
    const uc = db.prepare('SELECT id FROM user_course WHERE profile_id=? AND course_id=?').get(p.id, c.id);
    if (!uc) return { ok: false };
    db.prepare('DELETE FROM score_record WHERE id=? AND user_course_id=?').run(parseInt(body.recordId, 10), uc.id);
    const best = bestScore(uc.id);
    db.prepare('UPDATE user_course SET status=? WHERE id=?').run(best === null ? '备考中' : (best >= 60 ? '已通过' : '未通过'), uc.id);
    return { ok: true, progress: computeProgress(p.id), degree: computeDegree(p.id) };
  },

  'POST /api/profile': (q, body) => {
    const p = ensureProfile();
    if (body.group_id) db.prepare('UPDATE profile SET group_id=?,prior_category=?,city=?,expected_graduate_at=? WHERE id=?')
      .run(parseInt(body.group_id, 10), body.prior_category || p.prior_category, body.city || p.city,
           body.expected_graduate_at || p.expected_graduate_at, p.id);
    if (body.nickname) db.prepare('UPDATE profile SET nickname=?,avatar_emoji=? WHERE id=?')
      .run(body.nickname, body.avatar_emoji || p.avatar_emoji, p.id);
    if (body.reset) {
      db.prepare('DELETE FROM user_course WHERE profile_id=?').run(p.id);
      db.prepare('DELETE FROM score_record').run();
    }
    return routes['GET /api/bootstrap']();
  },

  'GET /api/calendar': (q) => {
    const p = ensureProfile();
    const list = courseList(p.id);
    const evts = [];
    for (const c of list) {
      const s = bestScore(c.uc_id);
      if (c.planned_exam_date) evts.push({
        date: c.planned_exam_date, type: 'exam', code: c.code, title: c.name,
        sub: `${c.credits} 学分 · ${c.exam_mode}`, status: c.status,
        passed: s !== null && s >= 60,
      });
    }
    // 考期基准日（广东 2026）
    const sessions = db.prepare('SELECT DISTINCT exam_date,session FROM exam_arrangement ORDER BY exam_date').all();
    for (const s of sessions) evts.push({ date: s.exam_date, type: 'exam', title: '广东自考开考', sub: s.session === 'AM' ? '上午场' : '下午场' });
    return evts.sort((a, b) => a.date.localeCompare(b.date));
  },
};

// ============ HTTP ============
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${u.pathname}`;

  // CORS（局域网内手机访问）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (routes[key]) {
    try {
      let body = {};
      if (req.method === 'POST') {
        body = await new Promise((resolve) => {
          let d = '';
          req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
          req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
        });
      }
      const q = Object.fromEntries(u.searchParams);
      const out = await routes[key](q, body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(out ?? null));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message, stack: e.stack }));
    }
  }

  // 静态文件
  let fp = path.join(WEB, u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, ''));
  if (!fp.startsWith(WEB)) { res.writeHead(403); return res.end('Forbidden'); }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(WEB, 'index.html');
  if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('Not Found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

server.listen(PORT, HOST, () => {
  ensureProfile();
  const nets = require('os').networkInterfaces();
  const lan = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log(`
🌸 自考星 已启动
   本机访问：http://localhost:${PORT}
${lan.map(ip => `   手机访问：http://${ip}:${PORT}   (同一 WiFi)`).join('\n')}
   数据库：${DB_PATH}
`);
});

module.exports = { server, db, computeProgress, computeDegree, courseList, ensureProfile, courseDetail, bestScore, convertScore, addOnCourses };
