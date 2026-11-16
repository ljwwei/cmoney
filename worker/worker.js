// Cloudflare Worker：台股大盤（加權指數）盤中即時行情邊緣代理 + 可選盤後 Cron 喚醒
// 部署方式：貼上至 Cloudflare Dashboard Worker 編輯器並 Deploy。
// 可選環境變數 / Secret：
//   ALLOWED_ORIGIN - 額外允許的前端 Origin（逗號分隔；預設已允許 https://ljwwei.github.io 與本機測試）
//   GITHUB_TOKEN   - （選填，僅若與盤後 Cron Trigger 共用同支 Worker 時需要）
//   GITHUB_REPO    - （選填，例 ljwwei/cmoney）

const TWSE_MIS_URL = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0';
const YAHOO_TW_URL =
  'https://tw.stock.yahoo.com/_td-stock/api/resource/FinanceChartService.ApacLibraCharts;symbols=%5B%22%5ETWII%22%5D;type=tick';
const CNYES_TWSE_URL = 'https://ws.api.cnyes.com/ws/api/v1/quote/quotes/TWS:TSE01:INDEX';
const YAHOO_TWII_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1m&range=1d';

const CACHE_KEY_LIVE = 'https://cache.cmoney.local/api/taiex-v2';
const CACHE_KEY_STALE = 'https://cache.cmoney.local/api/taiex-stale-v2';

const INTRADAY_TTL_SEC = 2; // 盤中共享快取 s-maxage = 2 秒（台股 5 秒撮合一次，前端每 2.5 秒輪詢）
const OFFHOURS_TTL_SEC = 60;
const STALE_TTL_SEC = 600;
const UPSTREAM_TIMEOUT_MS = 800; // 三個上游一律 0.8 秒極速超時，慢來源直接跳過，不拖累時間差

/** 盤中 2 秒、非盤中 60 秒的共享快取秒數 */
export function cacheTtlFor(now = new Date()) {
  return isWorkerIntradayWindow(now) ? INTRADAY_TTL_SEC : OFFHOURS_TTL_SEC;
}

/** 在 URL 尾端加上防快取時間戳（自動判斷用 ? 或 &），確保不吃到上游 CDN 幾秒前的舊快取 */
export function withCacheBuster(url, ts = Date.now()) {
  return `${url}${String(url).includes('?') ? '&' : '?'}_=${ts}`;
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: 'https://mis.twse.com.tw/stock/fibest.jsp',
  'Cache-Control': 'no-cache',
};

const SOURCE_PRIORITY = {
  mis: 4,
  yahoo_tw: 3,
  cnyes: 2,
  yahoo: 1,
};

export function parseNum(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : NaN;
  const s = String(val ?? '').replace(/,/g, '').trim();
  if (!s || s === '-') return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function taipeiNowParts(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const hh = t.getUTCHours();
  const mm = t.getUTCMinutes();
  const ss = t.getUTCSeconds();
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    time: `${pad(hh)}:${pad(mm)}:${pad(ss)}`,
    minutes: hh * 60 + mm,
    dow: t.getUTCDay(),
  };
}

/** 週一至週五 08:55 ～ 13:35 台北時間為高頻盤中視窗 */
export function isWorkerIntradayWindow(now = new Date()) {
  const { dow, minutes } = taipeiNowParts(now);
  if (dow === 0 || dow === 6) return false;
  return minutes >= 8 * 60 + 55 && minutes <= 13 * 60 + 35;
}

export function parseMisLive(json, nowIso = new Date().toISOString()) {
  const item = json?.msgArray?.[0];
  if (!item) return null;

  const rawDate = String(item.d ?? '').trim();
  if (!/^\d{8}$/.test(rawDate)) return null;
  const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;

  const rawTime = String(item.t ?? '').trim();
  const tm = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(rawTime);
  if (!tm) return null;
  const time = `${tm[1].padStart(2, '0')}:${tm[2]}:${tm[3]}`;

  const close = parseNum(item.z);
  const prevClose = parseNum(item.y);
  if (!(close > 0) || !(prevClose > 0)) return null;

  const o = parseNum(item.o);
  const h = parseNum(item.h);
  const l = parseNum(item.l);
  const change = round2(close - prevClose);
  const changePct = round2((change / prevClose) * 100);

  return {
    ok: true,
    date,
    time,
    close: round2(close),
    open: o > 0 ? round2(o) : null,
    high: h > 0 ? round2(h) : null,
    low: l > 0 ? round2(l) : null,
    prevClose: round2(prevClose),
    change,
    changePct,
    marketPhase: time >= '13:30:00' ? 'closed' : 'intraday',
    source: 'mis',
    fetchedAt: nowIso,
    stale: false,
  };
}

export function parseYahooTwLive(json, nowIso = new Date().toISOString()) {
  const chart = (Array.isArray(json) ? json[0] : json)?.chart;
  const meta = chart?.meta;
  const q = chart?.quote;
  if (!meta) return null;

  const close = parseNum(q?.price ?? meta.regularMarketPrice);
  const prevClose = parseNum(q?.previousClose ?? meta.previousClose ?? meta.chartPreviousClose);
  const ts = Number(meta.regularMarketTime);
  if (!(close > 0) || !(prevClose > 0) || !Number.isFinite(ts) || ts <= 0) return null;

  const { date, time: marketTime } = taipeiNowParts(new Date(ts * 1000));
  let time = marketTime;
  if (q?.refreshedTs && q?.marketStatus === 'open') {
    const refDate = new Date(q.refreshedTs);
    if (!Number.isNaN(refDate.getTime())) {
      const refParts = taipeiNowParts(refDate);
      if (refParts.date === date) time = refParts.time;
    }
  }

  const rawOpens = chart?.indicators?.quote?.[0]?.open;
  const firstBarOpen = Array.isArray(rawOpens) ? rawOpens.map(parseNum).find((v) => v > 0) : NaN;
  const o = parseNum(q?.openPrice) > 0 ? parseNum(q?.openPrice) : firstBarOpen;
  const h = parseNum(q?.dayHighPrice ?? meta.regularMarketDayHigh);
  const l = parseNum(q?.dayLowPrice ?? meta.regularMarketDayLow);

  const change = round2(close - prevClose);
  const changePct = round2((change / prevClose) * 100);
  const isClosed = (q?.marketStatus && q.marketStatus !== 'open') || time >= '13:30:00';

  return {
    ok: true,
    date,
    time,
    close: round2(close),
    open: o > 0 ? round2(o) : null,
    high: h > 0 ? round2(h) : null,
    low: l > 0 ? round2(l) : null,
    prevClose: round2(prevClose),
    change,
    changePct,
    marketPhase: isClosed ? 'closed' : 'intraday',
    source: 'yahoo_tw',
    fetchedAt: nowIso,
    stale: false,
  };
}

export function parseCnyesLive(json, nowIso = new Date().toISOString()) {
  const item = json?.data?.[0];
  if (!item) return null;

  const close = parseNum(item['6']);
  const prevClose = parseNum(item['21']);
  const ts = Number(item['200007']);
  if (!(close > 0) || !(prevClose > 0) || !Number.isFinite(ts) || ts <= 0) return null;

  const { date, time } = taipeiNowParts(new Date(ts * 1000));
  const o = parseNum(item['19']);
  const h = parseNum(item['12']);
  const l = parseNum(item['13']);
  const change = round2(close - prevClose);
  const changePct = round2((change / prevClose) * 100);

  return {
    ok: true,
    date,
    time,
    close: round2(close),
    open: o > 0 ? round2(o) : null,
    high: h > 0 ? round2(h) : null,
    low: l > 0 ? round2(l) : null,
    prevClose: round2(prevClose),
    change,
    changePct,
    marketPhase: time >= '13:30:00' ? 'closed' : 'intraday',
    source: 'cnyes',
    fetchedAt: nowIso,
    stale: false,
  };
}

export function parseYahooLive(json, nowIso = new Date().toISOString()) {
  const res = json?.chart?.result?.[0];
  const meta = res?.meta;
  if (!meta) return null;

  const close = parseNum(meta.regularMarketPrice);
  const prevClose = parseNum(meta.previousClose ?? meta.chartPreviousClose);
  const ts = Number(meta.regularMarketTime);
  if (!(close > 0) || !(prevClose > 0) || !Number.isFinite(ts) || ts <= 0) return null;

  const { date, time } = taipeiNowParts(new Date(ts * 1000));
  const rawOpens = res?.indicators?.quote?.[0]?.open;
  const firstOpen = Array.isArray(rawOpens) ? rawOpens.map(parseNum).find((v) => v > 0) : NaN;
  const o = parseNum(meta.regularMarketOpen) > 0 ? parseNum(meta.regularMarketOpen) : firstOpen;
  const h = parseNum(meta.regularMarketDayHigh);
  const l = parseNum(meta.regularMarketDayLow);

  const change = round2(close - prevClose);
  const changePct = round2((change / prevClose) * 100);

  return {
    ok: true,
    date,
    time,
    close: round2(close),
    open: o > 0 ? round2(o) : null,
    high: h > 0 ? round2(h) : null,
    low: l > 0 ? round2(l) : null,
    prevClose: round2(prevClose),
    change,
    changePct,
    marketPhase: time >= '13:30:00' ? 'closed' : 'intraday',
    source: 'yahoo',
    fetchedAt: nowIso,
    stale: false,
  };
}

/** 由多個即時來源挑出「交易日期最新、報價時間最新」的一筆；同分秒時以官方 MIS 優先 */
export function pickFreshestQuote(candidates) {
  const valid = (Array.isArray(candidates) ? candidates : []).filter((c) => c && c.ok && c.close > 0);
  if (!valid.length) return null;
  valid.sort((a, b) => {
    const byDate = String(b.date).localeCompare(String(a.date));
    if (byDate !== 0) return byDate;
    const byTime = String(b.time).localeCompare(String(a.time));
    if (byTime !== 0) return byTime;
    return (SOURCE_PRIORITY[b.source] || 0) - (SOURCE_PRIORITY[a.source] || 0);
  });
  return valid[0];
}

export function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  if (origin === 'https://ljwwei.github.io') return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;

  const custom = String(env?.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return custom.includes(origin);
}

export function buildCorsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (isAllowedOrigin(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

const NO_STORE = 'no-store, no-cache, must-revalidate';

function jsonResponse(payload, status, request, env, cacheControl = NO_STORE) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      ...buildCorsHeaders(request, env),
    },
  });
}

/** 成功的即時報價：瀏覽器不留存（max-age=0），共享快取（Cloudflare）最多 s-maxage 秒 */
const liveCacheControl = (ttl) => `public, max-age=0, s-maxage=${ttl}`;

/**
 * 所有上游請求的唯一出口：
 *  1. URL 尾端加防快取時間戳 `_=${Date.now()}`
 *  2. cf: { cacheTtl: 0, cacheEverything: false } 禁止 Cloudflare 出站快取
 *  3. 請求標頭 Cache-Control: no-cache（再加 Pragma）
 *  4. AbortSignal.timeout(800)：超過 0.8 秒直接放棄該來源
 */
async function fetchJsonWithTimeout(url, headers = {}) {
  const res = await fetch(withCacheBuster(url), {
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache', ...headers },
    cf: { cacheTtl: 0, cacheEverything: false },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchLiveFromUpstreams(nowIso) {
  // 三源同時並發；任何一家超過 0.8 秒或失敗都不會拖累其他來源，最後取「成交時間最新」的一筆
  const [yahooTwRes, cnyesRes, misRes] = await Promise.allSettled([
    fetchJsonWithTimeout(YAHOO_TW_URL, {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      Accept: 'application/json',
    }),
    fetchJsonWithTimeout(CNYES_TWSE_URL, {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      Accept: 'application/json',
      Referer: 'https://invest.cnyes.com/',
    }),
    fetchJsonWithTimeout(TWSE_MIS_URL, BROWSER_HEADERS),
  ]);

  const candidates = [];
  if (yahooTwRes.status === 'fulfilled') {
    const parsed = parseYahooTwLive(yahooTwRes.value, nowIso);
    if (parsed) candidates.push(parsed);
  } else {
    console.warn('Yahoo TW failed:', yahooTwRes.reason?.message ?? yahooTwRes.reason);
  }

  if (cnyesRes.status === 'fulfilled') {
    const parsed = parseCnyesLive(cnyesRes.value, nowIso);
    if (parsed) candidates.push(parsed);
  } else {
    console.warn('Cnyes failed:', cnyesRes.reason?.message ?? cnyesRes.reason);
  }

  if (misRes.status === 'fulfilled') {
    const parsed = parseMisLive(misRes.value, nowIso);
    if (parsed) candidates.push(parsed);
  } else {
    console.warn('TWSE MIS failed:', misRes.reason?.message ?? misRes.reason);
  }

  const best = pickFreshestQuote(candidates);
  if (best) return best;

  try {
    const yahooJson = await fetchJsonWithTimeout(YAHOO_TWII_URL, {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      Accept: 'application/json',
    });
    const parsedYahoo = parseYahooLive(yahooJson, nowIso);
    if (parsedYahoo) return parsedYahoo;
  } catch (err) {
    console.warn('Yahoo ^TWII failed:', err?.message ?? err);
  }

  return null;
}

function getEdgeCache() {
  return typeof caches !== 'undefined' && caches?.default ? caches.default : null;
}

function writeLiveCache(edgeCache, fresh, ttl) {
  const body = JSON.stringify(fresh);
  const mk = (cacheControl) =>
    new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl } });
  return Promise.all([
    edgeCache.put(CACHE_KEY_LIVE, mk(`public, max-age=${ttl}, s-maxage=${ttl}`)),
    edgeCache.put(CACHE_KEY_STALE, mk(`public, max-age=${STALE_TTL_SEC}`)),
  ]);
}

// 同一個 isolate 內，快取過期瞬間湧入的多個請求共用「同一輪」上游抓取，不會各打一輪三家 API
let inflightRefresh = null;

function refreshLive(edgeCache, ttl, ctx) {
  if (inflightRefresh) return inflightRefresh;

  const task = (async () => {
    const fresh = await fetchLiveFromUpstreams(new Date().toISOString());
    if (fresh && edgeCache) {
      const writes = writeLiveCache(edgeCache, fresh, ttl).catch((err) =>
        console.warn('Edge cache put failed:', err?.message ?? err),
      );
      if (ctx?.waitUntil) ctx.waitUntil(writes);
      else await writes;
    }
    return fresh;
  })();

  const tracked = task.finally(() => {
    if (inflightRefresh === tracked) inflightRefresh = null;
  });
  inflightRefresh = tracked;
  // 即使第一個觸發的訪客提前斷線，這一輪上游抓取仍會跑完，讓其他等待者拿到結果
  if (ctx?.waitUntil) ctx.waitUntil(tracked.catch(() => {}));
  return tracked;
}

async function handleTaiex(request, env, ctx) {
  const ttl = cacheTtlFor();
  const edgeCache = getEdgeCache();

  if (edgeCache) {
    const cached = await edgeCache.match(CACHE_KEY_LIVE);
    if (cached) {
      const data = await cached.json();
      return jsonResponse(data, 200, request, env, liveCacheControl(ttl));
    }
  }

  let fresh = null;
  try {
    fresh = await refreshLive(edgeCache, ttl, ctx);
  } catch (err) {
    console.warn('Live refresh failed:', err?.message ?? err);
  }

  if (fresh) {
    return jsonResponse(fresh, 200, request, env, liveCacheControl(ttl));
  }

  if (edgeCache) {
    const staleRes = await edgeCache.match(CACHE_KEY_STALE);
    if (staleRes) {
      const staleData = await staleRes.json();
      return jsonResponse({ ...staleData, stale: true }, 200, request, env);
    }
  }

  return jsonResponse({ ok: false, error: '暫時無法取得證交所或備援即時報價' }, 502, request, env);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: buildCorsHeaders(request, env) });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405, request, env);
    }

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return jsonResponse(
        {
          ok: true,
          service: 'cmoney-taiex',
          taipeiTime: taipeiNowParts(),
          intradayWindow: isWorkerIntradayWindow(),
        },
        200,
        request,
        env,
      );
    }

    if (url.pathname === '/' || url.pathname === '/api/taiex' || url.pathname === '/api/quote') {
      return handleTaiex(request, env, ctx);
    }

    return jsonResponse({ ok: false, error: 'Not Found' }, 404, request, env);
  },

  // 可選：若與既有盤後 Cron Trigger 共用同支 Worker，會一併喚醒 GitHub Actions workflow_dispatch
  async scheduled(event, env, ctx) {
    if (!env?.GITHUB_TOKEN || !env?.GITHUB_REPO) return;
    const workflow = env.GITHUB_WORKFLOW || 'update.yml';
    const ref = env.GITHUB_REF || 'main';
    const req = fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cmoney-cron-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref }),
    });
    if (ctx?.waitUntil) ctx.waitUntil(req);
    else await req;
  },
};
