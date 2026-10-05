/**
 * 自考星 · 核心规则（PC 端与手机端共用）
 *
 * 为什么要抽出来：
 *   PC 端用 Node，APK 端用 WebView，两边必须跑同一套规则，
 *   否则「电脑上抓到的资讯」和「手机上抓到的资讯」结果不一样，用户会怀疑。
 *   所以这里只放纯 JS，不依赖任何运行环境 API。
 */

/* ==================== 分类 ====================
 * 顺序敏感：命中即返回，所以强特征必须排前面。
 * 否则「XX专业信息」类页面因正文含「成绩」二字会被误判为成绩类。
 */
const CATEGORY_RULES = [
  { cat: '时间', strong: ['考试时间', '开考', '考试安排', '考期', '考场', '时间安排', '考试科目安排', '开考课程'], weak: ['考试', '时间', '安排'] },
  { cat: '报名', strong: ['报名', '报考', '缴费', '新考期', '课程报考', '报名时间', '报考时间'], weak: [] },
  { cat: '学位', strong: ['学位', '毕业申请', '论文', '答辩', '开题', '学位申请', '学位授予', '学士学位'], weak: [] },
  { cat: '考纲', strong: ['专业计划', '考试计划', '课程设置', '课程顶替', '考纲', '考试大纲', '使用教材', '教材大纲'], weak: ['学分', '课程代码', '大纲'] },
  { cat: '成绩', strong: ['成绩公布', '成绩查询', '查分时间', '成绩已发布', '开放成绩查询'], weak: ['成绩', '分数', '评卷'] },
  { cat: '政策', strong: ['政策', '规定', '管理办法', '改革', '停考', '过渡', '退出', '公告'], weak: ['通知', '调整'] },
];

function classify(title = '', body = '') {
  for (const r of CATEGORY_RULES) if (r.strong.some(k => title.includes(k))) return r.cat;
  const t = title + ' ' + body.slice(0, 400);
  for (const r of CATEGORY_RULES) if (r.strong.some(k => t.includes(k))) return r.cat;
  for (const r of CATEGORY_RULES) {
    if (r.weak.filter(k => t.includes(k)).length >= 2) return r.cat;
  }
  return '其他';
}

/* ==================== 自考相关性过滤 ==================== */
const SELF_STUDY_SIGNS = [
  '自考', '自学考试', '高等教育自学考试', '自考生', '自考课程', '自考专业',
  '主考', '主考学校', '主考院校', '课程考试', '毕业申请', '学位申请',
  '考试计划', '专业计划', '课程顶替', '报考', '考期', '开考课程',
  '080901', '计算机科学与技术', '专升本', '成人高考', '成考', '网络教育',
];
const IRRELEVANT_SIGNS = [
  '高考', '普通高考', '高考成绩', '高考志愿', '投档', '录取', '本科批', '专科批',
  '普通高中', '中考', '初中', '义务教育', '教师资格', '研究生', '考研', '硕士', '博士',
  '征集志愿', '招生计划', '自主招生', '强基', '艺考', '体育类', '军事院校',
];
const OTHER_PROVINCE_SIGNS = [
  '宁夏', '青海', '云南', '四川', '新疆', '西藏', '内蒙古', '甘肃',
  '广西', '贵州', '湖南', '湖北', '河南', '河北', '山东', '安徽', '福建',
  '江西', '陕西', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江',
  '重庆', '天津', '北京', '上海', '海南', '香港', '澳门', '台湾',
];

function isSelfStudyRelevant(title = '', body = '', sourceCategory = '') {
  const t = title + ' ' + body.slice(0, 800);
  if (sourceCategory === '院校') return true;
  if (!SELF_STUDY_SIGNS.some(k => t.includes(k))) return false;
  const bad = IRRELEVANT_SIGNS.filter(k => t.includes(k));
  if (bad.length && !/自考|自学考试/.test(t)) return false;
  if (bad.length >= 3) return false;
  // 地域收敛：以标题为准（正文常嵌入全国列表，不能看全文）
  const localInTitle = /广东|广州|深圳|粤/.test(title);
  const foreignInTitle = OTHER_PROVINCE_SIGNS.filter(k => title.includes(k));
  if (foreignInTitle.length && !localInTitle) return false;
  // 索引/聚合页：专业目录导航页，对本科报考者无价值
  if (/\d{4,6}\s*(\([^)]*\))?\s*专业信息$|专业目录|专业列表|专业大全|招生专业|开设专业/.test(title)) return false;
  if (/\(专科段\)|（专科段）|\[专科\]|专科专业/.test(title)) return false;
  return true;
}

/* ==================== 变动检测 ====================
 * 只依据标题判断。标题不含明确变动信号则不记录，避免误报。
 */
const URGENT_PATTERNS = [
  { type: 'EXAM_MOVED', risk: 'HIGH', test: (t) => /(考试|开考|考期)?时间(调整|变更|改期|推迟|提前)|(调整|变更)考试时间|考试改期|考试延期/.test(t) },
  { type: 'EXAM_CANCELED', risk: 'HIGH', test: (t) => /(停考|缓考|停止开考|取消.{0,6}考试|不安排考试|不再开考|终止.{0,4}考试)/.test(t) },
  { type: 'COURSE_CHANGED', risk: 'HIGH', test: (t) => /(课程|学分|考试计划|专业计划)(调整|变更|修订|更换)|(调整|变更)课程|新增课程|课程代码(变更|调整)|课程顶替(表|办法)/.test(t) },
  { type: 'ENROLL_DEADLINE', risk: 'MEDIUM', test: (t) => /(报名|报考)(截止|结束|将于|即将)|截止报名|报名时间.{0,8}(截止|结束)/.test(t) },
  { type: 'SCORE_RELEASE', risk: 'MEDIUM', test: (t) =>
      /成绩(公布|查询|已发布|开放)|分数(公布|查询)|开放成绩查询|查分时间|成绩查询入口|成绩什么时候出|如何查分/.test(t) },
  { type: 'DEGREE_POLICY', risk: 'MEDIUM', test: (t) => /(学位)(申请|授予|评定|条件|外语|证书)|毕业论文(要求|提交|截止)|学位授予(工作|细则|方案)/.test(t) },
];

function detectChange(title) {
  for (const p of URGENT_PATTERNS) if (p.test(title)) return p;
  return null;
}

/* ==================== 课程代码匹配 ==================== */
const KNOWN_CODES = new Set([
  '00015','00023','00024','00321','00342','00343','00910','01008','02142','02197',
  '02318','02324','02325','02326','02331','02333','02375','02378','02382','02383','02384',
  '02628','03173','03344','03345','03708','03709','04720','04722','04730','04731','04735',
  '04737','04741','04747','05679','06289','08074','08075','10203','11393','11441','11689',
  '13000','13003','13004','13005','13006','13009','13011','13013','13014','13015','13180',
  '15040','15043','15044','07999',
]);
function matchCourses(text) {
  const out = [];
  for (const m of String(text).matchAll(/\b(\d{5})\b/g)) {
    if (KNOWN_CODES.has(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/* ==================== HTML 解析 ==================== */
function decodeEntities(s = '') {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&middot;/g, '·').replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d));
}
function stripTags(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \t　]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1].trim();
    const text = stripTags(m[2]).trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    if (text.length < 6) continue;
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch { continue; }
    if (!/^https?:/.test(abs)) continue;
    out.push({ url: abs, title: text });
  }
  return out;
}

/**
 * 正文提取：基于「文本密度」而非「最长容器」。
 * 直接取最长 div 会抓到站点导航（政务站尤甚）。
 */
const NAV_NOISE = [
  /网站无障碍|关怀版|无障碍浏览|长者模式/,
  /^(搜索|首页|导航|菜单|返回|更多|展开|收起)\s*$/m,
  /打印本页|关闭窗口|分享到|字号|字体|设为首页|加入收藏|网站地图|联系我们|版权所有/,
  /上一篇|下一篇|相关阅读|推荐阅读/,
  /^\s*首页\s*>\s*/,
];

function extractMainText(html) {
  const cleaned = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '');
  const blocks = [...cleaned.matchAll(/<(article|main|section|td|div|p)\b[^>]*>([\s\S]{120,}?)<\/\1>/gi)];
  let best = null, bestScore = 0;
  for (const [, tag, inner] of blocks) {
    const text = stripTags(inner);
    if (text.length < 120) continue;
    let penalty = 0;
    for (const re of NAV_NOISE) if (re.test(text)) penalty += 0.45;
    const linkText = [...inner.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map(m => stripTags(m[0])).join('').length;
    const linkRatio = linkText / Math.max(1, text.length);
    if (linkRatio > 0.5) penalty += 0.5;
    const score = Math.log(text.length + 1) * (1 - Math.min(1, linkRatio)) - penalty;
    if (score > bestScore) { bestScore = score; best = text; }
  }
  let out = best || stripTags(cleaned).slice(0, 8000);
  out = out.split('\n')
    .filter(line => !NAV_NOISE.some(re => re.test(line)) || line.length > 80)
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // 表格型页面：正文被挤在导航之后时，取「连续高分窗口」
  const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length > 8) {
    const junk = lines.filter(l => l.length <= 4 || NAV_NOISE.some(re => re.test(l))).length;
    if (junk / lines.length > 0.45) {
      const scored = lines.map(l => {
        let s = Math.min(l.length, 200) / 100;
        if (/专业|课程|学分|代码|考试|毕业|学位|主考|要求|学制|开设/.test(l)) s += 1.2;
        if (l.length <= 3) s -= 0.8;
        if (NAV_NOISE.some(re => re.test(l))) s -= 1.5;
        return { s, l };
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

/* ==================== 相关度打分 ==================== */
function calcRelevance(title, body, matched, source) {
  let s = 0.3;
  const t = title + ' ' + String(body).slice(0, 1500);
  if (matched.length) s += Math.min(0.4, matched.length * 0.1);
  if (/080901|计算机科学与技术/.test(t)) s += 0.15;
  if (/广东|广州|深圳/.test(t)) s += 0.08;
  if (/华南师范大学|深圳大学/.test(t)) s += 0.12;
  if (source && source.type === '官方') s += 0.1;
  if (source && source.type === '院校') s += 0.08;
  return Math.min(1, s);
}

function guessPublishedAt(full, url) {
  const m = String(full).match(/(20\d{2})[-年\/](\d{1,2})[-月\/](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const m2 = String(url).match(/(20\d{2})(\d{2})(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return new Date().toISOString().slice(0, 10);
}

/* ==================== 简单 hash（替代 Node crypto） ==================== */
function simpleHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/* ==================== 考试考期常量 ==================== */
const GD_EXAM_MONTHS = [1, 4, 10];
const GD_ENROLL_MONTHS = [2, 8, 11];   // 报名约在考前 2-3 个月

module.exports = {
  classify, isSelfStudyRelevant, detectChange, matchCourses,
  stripTags, extractLinks, extractMainText, decodeEntities,
  calcRelevance, guessPublishedAt, simpleHash,
  CATEGORY_RULES, URGENT_PATTERNS, KNOWN_CODES,
  GD_EXAM_MONTHS, GD_ENROLL_MONTHS,
};
