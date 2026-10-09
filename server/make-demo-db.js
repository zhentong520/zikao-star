/**
 * 生成「演示数据库」—— 用于生成 README 截图，不含任何真实个人数据。
 *
 * 为什么需要：
 *   真实使用的 data/zikao.db 里有本人的成绩（88/82/91...），
 *   直接拿它截图发到 GitHub 等于公开分数。开源项目的截图必须是演示数据。
 *
 * 用法：
 *   node server/make-demo-db.js            # 生成 data-demo/zikao.db
 *   ZK_DB=data-demo/zikao.db npm start     # 用演示库启动后截图
 *
 * 贡献者也可以用它生成自己的演示截图。
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'data-demo');
const DB = path.join(OUT, 'zikao.db');
fs.mkdirSync(OUT, { recursive: true });
if (fs.existsSync(DB)) fs.unlinkSync(DB);

const db = new DatabaseSync(DB);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const p = db.prepare('INSERT OR IGNORE INTO province (code,name) VALUES (?,?)');
p.run('440000', '广东省');

const s = db.prepare('INSERT OR IGNORE INTO school (code,name,city,province_code,site_url,site_name) VALUES (?,?,?,?,?,?)');
s.run('10574', '华南师范大学', '广州市', '440000', 'https://jxj.scnu.edu.cn/', '华师继续教育学院');
s.run('10590', '深圳大学', '深圳市', '440000', 'https://cce.szu.edu.cn/', '深大继续教育学院');

const g = db.prepare(`INSERT OR IGNORE INTO major_group
  (province_code,major_code,major_name,level,school_code,group_name,degree_available,
   plan_version,total_credits,required_count,verified_at,source_url,notes)
  VALUES (?,?,?,?,?,?,1,'2026',?,?,?,?,?)`);
g.run('440000', '080901', '计算机科学与技术', '专升本', '10574',
  '计算机科学与技术（华南师范大学课程组）', 75, 21, '2026-10-01',
  'https://zxks.eea.gd.gov.cn/', '示例数据，非官方发布');
g.run('440000', '080901', '计算机科学与技术', '专升本', '10590',
  '计算机科学与技术（深圳大学课程组）', 75, 21, '2026-10-01',
  'https://cce.szu.edu.cn/', '示例数据，非官方发布');

const COURSES = [
  ['001', '15040', '习近平新时代中国特色社会主义思想概论', 3, '笔试'],
  ['002', '15043', '中国近现代史纲要', 3, '笔试'],
  ['003', '15044', '马克思主义基本原理', 3, '笔试'],
  ['004', '00023', '高等数学(工本)', 10, '笔试'],
  ['005', '02324', '离散数学', 4, '笔试'],
  ['006', '13000', '英语(专升本)', 7, '笔试'],
  ['007', '13003', '数据结构与算法', 4, '笔试'],
  ['008', '13004', '数据结构与算法(实践)', 2, '实践'],
  ['009', '13013', '高级语言程序设计', 4, '笔试'],
  ['010', '13014', '高级语言程序设计(实践)', 2, '实践'],
  ['011', '13015', '计算机系统原理', 4, '笔试'],
  ['012', '13180', '操作系统', 4, '笔试'],
  ['013', '03344', '信息与网络安全管理', 3, '笔试'],
  ['014', '03345', '信息与网络安全管理(实践)', 2, '实践'],
  ['015', '08074', '计算机高级程序设计', 3, '笔试'],
  ['016', '08075', '计算机高级程序设计(实践)', 2, '实践'],
  ['017', '13005', '软件工程', 3, '笔试'],
  ['018', '13006', '软件工程(实践)', 2, '实践'],
  ['019', '13009', '数据库原理与技术', 4, '笔试'],
  ['020', '13011', '人工智能与大数据', 6, '笔试'],
  ['021', '11689', '计算机科学与技术(本科)毕业论文', 0, '实践'],
];
// 列数与占位符必须严格一致：9 列 9 值
const c = db.prepare(`INSERT OR IGNORE INTO course
  (group_id,seq,code,name,credits,course_type,exam_mode,is_thesis,sort_order)
  VALUES (?,?,?,?,?,?,?,?,?)`);
// 两个课程组都插入同一套课程（演示用途）
const allGroups = db.prepare('SELECT id FROM major_group').all();
for (const grp of allGroups) {
  COURSES.forEach(([seq, code, name, cr, mode], i) => {
    c.run(grp.id, seq, code, name, cr, '必考', mode, code === '11689' ? 1 : 0, i + 1);
  });
}
const gid = db.prepare("SELECT id FROM major_group WHERE school_code='10574'").get().id;

db.prepare(`INSERT OR IGNORE INTO degree_rule
  (school_code,major_code,apply_year,min_avg_score,thesis_required,thesis_min_score,
   foreign_lang_required,apply_window_months,note)
  VALUES ('10574','080901','2026',70,1,70,1,6,?)`)
  .run('示例规则，实际以主考院校最新公告为准');
db.prepare(`INSERT OR IGNORE INTO degree_rule
  (school_code,major_code,apply_year,min_avg_score,thesis_required,thesis_min_score,
   foreign_lang_required,apply_window_months,note)
  VALUES ('10590','080901','2026',70,1,70,1,6,?)`)
  .run('示例规则，实际以主考院校最新公告为准');

const src = db.prepare('INSERT OR IGNORE INTO source (key,name,url,type,province_code,school_code,category,interval_min,enabled) VALUES (?,?,?,?,?,?,?,?,1)');
src.run('gd_eea_notice', '广东省教育考试院-通知公告', 'https://eea.gd.gov.cn/ptgk/index.html', '官方', '440000', null, '政策', 60);
src.run('gd_eea_tzgg', '广东省教育考试院-通知公告(移动版)', 'https://eea.gd.gov.cn/tzgg/mindex.html', '官方', '440000', null, '政策', 90);
src.run('gd_5184_zk', '广东考试服务网-自考地级市', 'https://5184.com/h-nr--0_31_21.html', '聚合', '440000', null, '报名', 120);
src.run('gd_eea_home', '广东省教育考试院-首页要闻', 'https://eea.gd.gov.cn/', '官方', '440000', null, '政策', 120);
src.run('scnu_jky', '华师教育科学学院-通知公告', 'http://jky.scnu.edu.cn/index/tzgg.htm', '院校', '440000', '10574', '学位', 120);
src.run('szu_cce', '深大继续教育学院', 'https://cce.szu.edu.cn/', '院校', '440000', '10590', '学位', 120);

// 论文题目库（演示数据，与开源示例库一致的题目）
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

// ---------- 演示档案 ----------
db.prepare(`INSERT INTO profile (nickname,avatar_emoji,province_code,city,group_id,prior_category,has_degree_target,plan_version)
  VALUES ('小鹿','🌷','440000','广州市',?,'其他',1,'2026')`).run(gid);

/**
 * 演示成绩 —— 刻意用与真实数据不同的分数，避免截图泄露本人成绩。
 * 选「中等偏上」的分值组合：既能展示达标状态，又能体现提分空间。
 */
const DEMO_SCORES = [
  ['15040', 86, '2026-04-12', '正常'],
  ['15043', 79, '2026-04-12', '正常'],
  ['15044', 84, '2026-04-12', '正常'],
  ['00023', 81, '2026-04-12', '正常'],
  ['13000', 72, '2026-04-12', '正常'],
  ['13003', 94, '2026-10-25', '正常'],
  ['13009', 55, '2026-04-12', '补考'],
];

for (const [code, score, date, type] of DEMO_SCORES) {
  const cid = db.prepare('SELECT id FROM course WHERE group_id=? AND code=?').get(gid, code);
  db.prepare(`INSERT INTO user_course (profile_id,course_id,status) VALUES (1,?,?)`)
    .run(cid.id, score >= 60 ? '已通过' : '未通过');
  const uc = db.prepare('SELECT id FROM user_course WHERE course_id=?').get(cid.id);
  db.prepare(`INSERT INTO score_record (user_course_id,score,exam_date,exam_session,score_type,remark)
    VALUES (?,?,?,?,?,?)`).run(uc.id, score, date, date.slice(0, 7), type,
    code === '13009' ? '差 5 分，下轮重点补' : '');
}

// 报名中的科目（让首页有倒计时可展示）
for (const [code, date] of [['13005', '2026-10-24'], ['13180', '2026-10-24'], ['02324', '2026-10-24'], ['13015', '2026-10-25']]) {
  const cid = db.prepare('SELECT id FROM course WHERE group_id=? AND code=?').get(gid, code);
  db.prepare(`INSERT OR IGNORE INTO user_course (profile_id,course_id,status,planned_exam_date,is_selected)
    VALUES (1,?,'已报名',?,1)`).run(cid.id, date);
}

// 一条变动提醒
db.prepare(`INSERT INTO change_record (change_type,risk_level,scope,title,detail,detected_at)
  VALUES ('ENROLL_DEADLINE','MEDIUM','news',?,?,datetime('now','localtime'))`)
  .run('广东省10月自考课程报考时间公告',
    '来源：广东省教育考试院\n请留意报名截止时间，错过需等下一考期。');

/**
 * 演示资讯 —— 用真实抓取会随时间变化，截图不可复现。
 * 这里放几条典型样例，够撑起界面即可（内容为示意，非实际公告）。
 */
const NEWS = [
  ['2026年10月广东省自学考试开考课程考试时间安排', '时间', 'gd_eea_notice', '广东省教育考试院', '2026-09-28', '15040,15043,00023,02324,13000,13180,13005,13013,13003,13015,13009', 1],
  ['关于2027年1月自学考试开考计划与使用教材的通知', '考纲', 'gd_eea_notice', '广东省教育考试院', '2026-09-15', '15040,15043,15044,00023,13000,02324,13003', 0],
  ['关于做好2026年秋季高等学历继续教育学士学位申请工作的通知', '学位', 'scnu_jky', '华南师范大学教育科学学院', '2026-09-10', '13000,00023', 1],
  ['广东省2026年10月自考课程报考时间公告（9月4日17:00截止）', '报名', 'gd_eea_notice', '广东省教育考试院', '2026-09-03', '', 1],
  ['2026年4月自学考试成绩查分时间：5月13日左右', '成绩', 'gd_eea_notice', '广东省教育考试院', '2026-05-06', '', 1],
  ['深圳大学高等教育自学考试计算机科学与技术(专升本)专业介绍', '考纲', 'szu_cce', '深圳大学继续教育学院', '2026-01-15', '15040,15043,15044,00023,13000,02324,13003,13013,13015,13180,03344,08074,13005,13009,13011,11689', 0],
  ['关于高等教育自学考试课程设置与教材使用的说明', '考纲', 'scnu_jky', '华南师范大学', '2026-08-20', '00023,13000', 0],
  ['自考毕业申请与学位申请流程指引（2026版）', '学位', 'szu_cce', '深圳大学继续教育学院', '2026-07-08', '11689', 0],
  ['2026年10月自考考前提示：携带身份证与准考证', '时间', 'gd_eea_notice', '广东省教育考试院', '2026-10-18', '', 0],
  ['关于全国自学考试统一命题课程考试时间调整的通知', '时间', 'gd_eea_notice', '广东省教育考试院', '2026-08-12', '02324,13180', 1],
];
const nIns = db.prepare(`INSERT INTO news
  (hash,title,url,source_id,source_name,category,summary,content,published_at,crawled_at,relevance,matched_courses,change_flag,is_read)
  VALUES (?,?,?,(SELECT id FROM source WHERE key=?),?,?,?,?,?,datetime('now','localtime'),?,?,?,0)`);
const CONTENT = `（演示内容，非实际公告）

本页面用于展示自考星 App 的资讯阅读能力。实际使用时，这里会是抓取自
广东省教育考试院及各主考院校官网的公告全文，并标注来源与发布时间。

真实场景下你会看到：
· 考试时间安排表（开考日期、时段、课程代码）
· 报名时间与缴费提醒
· 成绩公布时间
· 学位申请条件与时间轴
· 课程调整、停考通知

所有内容本地缓存，断网也能阅读。`;

NEWS.forEach(([title, cat, key, src, date, codes, flag], i) => {
  const url = `https://example.gov.cn/notice/${i + 1}`;
  // 参数顺序必须与占位符严格一致（12 个）：
  // hash, title, url, [source_id 子查询的 key], source_name, category,
  // summary, content, published_at, relevance, matched_courses, change_flag
  nIns.run(
    'demo' + String(i).padStart(3, '0') + (cat || 'x'),
    title,
    url,
    key,                        // source.key → 子查询定位 source_id
    src,                        // source_name 显示名
    cat,                        // category
    title + ' —— 演示摘要',      // summary
    CONTENT,                    // content
    date,                       // published_at
    Math.round((0.95 - i * 0.03) * 100) / 100,  // relevance
    codes,                      // matched_courses
    flag                        // change_flag
  );
});

console.log('✅ 演示数据库已生成');
console.log('  ', DB);
console.log(`   成绩 ${DEMO_SCORES.length} 条（分数为演示值，非真实数据）`);
console.log('   用法：ZK_DB=data-demo/zikao.db npm start');
