-- 自考星 本地数据库 schema (SQLite)
-- 设计原则：全本地、离线可用、结构化考纲优先于爬虫

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ========== 考纲与院校 ==========
CREATE TABLE IF NOT EXISTS province (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  exam_months TEXT NOT NULL DEFAULT '1,4,10',  -- 年考期
  enroll_months TEXT NOT NULL DEFAULT '8,11,2'  -- 报名月份
);

CREATE TABLE IF NOT EXISTS school (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  province_code TEXT NOT NULL REFERENCES province(code),
  site_url TEXT,
  site_name TEXT,
  active INTEGER DEFAULT 1
);

-- 专业课程组（广东 080901 特点：同一专业代码下多个主考院校课程组）
CREATE TABLE IF NOT EXISTS major_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  province_code TEXT NOT NULL REFERENCES province(code),
  major_code TEXT NOT NULL,             -- 080901
  major_name TEXT NOT NULL,             -- 计算机科学与技术
  level TEXT NOT NULL,                  -- 专升本
  school_code TEXT NOT NULL REFERENCES school(code),
  group_name TEXT NOT NULL,             -- 课程组名，如「计算机科学与技术（深圳大学课程组）」
  degree_available INTEGER DEFAULT 1,
  plan_version TEXT NOT NULL,           -- 2026
  plan_effective_from TEXT,             -- 2026-01-01
  total_credits REAL NOT NULL,
  required_count INTEGER NOT NULL,
  add_on_credits REAL DEFAULT 0,        -- 加考课学分
  verified_at TEXT,                     -- 数据核验时间
  source_url TEXT,
  notes TEXT,
  UNIQUE(province_code, major_code, school_code, plan_version)
);

-- 课程（必考/选考/加考，笔试/实践，论文单独标记）
CREATE TABLE IF NOT EXISTS course (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES major_group(id) ON DELETE CASCADE,
  seq TEXT,                            -- 001
  code TEXT NOT NULL,                  -- 13003
  name TEXT NOT NULL,
  credits REAL NOT NULL DEFAULT 0,
  course_type TEXT NOT NULL DEFAULT '必考',   -- 必考/选考/加考
  exam_mode TEXT NOT NULL,             -- 笔试/实践
  is_thesis INTEGER DEFAULT 0,
  parent_code TEXT,                    -- 实践课关联的笔试课代码
  prerequisite TEXT,                   -- 前置要求
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_course_group ON course(group_id);
CREATE INDEX IF NOT EXISTS idx_course_code ON course(code);

-- 加考规则（按前置学历判定）
CREATE TABLE IF NOT EXISTS add_on_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES major_group(id) ON DELETE CASCADE,
  prior_category TEXT NOT NULL,        -- 计算机类/电子电工类/工科类/其他/港澳台
  rule_desc TEXT NOT NULL,
  add_codes TEXT NOT NULL,             -- 逗号分隔
  exempt_if_passed TEXT                -- 可免考的同名称课程
);

-- ========== 学位规则（规则引擎，按院校+年份） ==========
CREATE TABLE IF NOT EXISTS degree_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_code TEXT NOT NULL REFERENCES school(code),
  major_code TEXT NOT NULL,
  apply_year TEXT NOT NULL,
  min_avg_score REAL NOT NULL,         -- 课程均分线
  thesis_required INTEGER DEFAULT 0,
  thesis_min_score REAL,               -- 论文/答辩最低分
  foreign_lang_required INTEGER DEFAULT 1,
  foreign_lang_options TEXT,           -- JSON 数组
  apply_window_months INTEGER,         -- 毕业后申请时限（月）
  apply_rounds TEXT,                   -- JSON 数组，如 ["04-14","10-08"]
  required_materials TEXT,             -- JSON 数组
  score_count_includes_thesis INTEGER DEFAULT 1,
  score_convert_rule TEXT,             -- 非百分制折算 JSON
  source_url TEXT,
  published_at TEXT,
  note TEXT,
  UNIQUE(school_code, major_code, apply_year)
);

-- ========== 用户本地档案 ==========
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT DEFAULT '我',
  avatar_emoji TEXT DEFAULT '🌷',
  province_code TEXT DEFAULT '440000',
  city TEXT DEFAULT '广州市',
  group_id INTEGER REFERENCES major_group(id),
  prior_category TEXT DEFAULT '其他',
  has_degree_target INTEGER DEFAULT 1,
  plan_version TEXT DEFAULT '2026',
  expected_graduate_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ========== 用户科目状态 ==========
CREATE TABLE IF NOT EXISTS user_course (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES course(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT '未开始',  -- 未开始/已报名/备考中/已考待出分/已通过/未通过/免考
  is_selected INTEGER DEFAULT 0,           -- 计入本考期计划
  planned_exam_date TEXT,
  booked_exam_session TEXT,                -- 2026-10-24-AM
  exam_center TEXT,
  reminder_days TEXT DEFAULT '7,1',
  notify_score INTEGER DEFAULT 1,
  note TEXT,
  starred INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(profile_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_uc_profile ON user_course(profile_id);

-- 成绩记录（支持多次）
CREATE TABLE IF NOT EXISTS score_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_course_id INTEGER NOT NULL REFERENCES user_course(id) ON DELETE CASCADE,
  score REAL,
  exam_date TEXT,
  exam_session TEXT,                    -- 2026-10
  score_type TEXT DEFAULT '正常',         -- 正常/补考/免考
  remark TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sr_uc ON score_record(user_course_id);

-- ========== 考试安排 ==========
CREATE TABLE IF NOT EXISTS exam_arrangement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  province_code TEXT NOT NULL,
  course_code TEXT NOT NULL,
  exam_date TEXT NOT NULL,
  session TEXT NOT NULL,               -- AM/PM
  time_range TEXT,
  exam_center TEXT,
  address TEXT,
  room TEXT,
  source_url TEXT,
  published_at TEXT,
  crawled_at TEXT,
  UNIQUE(province_code, course_code, exam_date, session)
);
CREATE INDEX IF NOT EXISTS idx_ea_date ON exam_arrangement(exam_date);

-- ========== 资讯（爬虫） ==========
CREATE TABLE IF NOT EXISTS source (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL,                  -- 官方/院校/资讯/经验
  province_code TEXT,
  school_code TEXT,
  category TEXT,                       -- 考纲/时间/政策/学位/经验/其他
  list_selector TEXT,                  -- CSS 选择器（可选）
  link_pattern TEXT,
  interval_min INTEGER DEFAULT 60,     -- 抓取间隔（分钟）
  enabled INTEGER DEFAULT 1,
  last_crawled_at TEXT,
  last_success_at TEXT,
  fail_count INTEGER DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE NOT NULL,           -- url hash 或 title hash
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source_id INTEGER REFERENCES source(id) ON DELETE SET NULL,
  source_name TEXT,
  category TEXT,
  summary TEXT,
  content TEXT,                        -- 正文纯文本（本地缓存，供离线阅读）
  published_at TEXT,
  crawled_at TEXT DEFAULT (datetime('now','localtime')),
  is_read INTEGER DEFAULT 0,
  is_starred INTEGER DEFAULT 0,
  is_hide INTEGER DEFAULT 0,
  relevance REAL DEFAULT 0,
  matched_courses TEXT,                -- 关联课程代码，逗号分隔
  change_flag INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_news_time ON news(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_cat ON news(category);

-- 抓取日志
CREATE TABLE IF NOT EXISTS crawl_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now','localtime')),
  finished_at TEXT,
  status TEXT,                         -- success/failed
  found INTEGER DEFAULT 0,
  added INTEGER DEFAULT 0,
  message TEXT
);
CREATE INDEX IF NOT EXISTS idx_clog_time ON crawl_log(started_at DESC);

-- ========== 变动检测 ==========
CREATE TABLE IF NOT EXISTS change_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_type TEXT NOT NULL,           -- COURSE_ADDED/COURSE_REMOVED/CREDIT_CHANGED/EXAM_MOVED/EXAM_CANCELED/DEGREE_POLICY/PLAN_VERSION
  risk_level TEXT NOT NULL,            -- HIGH/MEDIUM/LOW
  scope TEXT,                          -- exam_arrangement/degree_rule/course
  ref_key TEXT,                        -- 课程代码等
  title TEXT NOT NULL,
  detail TEXT,
  before_json TEXT,
  after_json TEXT,
  detected_at TEXT DEFAULT (datetime('now','localtime')),
  acknowledged_at TEXT,
  affected_count INTEGER DEFAULT 0,
  news_id INTEGER REFERENCES news(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_cr_time ON change_record(detected_at DESC);

-- 变动快照基线（用于 Diff）
CREATE TABLE IF NOT EXISTS snapshot (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ========== 论文 ==========
CREATE TABLE IF NOT EXISTS thesis_direction (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  major_code TEXT NOT NULL DEFAULT '080901',
  school_code TEXT,
  title TEXT NOT NULL,
  tags TEXT,
  difficulty INTEGER DEFAULT 3,        -- 1-5
  heat INTEGER DEFAULT 0,
  refs TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS thesis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  direction_id INTEGER REFERENCES thesis_direction(id),
  title TEXT,
  abstract TEXT,
  stage TEXT DEFAULT '方向选择',         -- 方向选择/报名立项/开题报告/论文撰写/查重答辩/成绩录入/已完成
  advisor TEXT,
  defense_date TEXT,
  score REAL,
  similarity REAL,
  note TEXT,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ========== 提醒 ==========
CREATE TABLE IF NOT EXISTS reminder (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                  -- EXAM/ENROLL/SCORE/THESIS/DEGREE
  title TEXT NOT NULL,
  content TEXT,
  trigger_at TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  channel TEXT DEFAULT 'app',
  sent_at TEXT,
  clicked_at TEXT,
  status TEXT DEFAULT 'pending',        -- pending/sent/done/cancel
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_rm_trigger ON reminder(status, trigger_at);

-- 设置
CREATE TABLE IF NOT EXISTS setting (
  key TEXT PRIMARY KEY,
  value TEXT
);
