/**
 * 自考星 · 手机端数据层（WebView 内运行，零原生依赖）
 *
 * 为什么用 localStorage + IndexedDB 而不是 SQLite 插件：
 *  1. 零原生插件 → 打 APK 不会因插件版本冲突失败，成功率最高
 *  2. 数据量完全够用：考纲 100 门内、成绩几百条、资讯缓存几百条
 *  3. localStorage 存结构化小数据，IndexedDB 存资讯正文（大文本）
 *
 * 数据与 PC 端 schema 对齐，因此导出/导入能互通。
 */

const LS_KEY = 'zikao_v1';
const LS_VERSION = 1;

/**
 * 版本化迁移钩子表：key = 「从哪个版本迁出」，值为迁移函数。
 * 此前导出文件带 _v:1 却没有迁移代码 —— state 结构一变，老用户的
 * localStorage 会被浅合并静默丢字段。结构变更时在此登记，例如升到 2：
 *   2: (s) => { s.practice = s.practice || {}; delete s.legacyX; s._v = 2; return s; }
 */
const MIGRATIONS = {};

function migrate(state) {
  let v = state._v || 1;
  while (MIGRATIONS[v]) {
    state = MIGRATIONS[v](state) || state;
    v = state._v || (v + 1);
  }
  state._v = LS_VERSION;
  return state;
}
const DB_NAME = 'zikao_news';
const DB_STORE = 'news';

const DEFAULT_STATE = {
  profile: {
    nickname: '我', avatar_emoji: '🌷',
    province_code: '440000', city: '广州市',
    group_id: 1, prior_category: '其他',
    has_degree_target: 1, plan_version: '2026',
  },
  // user_course: { [courseCode]: {status, planned_exam_date, note, starred, is_selected} }
  userCourse: {},
  // score_record: { [courseCode]: [{score, exam_date, exam_session, score_type, remark}] }
  scoreRecords: {},
  // sourceLog: { [sourceKey]: ISO时间 }  用于自适应提频
  sourceLog: {},
  settings: { autoCrawl: true, lastCrawlAt: '', crawlMultiplier: 1 },
  // favDirections: 收藏的论文方向标题
  favDirections: [],
  // practice: 刷题记录 { [bankId]: { rec: { [qid]: {c, ok, ts} }, last: 上次做到第几题 } }
  practice: {},
};

/* ============ 状态读写 ============ */
let _state = null;

function loadState() {
  if (_state) return _state;
  try {
    const raw = localStorage.getItem(LS_KEY);
    _state = raw ? migrate({ ...DEFAULT_STATE, ...JSON.parse(raw) })
                 : migrate(JSON.parse(JSON.stringify(DEFAULT_STATE)));
    _state.profile = { ...DEFAULT_STATE.profile, ...(_state.profile || {}) };
    _state.userCourse = _state.userCourse || {};
    _state.scoreRecords = _state.scoreRecords || {};
    _state.practice = _state.practice || {};
    _state.settings = { ...DEFAULT_STATE.settings, ...(_state.settings || {}) };
  } catch (e) {
    console.warn('状态读取失败，重置', e);
    _state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  return _state;
}
function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(loadState())); }
  catch (e) { console.warn('状态保存失败', e); }
}

/* ============ 考纲（只读，内置） ============ */
/* 数据来源：广东省教育考试院 2026 年专业考试计划 + 各主考院校官网
   核验时间 2026-10-01。注意：数据只读，不随用户操作变化。 */
const SYLLABUS = {
  groups: [
    {
      id: 1, school_code: '10574', school_name: '华南师范大学', city: '广州市',
      major_code: '080901', major_name: '计算机科学与技术', level: '专升本',
      group_name: '计算机科学与技术（华南师范大学课程组）',
      degree_available: 1, plan_version: '2026', total_credits: 75, required_count: 21,
      verified_at: '2026-10-01',
    },
    {
      id: 2, school_code: '10590', school_name: '深圳大学', city: '深圳市',
      major_code: '080901', major_name: '计算机科学与技术', level: '专升本',
      group_name: '计算机科学与技术（深圳大学课程组）',
      degree_available: 1, plan_version: '2026', total_credits: 75, required_count: 21,
      verified_at: '2026-10-01',
    },
  ],
  courses: [
    { code: '15040', name: '习近平新时代中国特色社会主义思想概论', credits: 3, type: '必考', mode: '笔试' },
    { code: '15043', name: '中国近现代史纲要', credits: 3, type: '必考', mode: '笔试' },
    { code: '15044', name: '马克思主义基本原理', credits: 3, type: '必考', mode: '笔试' },
    { code: '00023', name: '高等数学(工本)', credits: 10, type: '必考', mode: '笔试' },
    { code: '02324', name: '离散数学', credits: 4, type: '必考', mode: '笔试' },
    { code: '13000', name: '英语(专升本)', credits: 7, type: '必考', mode: '笔试' },
    { code: '13003', name: '数据结构与算法', credits: 4, type: '必考', mode: '笔试' },
    { code: '13004', name: '数据结构与算法(实践)', credits: 2, type: '必考', mode: '实践', parent: '13003' },
    { code: '13013', name: '高级语言程序设计', credits: 4, type: '必考', mode: '笔试' },
    { code: '13014', name: '高级语言程序设计(实践)', credits: 2, type: '必考', mode: '实践', parent: '13013' },
    { code: '13015', name: '计算机系统原理', credits: 4, type: '必考', mode: '笔试' },
    { code: '13180', name: '操作系统', credits: 4, type: '必考', mode: '笔试' },
    { code: '03344', name: '信息与网络安全管理', credits: 3, type: '必考', mode: '笔试' },
    { code: '03345', name: '信息与网络安全管理(实践)', credits: 2, type: '必考', mode: '实践', parent: '03344' },
    { code: '08074', name: '计算机高级程序设计', credits: 3, type: '必考', mode: '笔试' },
    { code: '08075', name: '计算机高级程序设计(实践)', credits: 2, type: '必考', mode: '实践', parent: '08074' },
    { code: '13005', name: '软件工程', credits: 3, type: '必考', mode: '笔试' },
    { code: '13006', name: '软件工程(实践)', credits: 2, type: '必考', mode: '实践', parent: '13005' },
    { code: '13009', name: '数据库原理与技术', credits: 4, type: '必考', mode: '笔试' },
    { code: '13011', name: '人工智能与大数据', credits: 6, type: '必考', mode: '笔试' },
    { code: '11689', name: '计算机科学与技术(本科)毕业论文', credits: 0, type: '必考', mode: '实践', is_thesis: 1 },
  ],
  addOn: [
    { code: '02318', name: '计算机组成原理', credits: 4, mode: '笔试', for: ['电子电工信息类', '工科类', '其他'] },
    { code: '00342', name: '高级语言程序设计(一)', credits: 3, mode: '笔试', for: ['工科类'] },
    { code: '00343', name: '高级语言程序设计(一)(实践)', credits: 1, mode: '实践', for: ['工科类'] },
    { code: '04730', name: '电子技术基础(三)', credits: 5, mode: '笔试', for: ['其他'] },
    { code: '04731', name: '电子技术基础(三)(实践)', credits: 2, mode: '实践', for: ['其他'] },
    { code: '00024', name: '普通逻辑', credits: 4, mode: '笔试', for: ['港澳台'] },
    { code: '05679', name: '宪法学', credits: 4, mode: '笔试', for: ['港澳台'] },
  ],
  addOnRules: {
    '计算机类': { desc: '计算机类（或原计算机及应用）专科毕业生可直接报考本专业，无需加考', codes: [] },
    '电子电工信息类': { desc: '电子电工信息类非本专业专科及以上，须加考 1 门（201）', codes: ['02318'] },
    '工科类': { desc: '工科类非电子电工信息类专科及以上，须加考 2 门（201、202）', codes: ['02318', '00342', '00343'] },
    '其他': { desc: '其他专业专科及以上，须加考 2 门（201、203）', codes: ['02318', '04730', '04731'] },
    '港澳台': { desc: '港澳台考生可不考思政两门，但须加考 231、232', codes: ['00024', '05679'] },
  },
  degreeRule: {
    min_avg_score: 70, thesis_min_score: 70, apply_window_months: 6,
    source: '华南师范大学《学士学位授予工作细则》（教学〔2025〕9 号）',
    foreignOptions: [
      { name: '自考英语(专升本)/英语(二) 统考合格', note: '本专业开设 13000，最省事', recommend: true },
      { name: '全国大学英语四级(或六级) ≥425分', note: '非英语类专业' },
      { name: '全国英语等级考试(PETS)三级 笔试合格', note: '非英语类专业' },
      { name: '广东省成人高等教育学士学位外国语水平统一考试 合格', note: '' },
      { name: '网络教育公共基础课《大学英语》B/C ≥80分', note: '' },
      { name: '华师自行组织的学位外语水平考试 合格', note: '' },
    ],
    note: '2025年9月之后获颁毕业证书者，毕业论文须答辩且总评≥70分。均分计算：免考不计、补考按60计、含加考和论文、同科取最高分。',
  },
  thesisDirections: [
    { title: '基于大语言模型的自适应学习路径推荐系统设计与实现', tags: 'AI应用,教育技术', difficulty: 5, heat: 298 },
    { title: '面向中小企业的数据中台架构设计与性能优化实践', tags: '系统架构,工程实践', difficulty: 4, heat: 176 },
    { title: '基于零信任架构的高校网络安全防护体系研究', tags: '网络安全,理论', difficulty: 3, heat: 132 },
    { title: '基于协同过滤算法的个性化学习资源推荐系统实现', tags: '算法,教育技术', difficulty: 4, heat: 165 },
    { title: '基于Spring Cloud的微服务架构在企业业务系统中的落地研究', tags: '微服务,工程实践', difficulty: 4, heat: 188 },
    { title: '基于知识图谱的智能问答系统设计与实现', tags: 'AI应用,知识图谱', difficulty: 5, heat: 302 },
    { title: '基于强化学习的智能仓储路径规划算法研究', tags: '算法,优化', difficulty: 5, heat: 127 },
    { title: '基于PyTorch的图像风格迁移模型训练与应用', tags: 'AI应用,计算机视觉', difficulty: 4, heat: 171 },
    { title: '面向工业质检的轻量化目标检测模型设计与部署', tags: 'AI应用,计算机视觉', difficulty: 5, heat: 213 },
    { title: '基于区块链的电子病历数据共享与隐私保护方案研究', tags: '区块链,医疗', difficulty: 5, heat: 156 },
    { title: '基于Flutter的跨平台移动应用性能优化研究', tags: '移动开发,性能优化', difficulty: 3, heat: 154 },
    { title: '基于自然语言处理的法律文书智能辅助审校系统', tags: 'NLP,法律科技', difficulty: 5, heat: 197 },
  ],
  sources: [
    { key: 'gd_eea_notice', name: '广东省教育考试院-通知公告', url: 'https://eea.gd.gov.cn/ptgk/index.html', type: '官方', category: '政策', interval_min: 60 },
    { key: 'gd_eea_tzgg', name: '广东省教育考试院-通知公告(移动版)', url: 'https://eea.gd.gov.cn/tzgg/mindex.html', type: '官方', category: '政策', interval_min: 90 },
    { key: 'gd_5184_zk', name: '广东考试服务网-自考地级市', url: 'https://5184.com/h-nr--0_31_21.html', type: '聚合', category: '报名', interval_min: 120 },
    // RSSHub 自部署实例（阿里云深圳 ECS）：标准 RSS、社区维护路由，站点改版零成本
    // type:'rss' → crawler-web.js 走 crawlRSS 解析分支
    // pcOnly:true → HTTP 源在 HTTPS WebView（APK androidScheme=https）会被
    // mixed content 策略拦截，手机端抓取时自动跳过（此前表现为静默失败）
    { key: 'rsshub_eea_kszs', name: '考试院RSS-考试招生', url: 'http://47.112.10.43:1200/gov/gd/eea/kszs', type: 'rss', category: '政策', interval_min: 60, pcOnly: true },
    { key: 'rsshub_eea_ywdt', name: '考试院RSS-要闻动态', url: 'http://47.112.10.43:1200/gov/gd/eea/ywdt', type: 'rss', category: '政策', interval_min: 120, pcOnly: true },
    { key: 'gd_eea_home', name: '广东省教育考试院-首页要闻', url: 'https://eea.gd.gov.cn/', type: '官方', category: '政策', interval_min: 120 },
    { key: 'scnu_jky', name: '华师教育科学学院-通知公告', url: 'http://jky.scnu.edu.cn/index/tzgg.htm', type: '院校', category: '学位', interval_min: 120 },
    { key: 'szu_cce', name: '深大继续教育学院', url: 'https://cce.szu.edu.cn/', type: '院校', category: '学位', interval_min: 120 },
    { key: 'szu_major', name: '深大-计算机科学与技术专业介绍', url: 'https://cce.szu.edu.cn/info/1035/6202.htm', type: '院校', category: '考纲', interval_min: 720 },
    { key: 'gzzk_cc', name: '广州招考网-自考', url: 'http://www.gzzk.cn/zikao/', type: '资讯', category: '时间', interval_min: 90 },
    { key: 'sz_zikao', name: '深圳自考网', url: 'http://www.szzikao.com/', type: '资讯', category: '时间', interval_min: 90 },
    { key: 'gkdd_080901', name: '自考专业计划-080901', url: 'https://www.zikaoben.cn/archives/1268.html', type: '资讯', category: '考纲', interval_min: 360 },
    { key: 'gdszkw_080901', name: '广东自考网-开考安排', url: 'http://www.gdszkw.com/', type: '资讯', category: '时间', interval_min: 120 },
  ],
};

/* ============ IndexedDB（资讯正文） ============ */
let _db = null;
function openNewsDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('无 IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE, { keyPath: 'hash' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}
async function idbAll() {
  try {
    const d = await openNewsDB();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(DB_STORE, 'readonly');
      const rq = tx.objectStore(DB_STORE).getAll();
      rq.onsuccess = () => resolve(rq.result || []);
      rq.onerror = () => reject(rq.error);
    });
  } catch (e) { return []; }
}
async function idbPut(records) {
  try {
    const d = await openNewsDB();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(DB_STORE, 'readwrite');
      const st = tx.objectStore(DB_STORE);
      records.forEach(r => st.put(r));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { return false; }
}
async function idbClear() {
  try {
    const d = await openNewsDB();
    return await new Promise(resolve => {
      const tx = d.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { return false; }
}

/**
 * 资讯本地留存上限：只保留最新 max 条（默认 100），防止 IndexedDB 无限膨胀。
 * 排序依据 crawled_at（抓取时间，必填）优先、published_at 兜底。
 * 无 IndexedDB（autotest/老内核）时优雅返回 false。
 */
async function pruneNews(max = 100) {
  try {
    const all = await idbAll();
    if (!all.length || all.length <= max) return false;
    const sorted = [...all].sort((a, b) =>
      String(b.crawled_at || '').localeCompare(String(a.crawled_at || '')) ||
      String(b.published_at || '').localeCompare(String(a.published_at || '')));
    await idbClear();
    await idbPut(sorted.slice(0, max));
    return all.length - max;
  } catch (e) { return false; }
}

/* ============ 业务查询 ============ */
function getProfile() { return loadState().profile; }
function getGroup() {
  const gid = getProfile().group_id;
  return SYLLABUS.groups.find(g => g.id === gid) || SYLLABUS.groups[0];
}
function getRequiredAddOn() {
  const cat = getProfile().prior_category || '其他';
  const rule = SYLLABUS.addOnRules[cat] || SYLLABUS.addOnRules['其他'];
  return SYLLABUS.addOn.filter(c => rule.codes.includes(c.code));
}
function getAddOnRule() {
  const cat = getProfile().prior_category || '其他';
  return { cat, ...(SYLLABUS.addOnRules[cat] || SYLLABUS.addOnRules['其他']) };
}

/** 最高分（免考不计）—— 算法委托 shared/calc.js（双端唯一真相），此处只做取数 */
/**
 * 最高分 —— 与 PC 端语义严格一致：返回该科最高分（**含不及格**，免考不计）。
 * 及格线过滤由计算核心的调用方负责（computeDegreeCore / computeProgressCore）。
 */
function bestScore(code) {
  return ZKCalc.bestScoreOf(loadState().scoreRecords[code]);
}
function allScores(code) { return loadState().scoreRecords[code] || []; }

/**
 * 有效状态 —— 与 PC 端 server/index.js 的 effectiveStatus 完全一致。
 * 成绩优先于手动状态，避免「有及格成绩却显示未通过」这类矛盾。
 */
function effectiveStatus(code) {
  const s = bestScore(code);
  if (s !== null) return s >= 60 ? '已通过' : '未通过';
  const uc = loadState().userCourse[code];
  return (uc && uc.status) || '未开始';
}

/** 应考课程（必考 + 需加考），排除论文用于学分计算 */
function getExamCourses() {
  return [...SYLLABUS.courses, ...getRequiredAddOn()];
}
function getCreditsCourses() {
  return getExamCourses().filter(c => !c.is_thesis);
}

/** 毕业进度 —— 算法在 shared/calc.js（双端唯一真相），此处只做取数组装 */
function computeProgress() {
  const thesis = SYLLABUS.courses.find(c => c.is_thesis);
  return ZKCalc.computeProgressCore({
    courses: getCreditsCourses(),
    scoresByCode: loadState().scoreRecords,
    thesisScore: thesis ? bestScore(thesis.code) : null,
  });
}

/** 五级制/文字成绩 → 数值（委托 shared/calc.js） */
const convertScore = (raw) => ZKCalc.convertScore(raw);

/**
 * 学位均分 —— 委托 shared/calc.js 的 computeDegreeCore。
 * 返回字段名与 PC 端严格对齐（items/passedCount/pendingCount 等）：
 * 曾叫 conditions/passedConditions，renderDegree 读 d.items.length 直接
 * TypeError（APK 启动崩）——字段名必须一字不差，由 tests/degree.test.js 守护。
 */
function computeDegree() {
  const thesisCode = (SYLLABUS.courses.find(c => c.is_thesis) || {}).code;
  return {
    ...ZKCalc.computeDegreeCore({
      courses: getCreditsCourses(),
      scoresByCode: loadState().scoreRecords,
      minAvg: SYLLABUS.degreeRule.min_avg_score,
      thesisMinScore: SYLLABUS.degreeRule.thesis_min_score,
      thesisScore: thesisCode ? bestScore(thesisCode) : null,
    }),
    rule: SYLLABUS.degreeRule,
  };
}

/* ============ 写操作 ============ */
function setCourseStatus(code, patch) {
  const s = loadState();
  s.userCourse[code] = { status: '未开始', planned_exam_date: null, note: '', starred: 0, is_selected: 0, ...(s.userCourse[code] || {}), ...patch };
  saveState();
}
function saveScore(code, rec) {
  const s = loadState();
  if (!s.scoreRecords[code]) s.scoreRecords[code] = [];
  s.scoreRecords[code].push({
    score: rec.score === '' || rec.score === undefined || rec.score === null ? null : Number(rec.score),
    exam_date: rec.exam_date || null,
    exam_session: rec.exam_session || null,
    score_type: rec.score_type || '正常',
    remark: rec.remark || '',
  });
  // 状态跟着成绩走
  const b = bestScore(code);
  s.userCourse[code] = { ...(s.userCourse[code] || { status: '未开始' }),
    status: b === null ? '已考待出分' : (b >= 60 ? '已通过' : '未通过') };
  saveState();
  return { bestScore: b, status: s.userCourse[code].status };
}
function deleteScore(code, idx) {
  const s = loadState();
  if (!s.scoreRecords[code]) return;
  s.scoreRecords[code].splice(idx, 1);
  if (!s.scoreRecords[code].length) delete s.scoreRecords[code];
  const b = bestScore(code);
  if (s.userCourse[code]) {
    s.userCourse[code].status = b === null ? '备考中' : (b >= 60 ? '已通过' : '未通过');
  }
  saveState();
}
function setProfile(patch) {
  const s = loadState();
  s.profile = { ...s.profile, ...patch };
  saveState();
}
function setSetting(key, val) {
  const s = loadState();
  s.settings[key] = val;
  saveState();
}
function recordSourceCrawl(key, ok) {
  const s = loadState();
  s.sourceLog = s.sourceLog || {};
  s.sourceLog[key] = new Date().toISOString();
  if (!ok) s.sourceLog[key] = new Date(Date.now() - 1000 * 60 * 30).toISOString(); // 失败则30分钟后重试
  saveState();
}

/** 论文方向收藏（title 唯一标识） */
function toggleFavDirection(title) {
  const s = loadState();
  s.favDirections = s.favDirections || [];
  const i = s.favDirections.indexOf(title);
  if (i >= 0) s.favDirections.splice(i, 1);
  else s.favDirections.push(title);
  saveState();
  return s.favDirections.includes(title);
}
function getFavDirections() { return loadState().favDirections || []; }

/* ============ 刷题（练习记录 / 错题本） ============ */
/**
 * 为什么存在 localStorage 而不是另起数据库：
 *   题量 150+、每答一题只存 {选项,对错,时间}，一年下来也就几十 KB，
 *   塞进主 state 的好处是导出/导入时刷题记录跟着走，不丢历史。
 *
 * 结构：practice[bankId] = { rec: { [qid]: {c:'A', ok:1|0, ts} }, last: 上一次做到的下标 }
 */
function getPractice(bankId) {
  const s = loadState();
  return s.practice[bankId] || { rec: {}, last: 0 };
}
function recordPractice(bankId, qid, chosen, ok, last) {
  const s = loadState();
  const b = s.practice[bankId] || (s.practice[bankId] = { rec: {}, last: 0 });
  b.rec[qid] = { c: chosen, ok: ok ? 1 : 0, ts: Date.now() };
  if (typeof last === 'number') b.last = last;
  saveState();
}
function resetPractice(bankId) {
  const s = loadState();
  delete s.practice[bankId];
  saveState();
}
/** 某题库的统计：做过的题数 / 正确数 / 错误数 / 正确率 */
function practiceStats(bankId, questions) {
  const rec = getPractice(bankId).rec;
  const ids = (questions || []).map(q => q.id).filter(Boolean);
  let done = 0, right = 0;
  const pool = ids.length ? ids : Object.keys(rec);
  for (const id of pool) {
    const r = rec[id];
    if (!r) continue;
    done++;
    if (r.ok) right++;
  }
  const total = ids.length || pool.length;
  return {
    total, done, right, wrong: done - right,
    left: Math.max(0, total - done),
    rate: done ? Math.round((right / done) * 100) : 0,
  };
}
/** 错题（按题库里的原始顺序返回题目对象） */
function wrongQuestions(bankId, questions) {
  const rec = getPractice(bankId).rec;
  return (questions || []).filter(q => rec[q.id] && !rec[q.id].ok);
}

/* ============ 导入导出（与 PC 端互通） ============ */
function exportAll() {
  return JSON.stringify({
    _v: 1, _at: new Date().toISOString(),
    state: loadState(),
    news: null,   // 资讯正文在 IndexedDB，另行导出
  });
}
function importData(json) {
  try {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    if (!d.state) throw new Error('格式不正确');
    localStorage.setItem(LS_KEY, JSON.stringify(d.state));
    _state = null;
    loadState();
    return { ok: true };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function resetAll() {
  localStorage.removeItem(LS_KEY);
  _state = null;
  idbClear();
}

window.ZKStore = {
  SYLLABUS, loadState, saveState,
  getProfile, setProfile, getGroup, setSetting,
  getRequiredAddOn, getAddOnRule,
  bestScore, allScores, effectiveStatus, convertScore,
  getExamCourses, getCreditsCourses,
  computeProgress, computeDegree,
  setCourseStatus, saveScore, deleteScore,
  idbAll, idbPut, idbClear, pruneNews, recordSourceCrawl, toggleFavDirection, getFavDirections,
  getPractice, recordPractice, resetPractice, practiceStats, wrongQuestions,
  exportAll, importData, resetAll,
};
if (typeof module !== 'undefined' && module.exports) module.exports = window.ZKStore;
