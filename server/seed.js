/**
 * 种子数据：广东省 计算机科学与技术(080901) 专升本
 * 覆盖：华南师范大学课程组 + 深圳大学课程组
 * 数据依据：广东省教育考试院 2026 年专业考试计划、深大 cce.szu.edu.cn 官方公布
 * 核验时间：2026-10-01
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB = process.env.ZK_DB || path.join(__dirname, '..', 'data', 'zikao.db');
fs.mkdirSync(path.dirname(DB), { recursive: true });
const db = new DatabaseSync(DB);

function seed() {
  // ---- schema ----
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  // ---- 省份 ----
  const pIns = db.prepare('INSERT OR IGNORE INTO province (code,name,exam_months,enroll_months) VALUES (?,?,?,?)');
  pIns.run('440000', '广东省', '1,4,10', '11,2,8');
  pIns.run('320000', '江苏省', '1,4,10', '11,3,9');
  pIns.run('330000', '浙江省', '1,4,10', '12,3,9');

  // ---- 院校（先做广州 + 深圳） ----
  const sIns = db.prepare('INSERT OR IGNORE INTO school (code,name,city,province_code,site_url,site_name) VALUES (?,?,?,?,?,?)');
  sIns.run('10574', '华南师范大学', '广州市', '440000', 'https://jxj.scnu.edu.cn/', '华师继续教育学院');
  sIns.run('10590', '深圳大学',      '深圳市', '440000', 'https://cce.szu.edu.cn/', '深大 continuing 教育学院');
  sIns.run('10561', '华南理工大学',  '广州市', '440000', 'https://sce.scut.edu.cn/', '华工继续教育学院');
  sIns.run('10578', '广州大学',      '广州市', '440000', null, null);
  sIns.run('10559', '暨南大学',      '广州市', '440000', null, null);
  sIns.run('11845', '广东外语外贸大学', '广州市', '440000', null, null);
  sIns.run('11847', '广东财经大学',  '广州市', '440000', null, null);
  sIns.run('10659', '深圳职业技术大学', '深圳市', '440000', null, null);

  // ---- 专业课程组 ----
  const gIns = db.prepare(`INSERT OR IGNORE INTO major_group
    (province_code,major_code,major_name,level,school_code,group_name,degree_available,
     plan_version,plan_effective_from,total_credits,required_count,add_on_credits,verified_at,source_url,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  // 华师课程组
  gIns.run('440000', '080901', '计算机科学与技术', '专升本', '10574',
    '计算机科学与技术（华南师范大学课程组）', 1, '2026', '2026-01-01', 75, 16, 17,
    '2026-10-01', 'https://zxks.eea.gd.gov.cn/', '2026年起执行新计划；旧计划(16门74学分)设过渡期与课程顶替表');
  // 深大课程组
  gIns.run('440000', '080901', '计算机科学与技术', '专升本', '10590',
    '计算机科学与技术（深圳大学课程组）', 1, '2026', '2026-01-01', 75, 16, 19,
    '2026-10-01', 'https://cce.szu.edu.cn/info/1035/6202.htm', '深大2026年起使用；毕业总学分75');

  // 第二梯队（待数据完善后开放选择）
  gIns.run('440000', '080901', '计算机科学与技术', '专升本', '10561',
    '计算机科学与技术（华南理工大学课程组）', 1, '2026', '2026-01-01', 75, 16, 0,
    '2026-10-01', 'https://sce.scut.edu.cn/', '课程组待逐门核验');
  gIns.run('440000', '080901', '计算机科学与技术', '专升本', '11845',
    '计算机科学与技术（广东外语外贸大学课程组）', 1, '2026', '2026-01-01', 75, 16, 0,
    '2026-10-01', null, '课程组待逐门核验');

  // ---- 课程 ----
  // 数据结构：[seq, code, name, credits, type, examMode, isThesis, parentCode]
  const COURSES = {
    '10574': [ // 华师课程组
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
    ],
    '10590': [ // 深大课程组
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
    ],
  };

  // 加考课（华师/深大通用组，来源：专业计划说明）
  const ADD_ON = [
    ['201', '02318', '计算机组成原理', 4, '笔试', '电子电工信息类非本专业专科及以上'],
    ['202', '00342', '高级语言程序设计(一)', 3, '笔试', '工科类非电子电工信息类本科'],
    ['202P', '00343', '高级语言程序设计(一)(实践)', 1, '实践', '同上'],
    ['203', '04730', '电子技术基础(三)', 5, '笔试', '其他专业专科及以上'],
    ['203P', '04731', '电子技术基础(三)(实践)', 2, '实践', '同上'],
    ['231', '00024', '普通逻辑', 4, '笔试', '港澳台考生'],
    ['232', '05679', '宪法学', 4, '笔试', '港澳台考生'],
  ];

  const schools = db.prepare('SELECT code,name,city FROM school').all();
  const groups = db.prepare('SELECT id,school_code,group_name FROM major_group').all();

  for (const g of groups) {
    const list = COURSES[g.school_code];
    if (!list) continue;
    const cIns = db.prepare(`INSERT OR IGNORE INTO course
      (group_id,seq,code,name,credits,course_type,exam_mode,is_thesis,parent_code,sort_order)
      VALUES (?,?,?,?,?,'必考',?,?,?,?)`);
    list.forEach(([seq, code, name, cr, , mode, thesis, parent], i) => {
      cIns.run(g.id, seq, code, name, cr, mode, thesis, parent, i + 1);
    });
    // 加考课挂到同组（course_type=加考）
    const aIns = db.prepare(`INSERT OR IGNORE INTO course
      (group_id,seq,code,name,credits,course_type,exam_mode,is_thesis,parent_code,sort_order)
      VALUES (?,?,?,?,?,'加考',?,0,?,?)`);
    ADD_ON.forEach(([seq, code, name, cr, mode, when], i) => {
      aIns.run(g.id, seq, code, name, cr, mode, code.replace(/\(.*\)/, ''), 900 + i);
    });

    // 加考规则
    const rIns = db.prepare('INSERT OR IGNORE INTO add_on_rule (group_id,prior_category,rule_desc,add_codes,exempt_if_passed) VALUES (?,?,?,?,?)');
    rIns.run(g.id, '计算机类', '计算机类（或原计算机及应用）专科毕业生可直接报考本专业，无需加考', '', '');
    rIns.run(g.id, '电子电工信息类', '电子电工信息类非本专业专科及以上，须加考 201 门', '02318', '02318');
    rIns.run(g.id, '工科类', '工科类非电子电工信息类专科及以上，须加考 201、202 两门', '02318,00342,00343', '同名称课程');
    rIns.run(g.id, '其他', '其他专业专科及以上，须加考 201、203 两门', '02318,04730,04731', '同名称课程');
    rIns.run(g.id, '港澳台', '港澳台考生可不考 001、002 两门，但须加考 231、232 两门', '00024,05679', '15040,15043');
    rIns.run(g.id, '任何', '本专业仅接受国民教育序列的专科（或以上）毕业生申办毕业', '', '');
  }

  // ---- 学位规则（华师：教学〔2025〕9号） ----
  const dIns = db.prepare(`INSERT OR IGNORE INTO degree_rule
    (school_code,major_code,apply_year,min_avg_score,thesis_required,thesis_min_score,
     foreign_lang_required,foreign_lang_options,apply_window_months,apply_rounds,
     required_materials,score_count_includes_thesis,score_convert_rule,source_url,published_at,note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const foreignOpts = JSON.stringify([
    { name: '自考英语(专升本)/英语(二) 统考合格', note: '对自考考生最省事，本专业开设该科', recommend: true },
    { name: '全国大学英语四级(或六级) ≥425分', note: '非英语类专业' },
    { name: '全国英语等级考试(PETS)三级 笔试合格', note: '非英语类专业' },
    { name: '广东省成人高等教育学士学位外国语水平统一考试 合格', note: '' },
    { name: '网络教育公共基础课《大学英语》B/C ≥80分', note: '' },
    { name: '华师自行组织的学位外语水平考试 合格', note: '' },
  ]);
  const convertRule = JSON.stringify({ '优秀': 95, '良好': 85, '中等': 75, '及格': 65, '满分': 100 });
  const materials = JSON.stringify([
    '学位论文/设计（含封面、目录、正文 Word）',
    '开题报告（Word）',
    '查重报告（PDF）',
    '学位外语成绩证明（或成绩单扫描件）',
    '本科毕业证书 / 教育部学历证书电子注册备案表',
    '有效身份证原件扫描件',
  ]);

  dIns.run('10574', '080901', '2026', 70, 1, 70, 1, foreignOpts, 6,
    JSON.stringify(['04-14', '10-08']), materials, 1, convertRule,
    'http://jky.scnu.edu.cn/a/20260409/6552.html', '2026-04-09',
    '2025年9月之后获颁毕业证书者，毕业论文/设计须通过答辩且总评≥70分。申请时限为毕业证签发6个月内。均分计算：免考不计、补考按60计、含加考/选考/论文、同科取最高分。申报系统 https://hnsfdx.jxjy.chaoxing.com/login');

  dIns.run('10590', '080901', '2026', 70, 1, 70, 1, foreignOpts, 6,
    JSON.stringify(['03', '09']), materials, 1, convertRule,
    'https://cce.szu.edu.cn/info/1035/6202.htm', '2026-01-01',
    '深大学位细则以 cce.szu.edu.cn 最新通知为准，V1.0 暂按均分70+论文70+学位外语配置，需人工核验');

  // ---- 资讯数据源（URL 已于 2026-10 实测可达） ----
  const srcIns = db.prepare(`INSERT OR IGNORE INTO source
    (key,name,url,type,province_code,school_code,category,interval_min,enabled,note) VALUES (?,?,?,?,?,?,?,?,1,?)`);

  // 省级官方
  srcIns.run('gd_eea_notice', '广东省教育考试院-通知公告', 'https://eea.gd.gov.cn/ptgk/index.html', '官方', '440000', null, '政策', 60, '考试安排/报名/成绩公布等核心公告');
  srcIns.run('gd_eea_home',  '广东省教育考试院-首页要闻', 'https://eea.gd.gov.cn/', '官方', '440000', null, '政策', 120, '自考相关政策与通知');
  // 院校官方
  srcIns.run('scnu_jky', '华师教育科学学院-通知公告', 'http://jky.scnu.edu.cn/index/tzgg.htm', '院校', '440000', '10574', '学位', 120, '学位申请通知（含条件与时间轴）；注：jxj.scnu.edu.cn 已迁移，此为现行域名');
  srcIns.run('scnu_home', '华师主页-教育快讯', 'https://www.scnu.edu.cn/', '院校', '440000', '10574', '其他', 240, '兜底源');
  srcIns.run('szu_cce', '深大继续教育学院-首页', 'https://cce.szu.edu.cn/', '院校', '440000', '10590', '学位', 120, '深大自考与学位通知、专业介绍');
  srcIns.run('szu_major', '深大-计算机科学与技术专业介绍', 'https://cce.szu.edu.cn/info/1035/6202.htm', '院校', '440000', '10590', '考纲', 720, '2026年起课程设置原文（考纲核对基准）');
  // 地区与垂直资讯
  srcIns.run('gzzk_cc', '广州招考网-自考', 'http://www.gzzk.cn/zikao/', '资讯', '440000', null, '时间', 90, '广州地区考试安排');
  srcIns.run('sz_zikao', '深圳自考网', 'http://www.szzikao.com/', '资讯', '440000', null, '时间', 90, '深圳地区通知');
  srcIns.run('gkdd_080901', '自考专业计划-080901', 'https://www.zikaoben.cn/archives/1268.html', '资讯', '440000', null, '考纲', 360, '结构化考纲核对（含新旧计划顶替表）');
  srcIns.run('gdszkw_080901', '广东自考网-开考安排', 'http://www.gdszkw.com/', '资讯', '440000', null, '时间', 120, '每考期开考安排整理');

  // ---- 论文题目方向（计算机类） ----
  const tIns = db.prepare('INSERT INTO thesis_direction (major_code,school_code,title,tags,difficulty,heat,refs) VALUES (?,?,?,?,?,?,?)');
  const DIRECTIONS = [
    ['基于大语言模型的自适应学习路径推荐系统设计与实现', 'AI应用,教育技术', 5, 298],
    ['面向中小企业的数据中台架构设计与性能优化实践', '系统架构,工程实践', 4, 176],
    ['基于零信任架构的高校网络安全防护体系研究', '网络安全,理论', 3, 132],
    ['基于协同过滤算法的个性化学习资源推荐系统实现', '算法,教育技术', 4, 165],
    ['基于Spring Cloud的微服务架构在企业业务系统中的落地研究', '微服务,工程实践', 4, 188],
    ['基于深度学习的医学影像辅助诊断系统设计与实现', 'AI应用,医疗', 5, 245],
    ['面向社交网络的用户画像与兴趣挖掘方法研究', '数据挖掘,算法', 4, 141],
    ['基于边缘计算的视频实时处理系统设计与优化', '边缘计算,系统架构', 4, 118],
    ['面向中小企业的网络安全等级保护合规建设研究', '网络安全,合规', 3, 96],
    ['基于Flutter的跨平台移动应用性能优化研究', '移动开发,性能优化', 3, 154],
    ['基于知识图谱的智能问答系统设计与实现', 'AI应用,知识图谱', 5, 302],
    ['基于强化学习的智能仓储路径规划算法研究', '算法,优化', 5, 127],
    ['面向粤语方言的语音识别系统设计与实现', '语音识别,方言', 4, 88],
    ['基于区块链的电子病历数据共享与隐私保护方案研究', '区块链,医疗', 5, 156],
    ['面向工业质检的轻量化目标检测模型设计与部署', 'AI应用,计算机视觉', 5, 213],
    ['基于协同过滤与内容混合的课程推荐系统设计与实现', '推荐系统,教育技术', 4, 122],
    ['面向中小企业的数据安全备份与容灾方案设计', '数据安全,工程实践', 3, 79],
    ['基于PyTorch的图像风格迁移模型训练与应用', 'AI应用,计算机视觉', 4, 171],
    ['面向多终端的电子商务平台性能优化与架构演进研究', '系统架构,电商', 4, 134],
    ['基于自然语言处理的法律文书智能辅助审校系统', 'NLP,法律科技', 5, 197],
  ];
  DIRECTIONS.forEach(([t, tags, d, h]) => tIns.run('080901', null, t, tags, d, h, JSON.stringify({ 关键词: t.split('基于')[1]?.slice(0, 6) || t.slice(0, 6) })));

  // ---- 设置 ----
  const setIns = db.prepare('INSERT OR IGNORE INTO setting (key,value) VALUES (?,?)');
  setIns.run('last_crawl_at', '');
  setIns.run('auto_crawl', '1');
  setIns.run('crawl_interval_multiplier', '1');
  setIns.run('theme', 'warm-sweet');
  setIns.run('school_scope', '广州,深圳');
  setIns.run('data_verified_at', '2026-10-01');

  // ---- 清理历史脏数据（专业目录聚合页 / 专科段页面 / 外省内容） ----
  const before = db.prepare('SELECT COUNT(*) c FROM news').get().c;
  db.exec(`DELETE FROM news
    WHERE title LIKE '%专业信息%'
       OR title LIKE '%专业目录%'
       OR title LIKE '%专业列表%'
       OR title LIKE '%专业大全%'
       OR title LIKE '%(专科段)%'
       OR title LIKE '%（专科段）%'
       OR url LIKE '%/zkzy/%'
       OR title LIKE '%宁夏自考%' OR title LIKE '%青海自考%' OR title LIKE '%云南自考%'
       OR title LIKE '%四川自考%' OR title LIKE '%重庆自考%' OR title LIKE '%海南自考%'
       OR title LIKE '%湖南自考%' OR title LIKE '%湖北自考%' OR title LIKE '%山东自考%'`);
  const after = db.prepare('SELECT COUNT(*) c FROM news').get().c;
  if (before > 0 && before !== after) {
    console.log(`🧹 清理历史脏数据：${before} → ${after} 条（删除 ${before - after} 条目录页/专科段/外省内容）`);
  }
  // 同步清理对应的变动记录
  db.exec(`DELETE FROM change_record WHERE title LIKE '%专业信息%' OR title LIKE '%(专科段)%' OR title LIKE '%（专科段）%'`);

  // ---- 统计 ----
  const nGroups = db.prepare('SELECT COUNT(*) c FROM major_group').get().c;
  const nCourses = db.prepare('SELECT COUNT(*) c FROM course').get().c;
  const nSrc = db.prepare('SELECT COUNT(*) c FROM source').get().c;
  const nDir = db.prepare('SELECT COUNT(*) c FROM thesis_direction').get().c;
  console.log(`✅ 种子数据完成：${nGroups} 个课程组 / ${nCourses} 门课程 / ${nSrc} 个数据源 / ${nDir} 个论文方向`);
  console.log(`   数据库：${DB}`);
}

if (require.main === module) seed();
module.exports = { db, seed, DB };
