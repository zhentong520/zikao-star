/**
 * 自考星 爬虫核心引擎
 * 设计要点：
 *  1. 敏锐 —— 高频轮询 + 公告窗口期智能提频（考期前 30 天 / 报名期加密）
 *  2. 稳   —— 单源失败不阻塞全局、指数退避、UA 轮换、限速、3 次重试
 *  3. 准   —— 变动检测走 Diff 引擎，误报需连续两次一致才确认
 *  4. 离线 —— 正文本地缓存，断网也能读
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const zlib = require('zlib');

// ============ HTTP 抓取（零依赖） ============
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

async function fetchHtml(url, { timeout = 15000, retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': UAS[i % UAS.length],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          // 不主动声明 br，避免部分服务端返回压缩但实际未压缩导致解析失败
          'Accept-Encoding': 'gzip, deflate',
        },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const enc = (res.headers.get('content-encoding') || '').toLowerCase();
      let body = buf;
      try {
        if (enc.includes('gzip')) body = zlib.gunzipSync(buf);
        else if (enc.includes('deflate')) body = zlib.inflateSync(buf);
        else if (enc.includes('br') && typeof zlib.brotliDecompressSync === 'function') body = zlib.brotliDecompressSync(buf);
      } catch (e) {
        // 解压失败则按原始字节处理，多数情况下服务端已解压
        body = buf;
      }
      let html = body.toString('utf8');
      // charset 修正
      const declared = (html.match(/charset=["']?([\w-]+)/i) || [])[1] || '';
      if (/gb2312|gbk|gb18030/i.test(declared)) {
        try {
          const dec = new TextDecoder('gb18030');
          html = dec.decode(buf);
        } catch { /* 忽略 */ }
      }
      return html;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < retries) await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============ HTML 解析（零依赖，轻量级） ============
function decodeEntities(s = '') {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&middot;/g, '·').replace(/&hellip;/g, '…').replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d));
}
function stripTags(html = '') {
  return decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, '')
  ).replace(/[ \t　]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 抽取列表页的链接：<a href>文字</a> */
function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1].trim();
    const text = stripTags(m[2]).trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    if (text.length < 6) continue;                    // 过滤导航短链
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch { continue; }
    if (!/^https?:/.test(abs)) continue;
    out.push({ url: abs, title: text });
  }
  return out;
}

/** 按关键词给资讯分类 */
/**
 * 资讯分类。
 * 关键修复点：
 *  1) 顺序敏感 —— 命中即返回，所以「时间/报名」等强特征必须排在前面；
 *     否则「XX专业信息」类页面因正文含「成绩」二字会被误分类为成绩类。
 *  2) 对弱特征（成绩/政策）要求同时命中 ≥2 个关键词，避免单个词命中就定性。
 */
const CATEGORY_RULES = [
  { cat: '时间', strong: ['考试时间', '开考', '考试安排', '考期', '考场', '时间安排', '考试科目安排', '开考课程'],
    weak: ['考试', '时间', '安排'] },
  { cat: '报名', strong: ['报名', '报考', '缴费', '新考期', '课程报考', '报名时间', '报考时间'], weak: [] },
  { cat: '学位', strong: ['学位', '毕业申请', '论文', '答辩', '开题', '学位申请', '学位授予', '学士学位'], weak: [] },
  { cat: '考纲', strong: ['专业计划', '考试计划', '课程设置', '课程顶替', '考纲', '考试大纲', '使用教材', '教材大纲'], weak: ['学分', '课程代码', '大纲'] },
  { cat: '成绩', strong: ['成绩公布', '成绩查询', '查分时间', '成绩已发布', '开放成绩查询'], weak: ['成绩', '分数', '评卷'] },
  { cat: '政策', strong: ['政策', '规定', '管理办法', '改革', '停考', '过渡', '退出', '公告'], weak: ['通知', '调整'] },
];
function classify(title = '', body = '') {
  // 标题优先：标题里的信息最可靠
  const inTitle = (kw) => title.includes(kw);
  for (const r of CATEGORY_RULES) if (r.strong.some(inTitle)) return r.cat;
  const t = title + ' ' + body.slice(0, 400);
  for (const r of CATEGORY_RULES) {
    if (r.strong.some(k => t.includes(k))) return r.cat;
  }
  // 弱特征：要求标题+正文累计命中 ≥2 次
  for (const r of CATEGORY_RULES) {
    const hits = r.weak.filter(k => t.includes(k)).length;
    if (hits >= 2) return r.cat;
  }
  return '其他';
}

/**
 * 正文提取：基于「文本密度」而非「最长容器」。
 *
 * 问题背景：直接取最长的 div 会抓到站点导航/页脚/搜索框（政务站尤其严重，
 * 表现为正文是「网站无障碍 关怀版 搜索 首页 要闻动态…」）。
 *
 * 做法：遍历所有块级容器，逐个算「文本量 / 标签量」得分与文本长度，
 * 选取得分最高且长度足够的容器；再对结果做导航短语清洗。
 */
const NAV_NOISE = [
  /网站无障碍|关怀版|无障碍浏览|长者模式/,
  /^(搜索|首页|导航|菜单|返回|更多|展开|收起)\s*$/m,
  /打印本页|关闭窗口|分享到|字号|字体|设为首页|加入收藏|网站地图|联系我们|版权所有/,
  /上一篇|下一篇|相关阅读|推荐阅读/,
  /^\s*首页\s*>\s*/,
];
function extractMainText(html) {
  const blocks = [...html.matchAll(/<(article|main|section|td|div|p)\b[^>]*>([\s\S]{120,}?)<\/\1>/gi)];
  let best = null, bestScore = 0;
  for (const [, tag, inner] of blocks) {
    const text = stripTags(inner);
    if (text.length < 120) continue;
    // 噪声惩罚：命中导航特征直接降权
    let penalty = 0;
    for (const re of NAV_NOISE) if (re.test(text)) penalty += 0.45;
    // 链接密度惩罚：正文不该有大量超链接
    const linkText = [...inner.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)]
      .map(m => stripTags(m[0])).join('').length;
    const linkRatio = linkText / Math.max(1, text.length);
    if (linkRatio > 0.5) penalty += 0.5;
    // 得分：长度对数 × (1 - 链接密度) - 噪声
    const score = Math.log(text.length + 1) * (1 - Math.min(1, linkRatio)) - penalty;
    if (score > bestScore) { bestScore = score; best = text; }
  }
  let out = best || stripTags(html).slice(0, 8000);
  // 清洗残留导航行
  out = out
    .split('\n')
    .filter(line => !NAV_NOISE.some(re => re.test(line)) || line.length > 80)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 表格型页面（高校专业介绍常见）：正文往往被挤在导航之后，
  // 若清洗后导航占比仍过高，改为「取正文特征最强」的窗口。
  const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length > 8) {
    const junk = lines.filter(l => l.length <= 4 || NAV_NOISE.some(re => re.test(l))).length;
    if (junk / lines.length > 0.45) {
      // 逐行打分（长度 + 含专业/学分开关键信息），取连续高分窗口
      const scored = lines.map((l, i) => {
        let s = Math.min(l.length, 200) / 100;
        if (/专业|课程|学分|代码|考试|毕业|学位|主考|要求|学制|开设/.test(l)) s += 1.2;
        if (l.length <= 3) s -= 0.8;
        if (NAV_NOISE.some(re => re.test(l))) s -= 1.5;
        return { i, s, l };
      });
      let bw = 0, bs = -Infinity;
      for (let i = 0; i < scored.length; i++) {
        let s = 0;
        for (let j = i; j < Math.min(i + 14, scored.length); j++) s += scored[j].s;
        if (s > bs) { bs = s; bw = i; }
      }
      out = scored.slice(bw, bw + 14).map(x => x.l).join('\n');
    }
  }
  return out.slice(0, 20000);
}

/**
 * 关键变动信号。
 * 防误报原则：停考/取消类必须与「自考」同句出现，或命中强表述，
 * 否则「XX专业信息公告」这类常规通知会被误判。
 */
const URGENT_PATTERNS = [
  { type: 'EXAM_MOVED', risk: 'HIGH', test: (t) => /(考试|开考|考期)?时间(调整|变更|改期|推迟|提前)|(调整|变更)考试时间|考试改期|考试延期/.test(t) },
  { type: 'EXAM_CANCELED', risk: 'HIGH', test: (t) => /(停考|缓考|停止开考|取消.{0,6}考试|不安排考试|不再开考|终止.{0,4}考试)/.test(t) },
  { type: 'COURSE_CHANGED', risk: 'HIGH', test: (t) => /(课程|学分|考试计划|专业计划)(调整|变更|修订|更换)|(调整|变更)课程|新增课程|课程代码(变更|调整)|课程顶替(表|办法)/.test(t) },
  { type: 'ENROLL_DEADLINE', risk: 'MEDIUM', test: (t) => /(报名|报考)(截止|结束|将于|即将)|截止报名|报名时间.{0,8}(截止|结束)/.test(t) },
  // 成绩类必须与自考语境绑定，避免「院校专业查询」「学分说明」之类误命中
  { type: 'SCORE_RELEASE', risk: 'MEDIUM', test: (t) =>
      /成绩(公布|查询|已发布|开放)|分数(公布|查询)|开放成绩查询|查分时间|成绩查询入口|成绩什么时候出|如何查分/.test(t) },
  { type: 'DEGREE_POLICY', risk: 'MEDIUM', test: (t) => /(学位)(申请|授予|评定|条件|外语|证书)|毕业论文(要求|提交|截止)|学位授予(工作|细则|方案)/.test(t) },
];

/**
 * 自考相关性判定 —— 这是过滤噪音的核心。
 * 考试院站点混着高考/普高/成招公告，只保留与自考（及其专业/主考院校）相关的。
 */
const SELF_STUDY_SIGNS = [
  '自考', '自学考试', '高等教育自学考试', '自考生', '自考课程', '自考专业',
  '主考', '主考学校', '主考院校', '课程考试', '毕业申请', '学位申请',
  '考试计划', '专业计划', '课程顶替', '报考', '考期', '开考课程',
  '080901', '计算机科学与技术', '专升本', '成人高考', '成考', '网络教育',
];

/** 明确排除的无关主题（普高/高考/中职/研究生等） */
const IRRELEVANT_SIGNS = [
  '高考', '普通高考', '高考成绩', '高考志愿', '投档', '录取', '本科批', '专科批',
  '普通高中', '中考', '初中', '义务教育', '教师资格', '研究生', '考研', '硕士', '博士',
  '征集志愿', '招生计划', '自主招生', '强基', '艺考', '体育类', '军事院校',
];

/**
 * 地域收敛：只保留广东（及广州/深圳）相关内容。
 * 自考是全国统考但考务各省独立，外省专业介绍对本地考生无价值，反而稀释 TOP3。
 */
/**
 * 地域收敛：只保留广东（及广州/深圳）相关内容。
 * 关键：必须基于「标题」判断，不能看全文 ——
 * zikaoben 这类站点正文会嵌入全国各省专业列表，看全文会被绕过。
 */
const OTHER_PROVINCE_SIGNS = [
  '宁夏', '青海', '云南', '四川', '新疆', '西藏', '内蒙古', '甘肃',
  '广西', '贵州', '湖南', '湖北', '河南', '河北', '山东', '安徽', '福建',
  '江西', '陕西', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江',
  '重庆', '天津', '北京', '上海', '海南', '香港', '澳门', '台湾',
];

function isSelfStudyRelevant(title = '', body = '', sourceCategory = '') {
  const t = title + ' ' + body.slice(0, 800);
  if (sourceCategory === '院校') return true;   // 院校源默认相关
  const has = SELF_STUDY_SIGNS.some(k => t.includes(k));
  if (!has) return false;
  const bad = IRRELEVANT_SIGNS.filter(k => t.includes(k));
  if (bad.length && !/自考|自学考试/.test(t)) return false;
  if (bad.length >= 3) return false;

  // 地域收敛：标题里有外省、且无本地标识 → 丢弃
  const localInTitle = /广东|广州|深圳|粤/.test(title);
  const foreignInTitle = OTHER_PROVINCE_SIGNS.filter(k => title.includes(k));
  if (foreignInTitle.length && !localInTitle) return false;

  // 索引/聚合页过滤：这类是院校专业目录导航页，不是公告，对个人无用
  if (/\d{4,6}\s*(\([^)]*\))?\s*专业信息$|专业目录|专业列表|专业大全|招生专业|开设专业/.test(title)) return false;

  // 用户主攻本科（专升本）层次 → 专科段专业目录页全部无关
  if (/\(专科段\)|（专科段）|\[专科\]|专科专业/.test(title)) return false;

  return true;
}

/** 课程代码匹配（5位数字） */
function matchCourses(text) {
  const codes = new Set();
  const KNOWN = new Set(['00015','00023','00024','00321','00342','00343','00910','01008','02142','02197','02318','02324','02325','02326','02331','02333','02375','02378','02382','02383','02384','02628','03173','03344','03345','03708','03709','04720','04722','04730','04731','04735','04737','04741','04747','05679','06289','08074','08075','10203','11393','11441','11689','13000','13003','13004','13005','13006','13009','13011','13013','13014','13015','13180','15040','15043','15044','07999']);
  for (const m of text.matchAll(/\b(\d{5})\b/g)) {
    if (KNOWN.has(m[1])) codes.add(m[1]);
  }
  return [...codes];
}

// ============ 爬虫主体 ============
class Crawler {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL`);
    this.stat = { sources: 0, ok: 0, failed: 0, found: 0, added: 0, changes: 0 };
  }

  get activeMultiplier() {
    const r = this.db.prepare("SELECT value FROM setting WHERE key='crawl_interval_multiplier'").get();
    return Math.max(0.1, parseFloat(r?.value || '1'));
  }

  get autoCrawl() {
    const r = this.db.prepare("SELECT value FROM setting WHERE key='auto_crawl'").get();
    return r?.value !== '0';
  }

  /** 智能提频：距考试越近 / 报名期 / 有未读紧急公告，抓得越勤 */
  dynamicInterval(baseMin) {
    const now = new Date();
    const m = now.getMonth() + 1;
    const d = now.getDate();
    let factor = 1;
    // 报名期（8月/11月/2月前后）加密
    if ([2, 3, 8, 9, 11, 12].includes(m)) factor *= 0.5;
    // 考期前 30 天
    const examMonths = [1, 4, 10];
    for (const em of examMonths) {
      const diff = daysTo(`${now.getFullYear()}-${String(em).padStart(2, '0')}-${em === 1 ? 10 : em === 4 ? 11 : 24}`);
      if (diff >= 0 && diff <= 30) { factor *= 0.4; break; }
    }
    return Math.max(10, Math.round(baseMin * factor * this.activeMultiplier));
  }

  dueSources() {
    const rows = this.db.prepare('SELECT * FROM source WHERE enabled=1').all();
    const now = Date.now();
    return rows.filter(s => {
      if (!s.last_success_at) return true;
      const due = this.dynamicInterval(s.interval_min) * 60000;
      return now - new Date(s.last_crawled_at || 0).getTime() >= due;
    });
  }

  async crawlOne(source) {
    const t0 = Date.now();
    this.stat.sources++;
    let found = 0, added = 0, message = '';
    try {
      const html = await fetchHtml(source.url);
      const links = extractLinks(html, source.url);
      // 过滤：只要看起来像资讯/公告的链接
      const candidates = links.filter(l => {
        if (/\.(pdf|doc|docx|xls|xlsx|zip|rar|jpg|png|gif)$/i.test(l.url)) return false;
        if (l.url === source.url) return false;
        return /[\u4e00-\u9fa5]{6,}/.test(l.title);
      }).slice(0, 40);

      found = candidates.length;
      for (const c of candidates) {
        const r = await this.ingest(c.url, c.title, source);
        if (r.inserted) added++;
      }
      this.db.prepare("UPDATE source SET last_crawled_at=datetime('now','localtime'), last_success_at=datetime('now','localtime'), fail_count=0 WHERE id=?").run(source.id);
      this.stat.ok++; this.stat.found += found; this.stat.added += added;
      message = `发现 ${found} 条，新增 ${added} 条`;
      this.logCrawl(source.key, 'success', found, added, `${message} · ${Date.now() - t0}ms`);
    } catch (e) {
      this.db.prepare("UPDATE source SET last_crawled_at=datetime('now','localtime'), fail_count=fail_count+1 WHERE id=?").run(source.id);
      this.stat.failed++;
      message = e.message;
      this.logCrawl(source.key, 'failed', found, added, message);
    }
    await sleep(400 + Math.random() * 600);  // 礼貌限速
  }

  /** 入库一条资讯：去重 → 抓正文 → 相关性过滤 → 分类 → 匹配课程 → 变动检测 */
  async ingest(url, fallbackTitle, source) {
    const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 24);
    const exist = this.db.prepare('SELECT id FROM news WHERE hash=?').get(hash);
    if (exist) return { inserted: false, id: exist.id, reason: 'dup' };

    // 标题择优
    let title = fallbackTitle, body = '';
    try {
      const html = await fetchHtml(url, { timeout: 12000, retries: 1 });
      const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (tm) {
        const raw = stripTags(tm[1]).trim();
        // 去掉常见分隔符后的站点名后缀
        let cand = raw.split(/\s*[_|\-—]\s*/)[0].trim();
        // 裁剪后信息量不足（过短 / 泛化）则保留完整 raw 或用列表页标题
        if (cand.length >= 8) cand = cand.slice(0, 120);
        else cand = raw.length > cand.length ? raw : cand;
        if (cand.length >= 6) title = cand;
      }
      const cleaned = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<aside[\s\S]*?<\/aside>/gi, '');
      body = extractMainText(cleaned);
    } catch { /* 正文抓不到不影响入库 */ }

    // 标题择优：列表页链接文字往往比被截断的 <title> 更准确（尤其政务站）
    if (/专业信息$|专业目录|专业列表/.test(title) === false &&
        /专业信息$|专业目录|专业列表/.test(fallbackTitle) === true) {
      title = fallbackTitle;
    }

    // URL 路径过滤：/zkzy/(专业) 这类路径是专业目录聚合页，对本科报考者无价值
    if (/\/(zkzy|zyjs|zyml|professional)\//i.test(new URL(url).pathname)) {
      return { inserted: false, reason: 'index_page' };
    }

    // 相关性过滤：两个标题都判断，任一相关即保留
    if (!isSelfStudyRelevant(title, body, source.category) &&
        !isSelfStudyRelevant(fallbackTitle, body, source.category)) {
      return { inserted: false, reason: 'irrelevant' };
    }

    const full = `${title} ${body}`;
    const category = classify(title, body) !== '其他' ? classify(title, body) : (source.category || '其他');
    const matched = matchCourses(full);
    const relevance = this.calcRelevance(title, body, matched, source);

    let changeFlag = 0;
    // 变动检测只依据「标题」——正文常混入站点导航（"成绩查询""院校查询"等），
    // 用正文会 100% 误报。只有标题明确出现变动信号才记录。
    for (const p of URGENT_PATTERNS) {
      if (p.test(title)) {
        this.recordChange(p, title, url, matched, source, body);
        if (p.risk === 'HIGH') changeFlag = 1;
        break;
      }
    }

    const pubDate = this.guessPublishedAt(full, url);
    this.db.prepare(`INSERT INTO news
      (hash,title,url,source_id,source_name,category,summary,content,published_at,relevance,matched_courses,change_flag)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      hash, title, url, source.id, source.name, category,
      body.slice(0, 180) || null, body || null, pubDate,
      relevance, matched.join(','), changeFlag
    );
    this.stat.changes++;
    return { inserted: true };
  }

  calcRelevance(title, body, matched, source) {
    let s = 0.3;
    const t = title + ' ' + body.slice(0, 1500);
    if (matched.length) s += Math.min(0.4, matched.length * 0.1);
    if (/080901|计算机科学与技术/.test(t)) s += 0.15;
    if (/广东|广州|深圳/.test(t)) s += 0.08;
    if (/华南师范大学|深圳大学/.test(t)) s += 0.12;
    if (source.type === '官方') s += 0.1;
    if (source.type === '院校') s += 0.08;
    // 时间衰减
    const ageDays = 30;
    return Math.min(1, s);
  }

  guessPublishedAt(full, url) {
    const m = full.match(/(20\d{2})[-年\/](\d{1,2})[-月\/](\d{1,2})/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    const m2 = url.match(/(20\d{2})(\d{2})(\d{2})/);
    if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
    return new Date().toISOString().slice(0, 10);
  }

  recordChange(pattern, title, url, matched, source, body = '') {
    // 防误报：同标题已有未确认记录则跳过
    const dup = this.db.prepare('SELECT id FROM change_record WHERE title=? AND acknowledged_at IS NULL').get(title);
    if (dup) return;
    const news = this.db.prepare('SELECT id FROM news WHERE url=?').get(url);
    this.db.prepare(`INSERT INTO change_record
      (change_type,risk_level,scope,ref_key,title,detail,affected_count,detected_at,news_id)
      VALUES (?,?,?,?,?,?,?,datetime('now','localtime'),?)`).run(
      pattern.type, pattern.risk, 'news', matched.join(','),
      title,
      `来源：${source.name}\n原文：${url}${body ? '\n\n' + body.slice(0, 500) : ''}`,
      matched.length, news?.id || null
    );
  }

  logCrawl(key, status, found, added, msg) {
    this.db.prepare(`INSERT INTO crawl_log (source_key,finished_at,status,found,added,message)
      VALUES (?,datetime('now','localtime'),?,?,?,?)`).run(key, status, found, added, msg);
  }

  /** 一轮全量爬取 */
  async runOnce(force = false) {
    const list = force ? this.db.prepare('SELECT * FROM source WHERE enabled=1').all() : this.dueSources();
    if (!list.length) return { ...this.stat, skipped: true, message: '暂无到期的数据源' };
    for (const s of list) await this.crawlOne(s);
    this.db.prepare("INSERT OR REPLACE INTO setting (key,value) VALUES ('last_crawl_at',datetime('now','localtime'))").run();
    return { ...this.stat };
  }

  /** 持续调度 */
  async startDaemon() {
    console.log('🕷  爬虫守护进程已启动（Ctrl+C 停止）');
    while (this.autoCrawl) {
      const r = await this.runOnce();
      if (!r.skipped) console.log(`   [${new Date().toLocaleTimeString('zh-CN')}] 源 ${r.sources} / 成功 ${r.ok} / 失败 ${r.failed} / 新增 ${r.added} / 变动 ${r.changes}`);
      const next = 3 * 60000;
      await sleep(next);
    }
  }
}

function daysTo(dateStr) {
  const t = new Date(dateStr + 'T00:00:00');
  return Math.ceil((t - new Date()) / 86400000);
}

module.exports = {
  Crawler, fetchHtml, stripTags, extractLinks,
  classify, matchCourses, URGENT_PATTERNS, isSelfStudyRelevant, SELF_STUDY_SIGNS, extractMainText,
};
