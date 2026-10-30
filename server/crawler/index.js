/**
 * 自考星 爬虫核心引擎
 * 设计要点：
 *  1. 敏锐 —— 高频轮询 + 公告窗口期智能提频（考期前 30 天 / 报名期加密）
 *  2. 稳   —— 单源失败不阻塞全局、指数退避、UA 轮换、限速、3 次重试
 *  3. 准   —— 变动检测走 Diff 引擎，误报需连续两次一致才确认
 *  4. 离线 —— 正文本地缓存，断网也能读
 *
 * 规则层（分类/过滤/变动检测/HTML解析）统一从 shared/rules.js 引入 ——
 * PC 端与手机端（shared/crawler-web.js）必须跑同一套规则。
 * 此前这里复制了约 250 行规则代码，与 shared/rules.js 已经出现分叉
 * （如 stripTags 的 br 处理），是「双端结果不一致」的隐患。
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const zlib = require('zlib');

const path = require('path');
const R = require(path.join(__dirname, '..', '..', 'shared', 'rules.js'));

// ============ HTTP 抓取（零依赖） ============
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

async function fetchHtml(url, { timeout = 15000, retries = 2, ua, referer } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          // UA 按数据源固定，不随重试轮换 —— 同一请求重试换 UA 反而更像机器人
          'User-Agent': ua || UAS[i % UAS.length],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          // Referer：部分院校站（如深大 student-cce）有 WAF，无来源直接 412
          ...(referer ? { 'Referer': referer } : {}),
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

// ============ robots.txt（README 承诺兑现：遵守 robots.txt） ============
// 轻量实现：按 origin 缓存 24h，只解析 User-agent:* 组的 Disallow/Allow，
// 最长路径匹配优先。无法获取 robots（404/网络错误/返回 HTML）时默认允许。
const robotsCache = new Map();   // origin -> { rules|null, fetchedAt }
const ROBOTS_TTL = 24 * 3600 * 1000;

function parseRobots(txt) {
  const rules = [];
  let uaStar = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') { uaStar = (val === '*'); continue; }
    if (!uaStar || !val) continue;
    // 保守处理：仅支持路径前缀匹配，忽略中间通配符（政务站 robots 均为简单前缀）
    rules.push({ type: key, path: val.replace(/\*+$/, '') });
  }
  return rules;
}

/** 纯匹配逻辑：User-agent:* 的 Disallow/Allow，最长路径优先（可单测） */
function matchRobots(rules, pathname) {
  let allowed = true, bestLen = -1;
  for (const r of rules) {
    if (r.path && pathname.startsWith(r.path) && r.path.length > bestLen) {
      bestLen = r.path.length;
      allowed = (r.type === 'allow');
    }
  }
  return allowed;
}

async function robotsAllowed(url) {
  let origin, pathname;
  try { const u = new URL(url); origin = u.origin; pathname = u.pathname || '/'; }
  catch { return true; }
  let entry = robotsCache.get(origin);
  if (!entry || Date.now() - entry.fetchedAt > ROBOTS_TTL) {
    let rules = null;
    try {
      const txt = await fetchHtml(`${origin}/robots.txt`, { timeout: 8000, retries: 0 });
      // 部分 404 页面返回 200 + HTML，视为无 robots
      rules = /<html|<!doctype/i.test(txt.slice(0, 200)) ? null : parseRobots(txt);
    } catch { rules = null; }
    entry = { rules, fetchedAt: Date.now() };
    robotsCache.set(origin, entry);
  }
  if (!entry.rules) return true;
  return matchRobots(entry.rules, pathname);
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

  /** 智能提频：距考试越近 / 报名期 / 有未读紧急公告，抓得越勤 */
  dynamicInterval(baseMin) {
    const now = new Date();
    const m = now.getMonth() + 1;
    let factor = 1;
    // 报名期（8月/11月/2月前后）加密
    if ([2, 3, 8, 9, 11, 12].includes(m)) factor *= 0.5;
    // 考期前 30 天（考期基准来自 shared/rules.js 的 GD_EXAM_MONTHS）
    for (const em of R.GD_EXAM_MONTHS) {
      const day = em === 1 ? 10 : em === 4 ? 11 : 24;
      const diff = daysTo(`${now.getFullYear()}-${String(em).padStart(2, '0')}-${day}`);
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
    // 每个源固定一个 UA（按 id 稳定映射），重试期间不变
    const ua = UAS[Math.abs(source.id || 0) % UAS.length];
    try {
      if (!(await robotsAllowed(source.url))) {
        this.db.prepare("UPDATE source SET last_crawled_at=datetime('now','localtime') WHERE id=?").run(source.id);
        this.logCrawl(source.key, 'skipped', 0, 0, 'robots.txt 不允许抓取该路径');
        return;
      }
      const html = await fetchHtml(source.url, { ua });
      const links = R.extractLinks(html, source.url);
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
    let title = fallbackTitle, body = '', images = [];
    try {
      // 详情页带列表页 Referer：深大 student-cce 等站点无 Referer 会 412
      const html = await fetchHtml(url, {
        timeout: 12000, retries: 1,
        ua: UAS[Math.abs(source.id || 0) % UAS.length],
        referer: source.url,
      });
      const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (tm) {
        const raw = R.stripTags(tm[1]).trim();
        // 去掉常见分隔符后的站点名后缀
        let cand = raw.split(/\s*[_|\-—]\s*/)[0].trim();
        // 裁剪后信息量不足（过短 / 泛化）则保留完整 raw 或用列表页标题
        if (cand.length >= 8) cand = cand.slice(0, 120);
        else cand = raw.length > cand.length ? raw : cand;
        if (cand.length >= 6) title = cand;
      }
      // extractMainText 内部已做 script/style/nav/header/footer/aside 清洗
      body = R.extractMainText(html);
      images = R.extractImages(html, url);   // 正文配图（最多 5 张，绝对化 URL）
    } catch (e) { /* 正文抓不到不影响入库，但留一行日志便于排障 */
      console.warn(`[crawler] 正文抓取失败 ${url}: ${e.message}`);
    }

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
    if (!R.isSelfStudyRelevant(title, body, source.category) &&
        !R.isSelfStudyRelevant(fallbackTitle, body, source.category)) {
      return { inserted: false, reason: 'irrelevant' };
    }

    const full = `${title} ${body}`;
    const cat = R.classify(title, body);
    const category = cat !== '其他' ? cat : (source.category || '其他');
    const matched = R.matchCourses(full);
    const relevance = R.calcRelevance(title, body, matched, source);

    let changeFlag = 0;
    // 变动检测只依据「标题」——正文常混入站点导航（"成绩查询""院校查询"等），
    // 用正文会 100% 误报。只有标题明确出现变动信号才记录。
    const change = R.detectChange(title);
    if (change) {
      if (change.risk === 'HIGH') changeFlag = 1;
      // changes 只统计真正落库的变动记录（此前 stat.changes 误数新增资讯）
      if (this.recordChange(change, title, url, matched, source, body)) this.stat.changes++;
    }

    const pubDate = R.guessPublishedAt(full, url);
    this.db.prepare(`INSERT INTO news
      (hash,title,url,source_id,source_name,category,summary,content,published_at,relevance,matched_courses,change_flag,images)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      hash, title, url, source.id, source.name, category,
      body.slice(0, 180) || null, body || null, pubDate,
      relevance, matched.join(','), changeFlag,
      images.length ? JSON.stringify(images) : null
    );
    return { inserted: true };
  }

  recordChange(pattern, title, url, matched, source, body = '') {
    // 防误报：同标题已有未确认记录则跳过
    const dup = this.db.prepare('SELECT id FROM change_record WHERE title=? AND acknowledged_at IS NULL').get(title);
    if (dup) return false;
    const news = this.db.prepare('SELECT id FROM news WHERE url=?').get(url);
    this.db.prepare(`INSERT INTO change_record
      (change_type,risk_level,scope,ref_key,title,detail,affected_count,detected_at,news_id)
      VALUES (?,?,?,?,?,?,?,datetime('now','localtime'),?)`).run(
      pattern.type, pattern.risk, 'news', matched.join(','),
      title,
      `来源：${source.name}\n原文：${url}${body ? '\n\n' + body.slice(0, 500) : ''}`,
      matched.length, news?.id || null
    );
    return true;
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
    // 留存上限：与手机端对齐，只保留最新 100 条资讯
    this.db.prepare(`DELETE FROM news WHERE id NOT IN
      (SELECT id FROM news ORDER BY COALESCE(published_at, crawled_at) DESC, id DESC LIMIT 100)`).run();
    return { ...this.stat };
  }
}

function daysTo(dateStr) {
  const t = new Date(dateStr + 'T00:00:00');
  return Math.ceil((t - new Date()) / 86400000);
}

// 规则函数统一来自 shared/rules.js，这里保持既有导出兼容
// （历史上有调用方直接从 ./crawler 取规则函数）
module.exports = {
  Crawler, fetchHtml, sleep,
  stripTags: R.stripTags, extractLinks: R.extractLinks, extractMainText: R.extractMainText,
  classify: R.classify, matchCourses: R.matchCourses, detectChange: R.detectChange,
  URGENT_PATTERNS: R.URGENT_PATTERNS, isSelfStudyRelevant: R.isSelfStudyRelevant,
  SELF_STUDY_SIGNS: R.SELF_STUDY_SIGNS,
  robotsAllowed, parseRobots, matchRobots,
};
