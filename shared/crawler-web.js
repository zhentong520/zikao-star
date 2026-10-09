/**
 * 自考星 · 手机端爬虫（WebView 内运行）
 *
 * 与 PC 端 crawler/index.js 的差异仅在「环境适配」，规则完全共用 shared/rules.js：
 *   fetch 抓取  → 用浏览器原生 fetch（自动处理 gzip/charset）
 *   crypto hash → 用 simpleHash（shared/rules.js 提供）
 *   SQLite      → 用 ZKStore（localStorage + IndexedDB）
 *   Buffer/zlib→ 不需要（浏览器已解压）
 *
 * 抓取策略与 PC 端一致：
 *   1. 自适应提频（报名期/考前 30 天加密）
 *   2. 单源失败不阻塞全局、指数退避、UA 轮换、限速
 *   3. 变动检测只依据标题（避免正文导航噪音导致误报）
 */
(function (global) {
  'use strict';

  const R = global.ZKRules;
  if (!R) { console.error('shared/rules.js 未加载'); return; }

  const UAS = [
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  ];

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /** 抓取 HTML（浏览器 fetch 自动解压，无需 zlib） */
  /**
   * 抓取 HTML。
   * APK（Capacitor）：必须走 CapacitorHttp 原生请求——WebView 里 fetch 外部站点
   *   属于跨域，政府站不返回 CORS 头会被浏览器拦截（v1.0.5 前资讯从未抓到的根因）。
   *   原生层无 CORS 限制，且自动处理 gzip。
   * 浏览器（PC/PWA）：走原生 fetch（PC 端抓取在 Node 守护进程，此路径仅兜底）。
   * 已知限制：CapacitorHttp 按 utf-8 解码，gb2312 站点可能乱码（主流 gov 站已迁移 utf-8）。
   */
  async function fetchHtml(url, { timeout = 15000, retries = 2 } = {}) {
    const capHttp = (typeof window !== 'undefined' && window.Capacitor &&
      window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) || null;
    let lastErr;

    if (capHttp) {
      for (let i = 0; i <= retries; i++) {
        try {
          const res = await capHttp.get({
            url,
            headers: {
              'User-Agent': UAS[i % UAS.length],
              'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9',
            },
            responseType: 'TEXT',
            connectTimeout: timeout,
            readTimeout: timeout,
          });
          if (res.status >= 400) throw new Error('HTTP ' + res.status);
          const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
          if (!text || text.length < 100) throw new Error('响应过短(' + (text || '').length + ')');
          return text;
        } catch (e) {
          lastErr = e;
          if (i < retries) await sleep(1200 * (i + 1));
        }
      }
      throw lastErr;
    }

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
          },
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        // 浏览器已按 charset 解码；若声明 gb18030 需手动转码
        const buf = await res.arrayBuffer();
        const ctype = res.headers.get('content-type') || '';
        let text;
        const m = ctype.match(/charset=([\w-]+)/i);
        const charset = (m ? m[1] : 'utf-8').toLowerCase();
        if (/gb2312|gbk|gb18030/.test(charset)) {
          try { text = new TextDecoder('gb18030').decode(buf); }
          catch (e) { text = new TextDecoder('utf-8').decode(buf); }
        } else {
          text = new TextDecoder('utf-8').decode(buf);
        }
        return text;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (i < retries) await sleep(1200 * (i + 1));
      }
    }
    throw lastErr;
  }

  /** 自适应提频：报名期与考前 30 天加密 */
  function dynamicInterval(baseMin, multiplier) {
    const now = new Date();
    const m = now.getMonth() + 1;
    let factor = 1;
    if ([2, 3, 8, 9, 11, 12].includes(m)) factor *= 0.5;   // 报名期
    const year = now.getFullYear();
    const sessions = [`${year}-01-10`, `${year}-04-11`, `${year}-10-24`];
    for (const s of sessions) {
      const diff = Math.ceil((new Date(s + 'T00:00:00') - now) / 86400000);
      if (diff >= 0 && diff <= 30) { factor *= 0.4; break; }
    }
    return Math.max(10, Math.round(baseMin * factor * (multiplier || 1)));
  }

  class Crawler {
    constructor(store) {
      this.store = store;
      this.stat = { sources: 0, ok: 0, failed: 0, found: 0, added: 0, changes: 0 };
    }

    async crawlOne(source, existingHashes) {
      this.stat.sources++;
      let found = 0, added = 0;
      const toSave = [];
      try {
        const html = await fetchHtml(source.url);
        const links = R.extractLinks(html, source.url);
        const candidates = links.filter(l => {
          if (/\.(pdf|doc|docx|xls|xlsx|zip|rar|jpg|png|gif)$/i.test(l.url)) return false;
          if (l.url === source.url) return false;
          if (!/[\u4e00-\u9fa5]{6,}/.test(l.title)) return false;
          if (!R.isSelfStudyRelevant(l.title, '', source.category)) return false;
          return true;
        }).slice(0, 12);

        found = candidates.length;
        // 列表级入库：不抓详情正文（正文在用户点开详情时延迟抓取），
        // 单源从「1+25 次请求」降到「1 次请求」，这是启动提速的核心。
        for (const c of candidates) {
          const r = this.ingest(c.url, c.title, source, existingHashes, toSave);
          if (r.inserted) added++;
        }
        if (toSave.length) await this.store.idbPut(toSave);
        this.stat.ok++; this.stat.found += found; this.stat.added += added;
      } catch (e) {
        this.stat.failed++;
        return { ok: false, msg: e.message, name: source.name };
      }
      await sleep(150 + Math.random() * 150);
      return { ok: true, found, added, name: source.name };
    }

    /** 列表级入库（同步、零额外请求）：正文留空，newsDetail 打开时延迟补抓 */
    ingest(url, fallbackTitle, source, existingHashes, toSave) {
      const hash = R.simpleHash(url);
      if (existingHashes.has(hash)) return { inserted: false, reason: 'dup' };

      let title = fallbackTitle;
      // 聚合页纠正：详情页 title 若被截断成泛化词，用列表页文字
      if (!/专业信息$|专业目录|专业列表/.test(title) && /专业信息$|专业目录|专业列表/.test(fallbackTitle)) {
        title = fallbackTitle;
      }
      // URL 路径过滤：专业目录聚合页
      if (/\/(zkzy|zyjs|zyml|professional)\//i.test(new URL(url).pathname)) {
        return { inserted: false, reason: 'index_page' };
      }
      // 相关性校验（标题级：延迟抓取模式下没有正文，标题判定已足够强）
      if (!R.isSelfStudyRelevant(title, '', source.category) &&
          !R.isSelfStudyRelevant(fallbackTitle, '', source.category)) {
        return { inserted: false, reason: 'irrelevant' };
      }

      const cat = R.classify(title, '') !== '其他' ? R.classify(title, '') : (source.category || '其他');
      const matched = R.matchCourses(title);
      const relevance = R.calcRelevance(title, '', matched, source);

      // 变动检测：只看标题
      let changeFlag = 0;
      const change = R.detectChange(title);
      if (change) {
        if (change.risk === 'HIGH') changeFlag = 1;
        this.stat.changes++;
      }

      const rec = {
        hash, title, url,
        source_name: source.name, source_type: source.type,
        category: cat,
        summary: null,          // 延迟：点开详情时补
        content: null,          // 延迟：点开详情时补
        published_at: R.guessPublishedAt(title, url),
        crawled_at: new Date().toISOString(),
        relevance, matched_courses: matched.join(','),
        change_flag: changeFlag,
        change_type: change ? change.type : null,
        risk_level: change ? change.risk : null,
        is_read: 0,
        need_fetch: 1,          // 标记正文待抓
      };
      existingHashes.add(hash);
      toSave.push(rec);
      return { inserted: true };
    }

    /** 一轮到期抓取（force=true 时全量）；源间 3 并发提速 */
    async runOnce(force = false) {
      const S = this.store;
      const all = await S.idbAll();
      const existingHashes = new Set(all.map(r => r.hash));
      const sources = S.SYLLABUS.sources;
      const list = force ? sources : sources.filter(s => {
        const last = S.loadState().sourceLog?.[s.key];
        if (!last) return true;
        const due = dynamicInterval(s.interval_min, S.loadState().settings.crawlMultiplier) * 60000;
        return Date.now() - new Date(last).getTime() >= due;
      });
      if (!list.length) return { ...this.stat, skipped: true };

      // 3 路并发：9 个源从串行 ~20s 缩到 ~7s（受网络为主）
      const CONC = 3;
      let idx = 0;
      const self = this;
      async function worker() {
        while (idx < list.length) {
          const s = list[idx++];
          const r = await self.crawlOne(s, existingHashes);
          S.recordSourceCrawl(s.key, r.ok);
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, worker));

      S.setSetting('lastCrawlAt', new Date().toISOString());
      return { ...this.stat };
    }
  }

  global.ZKCrawler = { Crawler, fetchHtml, dynamicInterval };
})(typeof window !== 'undefined' ? window : globalThis);
