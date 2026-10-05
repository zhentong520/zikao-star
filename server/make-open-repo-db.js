/**
 * 生成「开源示例数据库」—— 不含任何个人隐私数据。
 *
 * 为什么需要：
 *   data/zikao.db 里有用户自己的成绩、笔记、报考记录。
 *   .gitignore 挡住了它，但首次 clone 的人需要一个能直接跑起来的种子库，
 *   否则按 README 的步骤会「数据库不存在」而困惑。
 *
 * 用法：node server/make-open-repo-db.js
 *   → 在 data-sample/ 生成一份干净的 zikao.db
 *   → 用户 cp data-sample/zikao.db data/ 即可开箱即用
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const OUT_DIR = path.join(__dirname, '..', 'data-sample');
const OUT_DB = path.join(OUT_DIR, 'zikao.db');
fs.mkdirSync(OUT_DIR, { recursive: true });
if (fs.existsSync(OUT_DB)) fs.unlinkSync(OUT_DB);

const db = new DatabaseSync(OUT_DB);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// ---- 省份 ----
const p = db.prepare('INSERT OR IGNORE INTO province (code,name,exam_months,enroll_months) VALUES (?,?,?,?)');
p.run('440000', '广东省', '1,4,10', '11,2,8');

// ---- 院校（广州 + 深圳） ----
const s = db.prepare('INSERT OR IGNORE INTO school (code,name,city,province_code,site_url,site_name) VALUES (?,?,?,?,?,?)');
s.run('10574', '华南师范大学', '广州市', '440000', 'https://jxj.scnu.edu.cn/', '华师继续教育学院');
s.run('10590', '深圳大学', '深圳市', '440000', 'https://cce.szu.edu.cn/', '深大继续教育学院');
s.run('10561', '华南理工大学', '广州市', '440000', 'https://sce.scut.edu.cn/', '华工继续教育学院');
s.run('11845', '广东外语外贸大学', '广州市', '440000', null, null);

// ---- 专业课程组 ----
const g = db.prepare(`INSERT OR IGNORE INTO major_group
  (province_code,major_code,major_name,level,school_code,group_name,degree_available,
   plan_version,plan_effective_from,total_credits,required_count,add_on_credits,verified_at,source_url,notes)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
g.run('440000', '080901', '计算机科学与技术', '专升本', '10574',
  '计算机科学与技术（华南师范大学课程组）', 1, '2026', '2026-01-01', 75, 16, 17,
  '2026-10-01', 'https://zxks.eea.gd.gov.cn/',
  '2026年起执行新计划；旧计划(16门74学分)设过渡期与课程顶替表。数据依据广东省教育考试院公开考试计划整理。');
g.run('440000', '080901', '计算机科学与技术', '专升本', '10590',
  '计算机科学与技术（深圳大学课程组）', 1, '2026', '2026-01-01', 75, 16, 19,
  '2026-10-01', 'https://cce.szu.edu.cn/info/1035/6202.htm',
  '深圳大学2026年起课程设置，毕业总学分75。');

// ---- 课程（2026 新计划 · 必考 16 门组 + 实践/论文） ----
const COURSES = [
  ['001', '15040', '习近平新时代中国特色社会主义思想概论', 3, '必考', '笔试', 0, null],
  ['002', '15043', '中国近现代史纲要', 3, '必考', '笔试', 0, null],
  ['003', '15044', '马克思主义基本原理', 3, '必考', '笔试', 0, null],
  ['004', '00023', '高等数学(工本)', 10, '必考', '笔试', 0, null],
  ['005', '02324', '离散数学', 4, '必考', '笔试', 0, null],
  ['006', '13000', '英语(专升本)', 7, '必考', '笔试', 0, null],
  ['007', '13003', '数据结构与算法', 4, '必考', '笔试', 0, null],
  ['008', '13004', '数据结构与算法(实践)', 2, '必考', '实践', 0, '13003'],
  ['009', '13013', '高级语言程序设计', 4, '必考', '笔试', 0, null],
  ['010', '13014', '高级语言程序设计(实践)', 2, '必考', '实践', 0, '13013'],
  ['011', '13015', '计算机系统原理', 4, '必考', '笔试', 0, null],
  ['012', '13180', '操作系统', 4, '必考', '笔试', 0, null],
  ['013', '03344', '信息与网络安全管理', 3, '必考', '笔试', 0, null],
  ['014', '03345', '信息与网络安全管理(实践)', 2, '必考', '实践', 0, '03344'],
  ['015', '08074', '计算机高级程序设计', 3, '必考', '笔试', 0, null],
  ['016', '08075', '计算机高级程序设计(实践)', 2, '必考', '实践', 0, '08074'],
  ['017', '13005', '软件工程', 3, '必考', '笔试', 0, null],
  ['018', '13006', '软件工程(实践)', 2, '必考', '实践', 0, '13005'],
  ['019', '13009', '数据库原理与技术', 4, '必考', '笔试', 0, null],
  ['020', '13011', '人工智能与大数据', 6, '必考', '笔试', 0, null],
  ['021', '11689', '计算机科学与技术(本科)毕业论文', 0, '必考', '实践', 1, null],
];
const ADD_ON = [
  ['201', '02318', '计算机组成原理', 4, '笔试'],
  ['202', '00342', '高级语言程序设计(一)', 3, '笔试'],
  ['202P', '00343', '高级语言程序设计(一)(实践)', 1, '实践'],
  ['203', '04730', '电子技术基础(三)', 5, '笔试'],
  ['203P', '04731', '电子技术基础(三)(实践)', 2, '实践'],
  ['231', '00024', '普通逻辑', 4, '笔试'],
  ['232', '05679', '宪法学', 4, '笔试'],
];

for (const grp of db.prepare('SELECT id FROM major_group').all()) {
  const c = db.prepare(`INSERT OR IGNORE INTO course
    (group_id,seq,code,name,credits,course_type,exam_mode,is_thesis,parent_code,sort_order)
    VALUES (?,?,?,?,?,'必考',?,?,?,?)`);
  COURSES.forEach(([seq, code, name, cr, , mode, thesis, parent], i) => {
    c.run(grp.id, seq, code, name, cr, mode, thesis, parent, i + 1);
  });
  const a = db.prepare(`INSERT OR IGNORE INTO course
    (group_id,seq,code,name,credits,course_type,exam_mode,is_thesis,parent_code,sort_order)
    VALUES (?,?,?,?,?,'加考',?,0,?,?)`);
  ADD_ON.forEach(([seq, code, name, cr, mode], i) => {
    a.run(grp.id, seq, code, name, cr, mode, code.replace(/\(.*\)/, ''), 900 + i);
  });

  // 加考规则
  const r = db.prepare('INSERT OR IGNORE INTO add_on_rule (group_id,prior_category,rule_desc,add_codes,exempt_if_passed) VALUES (?,?,?,?,?)');
  r.run(grp.id, '计算机类', '计算机类（或原计算机及应用）专科毕业生可直接报考本专业，无需加考', '', '');
  r.run(grp.id, '电子电工信息类', '电子电工信息类非本专业专科及以上，须加考 201 门', '02318', '02318');
  r.run(grp.id, '工科类', '工科类非电子电工信息类专科及以上，须加考 201、202 两门', '02318,00342,00343', '同名称课程');
  r.run(grp.id, '其他', '其他专业专科及以上，须加考 201、203 两门', '02318,04730,04731', '同名称课程');
  r.run(grp.id, '港澳台', '港澳台考生可不考思政两门，但须加考 231、232 两门', '00024,05679', '15040,15043');
  r.run(grp.id, '任何', '本专业仅接受国民教育序列的专科（或以上）毕业生申办毕业', '', '');
}

// ---- 学位规则 ----
const d = db.prepare(`INSERT OR IGNORE INTO degree_rule
  (school_code,major_code,apply_year,min_avg_score,thesis_required,thesis_min_score,
   foreign_lang_required,foreign_lang_options,apply_window_months,apply_rounds,
   required_materials,score_count_includes_thesis,score_convert_rule,source_url,published_at,note)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const foreign = JSON.stringify([
  { name: '高等教育自学考试英语(专升本)/英语(二) 统考成绩合格', note: '本专业开设该课程，对自考考生最省事', recommend: true },
  { name: '全国大学英语四级(或六级)考试 425 分及以上', note: '非英语类专业学生' },
  { name: '全国英语等级考试三级笔试成绩合格', note: '非英语类专业学生' },
  { name: '广东省成人高等教育学士学位外国语水平统一考试 合格', note: '' },
  { name: '高等教育自学考试英语(二)或英语(专升本) 统考合格', note: '外语类专业适用第二外语' },
  { name: '网络教育公共基础课《大学英语》B/C 80 分或以上', note: '' },
  { name: '主考院校自行组织的学位外语水平考试 合格', note: '' },
]);
const convert = JSON.stringify({ 优秀: 95, 良好: 85, 中等: 75, 及格: 65, 满分: 100 });
const materials = JSON.stringify([
  '学位论文/设计（含封面、目录、正文，Word）',
  '开题报告（Word）',
  '查重报告（PDF）',
  '学位外语成绩证明或成绩单扫描件',
  '本科毕业证书 / 教育部学历证书电子注册备案表',
  '有效身份证件扫描件',
]);
d.run('10574', '080901', '2026', 70, 1, 70, 1, foreign, 6,
  JSON.stringify(['04-14', '10-08']), materials, 1, convert,
  'https://jky.scnu.edu.cn/', '2026-04-09',
  '依据《华南师范大学学士学位授予工作细则》（教学〔2025〕9号）：课程平均分≥70；须通过学位外语考试；2025年9月之后获颁毕业证书者，毕业论文须答辩且总评≥70分。均分计算：免考不计、补考及格按60分计、含加考与毕业论文成绩、同一课程取最高分。非百分制折算：优秀95/良好85/中等75/及格65。申请时限为毕业证书签发6个月内。');
d.run('10590', '080901', '2026', 70, 1, 70, 1, foreign, 6,
  JSON.stringify(['03', '09']), materials, 1, convert,
  'https://cce.szu.edu.cn/', '2026-01-01',
  '深圳大学学位细则以 cce.szu.edu.cn 最新公告为准。此处配置为按公开信息整理，V1.0 未逐条核验，请以官方为准。');

// ---- 资讯数据源 ----
const src = db.prepare(`INSERT OR IGNORE INTO source
  (key,name,url,type,province_code,school_code,category,interval_min,enabled,note) VALUES (?,?,?,?,?,?,?,?,1,?)`);
src.run('gd_eea_notice', '广东省教育考试院-通知公告', 'https://eea.gd.gov.cn/ptgk/index.html', '官方', '440000', null, '政策', 60, '考试安排/报名/成绩公布等核心公告');
src.run('gd_eea_home', '广东省教育考试院-首页要闻', 'https://eea.gd.gov.cn/', '官方', '440000', null, '政策', 120, '自考相关政策与通知');
src.run('scnu_jky', '华师教育科学学院-通知公告', 'http://jky.scnu.edu.cn/index/tzgg.htm', '院校', '440000', '10574', '学位', 120, '学位申请通知（含条件与时间轴）');
src.run('szu_cce', '深大继续教育学院', 'https://cce.szu.edu.cn/', '院校', '440000', '10590', '学位', 120, '深大自考与学位通知、专业介绍');
src.run('szu_major', '深大-计算机科学与技术专业介绍', 'https://cce.szu.edu.cn/info/1035/6202.htm', '院校', '440000', '10590', '考纲', 720, '2026年起课程设置原文（考纲核对基准）');
src.run('gzzk_cc', '广州招考网-自考', 'http://www.gzzk.cn/zikao/', '资讯', '440000', null, '时间', 90, '广州地区考试安排');
src.run('sz_zikao', '深圳自考网', 'http://www.szzikao.com/', '资讯', '440000', null, '时间', 90, '深圳地区通知');
src.run('gkdd_080901', '自考专业计划-080901', 'https://www.zikaoben.cn/archives/1268.html', '资讯', '440000', null, '考纲', 360, '结构化考纲核对（含新旧计划顶替表）');
src.run('gdszkw_080901', '广东自考网-开考安排', 'http://www.gdszkw.com/', '资讯', '440000', null, '时间', 120, '每考期开考安排整理');

// ---- 论文方向 ----
const t = db.prepare('INSERT INTO thesis_direction (major_code,title,tags,difficulty,heat,refs) VALUES (?,?,?,?,?,?)');
[
  ['基于大语言模型的自适应学习路径推荐系统设计与实现', 'AI应用,教育技术', 5, 298],
  ['面向中小企业的数据中台架构设计与性能优化实践', '系统架构,工程实践', 4, 176],
  ['基于零信任架构的网络安全防护体系研究', '网络安全,理论', 3, 132],
  ['基于协同过滤算法的个性化学习资源推荐系统实现', '算法,教育技术', 4, 165],
  ['基于微服务架构的企业业务系统重构实践研究', '微服务,工程实践', 4, 188],
  ['基于知识图谱的智能问答系统设计与实现', 'AI应用,知识图谱', 5, 302],
  ['基于强化学习的智能仓储路径规划算法研究', '算法,优化', 5, 127],
  ['基于PyTorch的图像风格迁移模型训练与应用', 'AI应用,计算机视觉', 4, 171],
  ['基于Transformer的工业质检轻量化检测模型部署', 'AI应用,计算机视觉', 5, 213],
  ['基于区块链的电子病历数据共享与隐私保护方案', '区块链,医疗', 5, 156],
  ['基于Flutter的跨平台移动应用性能优化研究', '移动开发,性能优化', 3, 154],
  ['基于自然语言处理的法律文书智能辅助审校系统', 'NLP,法律科技', 5, 197],
  ['面向工业物联网的时序数据异常检测方法研究', '数据挖掘,IoT', 4, 121],
  ['基于联邦学习的跨机构医疗数据共享方案', '联邦学习,隐私保护', 5, 143],
  ['面向多租户SaaS平台的资源隔离与调度优化', '云原生,架构', 4, 112],
].forEach(([title, tags, diff, heat]) => t.run('080901', title, tags, diff, heat, null));

// ---- 设置 ----
const set = db.prepare('INSERT OR IGNORE INTO setting (key,value) VALUES (?,?)');
set.run('auto_crawl', '1');
set.run('crawl_interval_multiplier', '1');
set.run('theme', 'warm-sweet');
set.run('school_scope', '广州,深圳');
set.run('data_verified_at', '2026-10-01');

const n = db.prepare('SELECT COUNT(*) c FROM major_group').get().c;
const cs = db.prepare('SELECT COUNT(*) c FROM course').get().c;
const sc = db.prepare('SELECT COUNT(*) c FROM source').get().c;
console.log('✅ 开源示例数据库已生成');
console.log(`   ${OUT_DB}`);
console.log(`   ${n} 个课程组 / ${cs} 门课程 / ${sc} 个数据源 / 15 个论文方向`);
console.log('   ✅ 不含任何个人成绩、笔记或隐私数据');
