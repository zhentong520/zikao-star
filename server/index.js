/**
 * 自考星 本地服务
 * 零外部依赖：原生 node:http + node:sqlite
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Crawler } = require('./crawler');
const ZKCalc = require('../shared/calc.js');   // 双端共用计算核心（进度/均分/学位）

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DB_PATH = process.env.ZK_DB || path.join(ROOT, 'data', 'zikao.db');
const PORT = parseInt(process.env.PORT || '5173', 10);
// 安全默认：只绑本机回环。服务无鉴权，绑 0.0.0.0 时同一 WiFi 下
// 任何设备都能读写你的成绩/笔记。需要手机访问时显式：
//   Windows (PowerShell):  $env:ZK_HOST='0.0.0.0'; npm start
//   macOS/Linux:           ZK_HOST=0.0.0.0 npm start
const HOST = process.env.ZK_HOST || process.env.HOST || '127.0.0.1';

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

/** 一次性取该 profile 全部成绩，按课程代码分组（供 shared/calc.js 纯函数使用）。
 *  限定当前 group_id：换专业后旧组课程的成绩不计入新考纲。 */
function scoreMapByCode(profileId) {
  const rows = db.prepare(`
    SELECT c.code AS code, s.score AS score, s.score_type AS score_type
    FROM score_record s
    JOIN user_course uc ON uc.id = s.user_course_id
    JOIN course c ON c.id = uc.course_id
    WHERE uc.profile_id=? AND c.group_id=(SELECT group_id FROM profile WHERE id=?)`).all(profileId, profileId);
  const map = {};
  for (const r of rows) {
    (map[r.code] = map[r.code] || []).push({ score: r.score, score_type: r.score_type });
  }
  return map;
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

/** 毕业进度 —— 算法委托 shared/calc.js（双端唯一真相），此处只做取数组装 */
function computeProgress(profileId) {
  const list = courseList(profileId);              // 必考（含论文行）
  const addOn = addOnCourses(profileId);
  const needAddOn = [...addOn.active];              // 需要加考的课程代码
  const addOnList = addOn.courses.filter(c => needAddOn.includes(c.code));
  const req = [...list, ...addOnList];

  const thesisRow = list.find(c => c.is_thesis);
  // 论文状态：有分用分；无分但手动标已通过则按 60 兜底（保持原行为）
  const thesisScore = thesisRow
    ? (bestScore(thesisRow.uc_id) ?? (thesisRow.status === '已通过' ? 60 : null))
    : null;

  return {
    ...ZKCalc.computeProgressCore({
      courses: req.filter(c => !c.is_thesis),
      scoresByCode: scoreMapByCode(profileId),
      thesisScore,
    }),
    addOnCount: addOnList.length,
  };
}

/** 五级制/文字成绩 → 数值（委托 shared/calc.js） */
const convertScore = (raw) => ZKCalc.convertScore(raw);

/** 学位均分 —— 算法委托 shared/calc.js 的 computeDegreeCore（华师教学〔2025〕9 号口径） */
function computeDegree(profileId) {
  const p = db.prepare('SELECT * FROM profile WHERE id=?').get(profileId);
  const rule = db.prepare(`SELECT * FROM degree_rule
    WHERE school_code=(SELECT school_code FROM major_group WHERE id=?) AND major_code=?
    ORDER BY apply_year DESC LIMIT 1`).get(p.group_id, '080901') || {};
  // 均分口径：必考 + 需加考课程（华师细则：含加考、选考课程及毕业论文成绩）
  const addOn = addOnCourses(profileId);
  const list = [...courseList(profileId), ...addOn.courses.filter(c => addOn.active.has(c.code))];
  const thesisRow = list.find(c => c.is_thesis);

  return {
    ...ZKCalc.computeDegreeCore({
      courses: list.filter(c => !c.is_thesis),
      scoresByCode: scoreMapByCode(profileId),
      minAvg: rule.min_avg_score || 70,
      thesisMinScore: rule.thesis_min_score ?? null,
      thesisScore: thesisRow ? bestScore(thesisRow.uc_id) : null,
    }),
    rule,
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
// 手动触发抓取的工作状态（Crawler 单例 + 防重入标志）
const crawlJob = { crawler: null, running: false };

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
    // 纯读：GET 不再做写操作（违反语义，且 SW 缓存该请求会把「已读」写进缓存层）
    return db.prepare('SELECT * FROM news WHERE id=?').get(parseInt(q.id, 10)) || null;
  },

  'POST /api/news/read': (q, body) => {
    const id = parseInt(body.id, 10);
    const r = db.prepare('UPDATE news SET is_read=1 WHERE id=?').run(id);
    return { ok: r.changes > 0 };
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
    // 复用单例：此前每次调用 new Crawler 开新 SQLite 连接且从不关闭；
    // running 标志防重入（重复点击时直接返回，不再叠加一轮全量抓取）
    if (!crawlJob.crawler) crawlJob.crawler = new Crawler(DB_PATH);
    if (crawlJob.running) return { ok: false, message: '抓取正在进行中，请稍候' };
    crawlJob.running = true;
    try {
      return await crawlJob.crawler.runOnce(true);
    } finally {
      crawlJob.running = false;
    }
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
      // ⚠️ 只清当前 profile 的数据。此前 DELETE FROM score_record 没有 WHERE，
      // 会清空全表（含其他 profile / 未来多用户场景），属灾难性误删。
      db.prepare(`DELETE FROM score_record WHERE user_course_id IN
        (SELECT uc.id FROM user_course uc WHERE uc.profile_id=?)`).run(p.id);
      db.prepare('DELETE FROM user_course WHERE profile_id=?').run(p.id);
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

  // CORS：默认同源访问（PC 浏览器 / 手机 PWA 加载的都是本服务页面），无需跨域放行。
  // 仅在显式 LAN 模式（ZK_HOST=0.0.0.0）时放开，方便手机调试工具跨域调用。
  if (HOST === '0.0.0.0' || HOST === '::') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  } else if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

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
      // 只返回 message，不返回 stack —— 避免向内网所有设备泄漏服务端实现细节
      console.error(`[API] ${key} 出错:`, e);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
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

// ============ 优雅停机 ============
// Ctrl+C 时先停接新请求、等在途请求完成，再关 SQLite（WAL 落盘），避免 db-wal 残留
function shutdown(signal) {
  console.log(`\n👋 收到 ${signal}，正在关闭…`);
  server.close(() => {
    try { db.close(); } catch { /* 已关闭 */ }
    process.exit(0);
  });
  // 兜底：5 秒内没退完就强退（长轮询/僵死连接）
  setTimeout(() => { try { db.close(); } catch {} process.exit(0); }, 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  ensureProfile();
  const lanVisible = HOST === '0.0.0.0' || HOST === '::';
  let lanHint = '';
  if (lanVisible) {
    const nets = require('os').networkInterfaces();
    const lan = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    lanHint = lan.map(ip => `   手机访问：http://${ip}:${PORT}   (同一 WiFi)`).join('\n');
  } else {
    lanHint = `   手机访问：已关闭（服务仅监听本机）\n   如需手机同 WiFi 访问：ZK_HOST=0.0.0.0 npm start`;
  }
  console.log(`
🌸 自考星 已启动
   本机访问：http://localhost:${PORT}
${lanHint}
   数据库：${DB_PATH}
`);
});

module.exports = { server, db, computeProgress, computeDegree, courseList, ensureProfile, courseDetail, bestScore, convertScore, addOnCourses };
