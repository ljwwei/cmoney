// 富果（Fugle WebSocket + Intraday Quote）為主力、Yahoo（^TWII）為嚴格條件備援的單例行情核心
// 同時提供網站瀏覽人次計數（D1 優先，未綁定 D1 時自動退回 Durable Object 內建 SQLite）

export const FUGLE_REST_BASE = 'https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote';
export const FUGLE_WS_HTTP_URL = 'https://api.fugle.tw/marketdata/v1.0/stock/streaming';
export const FUGLE_WS_URL = 'wss://api.fugle.tw/marketdata/v1.0/stock/streaming';
export const DEFAULT_SYMBOL = 'IX0001';

export const YAHOO_TW_URL =
  'https://tw.stock.yahoo.com/_td-stock/api/resource/FinanceChartService.ApacLibraCharts;symbols=%5B%22%5ETWII%22%5D;type=tick';
export const YAHOO_CHART_URL =
  'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1m&range=1d';

export const YAHOO_TIMEOUT_MS = 2000;
export const YAHOO_POLL_INTRADAY_MS = 2500;
export const YAHOO_POLL_OFFHOURS_MS = 15000;

export const WS_FAILOVER_RETRIES = 3; // 連續重連失敗 3 次 → 啟用 Yahoo 備援
export const WS_FAILOVER_DISCONNECT_MS = 10000; // 斷線超過 10 秒 → 啟用 Yahoo 備援
export const WS_INTRADAY_SILENCE_MS = 12000; // 盤中超過 12 秒無資料與心跳 → 啟用 Yahoo 備援
export const WS_SILENCE_PING_MS = 8000; // 靜默 8 秒先主動送 ping 探測
export const WS_RECOVERY_INTERVAL_MS = 15000; // 備援期間每 15 秒背景嘗試回切富果
export const WS_COOLDOWN_1013_MS = 15000; // 遭遇 1013 連線數上限時冷卻至少 15 秒，絕不盲目重連
export const IDLE_RELEASE_MS = 30000; // 無任何前端 SSE 連線超過 30 秒 → 主動關閉富果 WS 釋放額度

const VISIT_KEY = 'cmoney_visits';

const YAHOO_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
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

/** 將微秒（16位數）、毫秒（13位數）、秒（10位數）或 ISO 字串統一轉成 Unix Timestamp 毫秒 */
export function normalizeEpochMs(raw) {
  if (raw == null || raw === '') return NaN;
  if (typeof raw === 'string' && !/^\d+(\.\d+)?$/.test(raw.trim())) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  if (n >= 1e14) return Math.floor(n / 1000); // 微秒 → 毫秒
  if (n >= 1e11) return Math.trunc(n); // 毫秒
  return Math.trunc(n * 1000); // 秒 → 毫秒
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

/** 台股盤中核心時段（09:00:00 ～ 13:30:00） */
export function isTaiwanIntraday(now = new Date()) {
  const { dow, time } = taipeiNowParts(now);
  if (dow === 0 || dow === 6) return false;
  return time >= '09:00:00' && time <= '13:30:00';
}

export function withYahooCacheBuster(url, ts = Date.now()) {
  return `${url}${String(url).includes('?') ? '&' : '?_c=1&'}_=${ts}`;
}

/**
 * 單調時間戳防呆：只有「新報價實際成交時間 > latestQuoteTimestamp」才允許採用，
 * 直接丟棄重複或較舊的快取資料。
 */
export function shouldAcceptQuote(latestQuoteTimestamp, incoming) {
  if (!incoming || !(incoming.close > 0)) return false;
  if (!Number.isFinite(incoming.timestampMs) || incoming.timestampMs <= 0) return false;
  return incoming.timestampMs > Number(latestQuoteTimestamp || 0);
}

/** 解析富果 Intraday Quote REST API 回應 */
export function parseFugleSnapshot(json) {
  if (!json || typeof json !== 'object') return null;
  const close = parseNum(json.lastPrice ?? json.closePrice ?? json.index ?? json.referencePrice);
  if (!(close > 0)) return null;

  const timestampMs = normalizeEpochMs(
    json.lastUpdated ?? json.lastTrade?.time ?? json.closeTime ?? json.total?.time ?? json.openTime,
  );
  if (!Number.isFinite(timestampMs)) return null;

  const { date: tsDate, time } = taipeiNowParts(new Date(timestampMs));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(json.date || '')) ? json.date : tsDate;

  const prevClose = parseNum(json.previousClose ?? json.referencePrice);
  const open = parseNum(json.openPrice);
  const high = parseNum(json.highPrice);
  const low = parseNum(json.lowPrice);

  let change = parseNum(json.change);
  let changePct = parseNum(json.changePercent);
  if (prevClose > 0) {
    if (!Number.isFinite(change)) change = round2(close - prevClose);
    if (!Number.isFinite(changePct)) changePct = round2((change / prevClose) * 100);
  }

  return {
    ok: true,
    symbol: json.symbol || DEFAULT_SYMBOL,
    date,
    time,
    timestampMs,
    close: round2(close),
    open: open > 0 ? round2(open) : null,
    high: high > 0 ? round2(high) : null,
    low: low > 0 ? round2(low) : null,
    prevClose: prevClose > 0 ? round2(prevClose) : null,
    change: Number.isFinite(change) ? round2(change) : null,
    changePct: Number.isFinite(changePct) ? round2(changePct) : null,
    marketPhase: json.isClose || time >= '13:30:00' ? 'closed' : 'intraday',
    source: 'fugle',
  };
}

/** 解析富果 WebSocket indices / trades 推播，並與同交易日快照合併開盤／最高／最低與漲跌 */
export function parseFugleWsTick(msg, snapshot = null, prevQuote = null) {
  if (!msg || msg.event !== 'data' || !msg.data) return null;
  const d = msg.data;
  const close = parseNum(d.index ?? d.price ?? d.lastPrice ?? d.closePrice);
  if (!(close > 0)) return null;

  const timestampMs = normalizeEpochMs(d.time ?? d.lastUpdated);
  if (!Number.isFinite(timestampMs)) return null;

  const { date, time } = taipeiNowParts(new Date(timestampMs));
  const snapSameDay = snapshot && snapshot.date === date ? snapshot : null;
  const prevSameDay = prevQuote && prevQuote.date === date ? prevQuote : null;

  const prevClose =
    snapSameDay?.prevClose > 0
      ? snapSameDay.prevClose
      : prevSameDay?.prevClose > 0
        ? prevSameDay.prevClose
        : null;
  const open =
    snapSameDay?.open > 0
      ? snapSameDay.open
      : prevSameDay?.open > 0
        ? prevSameDay.open
        : round2(close);
  const high = Math.max(snapSameDay?.high || 0, prevSameDay?.high || 0, round2(close));
  const lows = [snapSameDay?.low, prevSameDay?.low, round2(close)].filter((v) => v > 0);
  const low = lows.length ? Math.min(...lows) : round2(close);

  const change = prevClose > 0 ? round2(close - prevClose) : null;
  const changePct = prevClose > 0 ? round2((change / prevClose) * 100) : null;

  return {
    ok: true,
    symbol: d.symbol || snapSameDay?.symbol || DEFAULT_SYMBOL,
    date,
    time,
    timestampMs,
    close: round2(close),
    open: round2(open),
    high: round2(high),
    low: round2(low),
    prevClose: prevClose > 0 ? round2(prevClose) : null,
    change,
    changePct,
    marketPhase: time >= '13:30:00' ? 'closed' : 'intraday',
    source: 'fugle',
  };
}

/** 解析 Yahoo ^TWII 備援回應（同時相容 Yahoo 奇摩 ApacLibraCharts 與 Yahoo Finance v8 Chart） */
export function parseYahooBackup(json) {
  const chart = (Array.isArray(json) ? json[0]?.chart : json?.chart?.result?.[0]) ?? null;
  const meta = chart?.meta;
  if (!meta) return null;

  const q = chart.quote;
  const close = parseNum(q?.price ?? meta.regularMarketPrice);
  const prevClose = parseNum(q?.previousClose ?? meta.previousClose ?? meta.chartPreviousClose);
  if (!(close > 0) || !(prevClose > 0)) return null;

  const marketMs = normalizeEpochMs(meta.regularMarketTime);
  if (!Number.isFinite(marketMs)) return null;
  const marketParts = taipeiNowParts(new Date(marketMs));

  let timestampMs = marketMs;
  if (q?.refreshedTs && q?.marketStatus === 'open') {
    const refMs = normalizeEpochMs(q.refreshedTs);
    if (Number.isFinite(refMs) && taipeiNowParts(new Date(refMs)).date === marketParts.date) {
      timestampMs = refMs;
    }
  }

  const { date, time } = taipeiNowParts(new Date(timestampMs));
  const barOpens = chart?.indicators?.quote?.[0]?.open;
  const firstBarOpen = Array.isArray(barOpens) ? barOpens.map(parseNum).find((v) => v > 0) : NaN;
  const open = parseNum(q?.openPrice ?? meta.regularMarketOpen) > 0
    ? parseNum(q?.openPrice ?? meta.regularMarketOpen)
    : firstBarOpen;
  const high = parseNum(q?.dayHighPrice ?? meta.regularMarketDayHigh);
  const low = parseNum(q?.dayLowPrice ?? meta.regularMarketDayLow);
  const change = round2(close - prevClose);
  const changePct = round2((change / prevClose) * 100);
  const isClosed = (q?.marketStatus && q.marketStatus !== 'open') || time >= '13:30:00';

  return {
    ok: true,
    symbol: '^TWII',
    date,
    time,
    timestampMs,
    close: round2(close),
    open: open > 0 ? round2(open) : null,
    high: high > 0 ? round2(high) : null,
    low: low > 0 ? round2(low) : null,
    prevClose: round2(prevClose),
    change,
    changePct,
    marketPhase: isClosed ? 'closed' : 'intraday',
    source: 'yahoo',
  };
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (isAllowedOrigin(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function jsonResponse(payload, status, request, env) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...buildCorsHeaders(request, env),
    },
  });
}

function taipeiDateTimeString(now = new Date()) {
  const { date, time } = taipeiNowParts(now);
  return `${date} ${time}`;
}

/* ========================================================
   累積瀏覽總人次（與民德市政府官網同規格：D1 優先，備用 DO SQLite）
   ======================================================== */
const d1Ready = new WeakSet();

async function ensureD1VisitsSchema(db) {
  if (!db || d1Ready.has(db)) return;
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS site_counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)',
  ).run();
  await db
    .prepare('INSERT OR IGNORE INTO site_counters (key, value, updated_at) VALUES (?, ?, ?)')
    .bind(VISIT_KEY, 0, taipeiDateTimeString())
    .run();
  d1Ready.add(db);
}

export async function handleD1Visits(db, increment = false) {
  await ensureD1VisitsSchema(db);
  if (increment) {
    const now = taipeiDateTimeString();
    const upd = await db
      .prepare('UPDATE site_counters SET value = value + 1, updated_at = ? WHERE key = ?')
      .bind(now, VISIT_KEY)
      .run();
    if (!upd?.meta?.changes) {
      await db
        .prepare('INSERT OR IGNORE INTO site_counters (key, value, updated_at) VALUES (?, ?, ?)')
        .bind(VISIT_KEY, 1, now)
        .run();
    }
  }
  const row = await db.prepare('SELECT value FROM site_counters WHERE key = ? LIMIT 1').bind(VISIT_KEY).first();
  return Number(row?.value || 0);
}

/* ========================================================
   FugleHub 單例核心引擎（維持唯一一條富果 WS + Yahoo 備援 + SSE 廣播）
   ======================================================== */
export class FugleHubEngine {
  constructor(opts = {}) {
    this.env = opts.env || {};
    this.sql = opts.sql || null;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis);
    this.connectWsImpl = opts.connectWsImpl || ((url, signal) => defaultCloudflareWsConnect(this.fetchImpl, url, signal));
    this.nowFn = opts.nowFn || (() => Date.now());
    this.setTimeoutFn = opts.setTimeoutFn || globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = opts.clearTimeoutFn || globalThis.clearTimeout.bind(globalThis);
    this.setIntervalFn = opts.setIntervalFn || globalThis.setInterval.bind(globalThis);
    this.clearIntervalFn = opts.clearIntervalFn || globalThis.clearInterval.bind(globalThis);

    this.symbol = String(this.env.FUGLE_SYMBOL || DEFAULT_SYMBOL).trim() || DEFAULT_SYMBOL;
    this.mode = this.env.FUGLE_API_KEY ? 'fugle' : 'yahoo';
    this.backupReason = this.env.FUGLE_API_KEY ? null : 'no_api_key';

    this.ws = null;
    this.wsStatus = 'idle'; // 'idle' | 'connecting' | 'open' | 'authenticated'
    this.intentionalClose = false;
    this.wsAttemptEpoch = 0;

    this.snapshot = null;
    this.latestQuote = null;
    this.latestQuoteTimestamp = 0;

    this.consecutiveFailures = 0;
    this.disconnectedSince = 0;
    this.lastFugleActivityAt = 0;
    this.pingSentAt = 0;
    this.lastCloseCode = null;
    this.cooldownUntil1013 = 0;

    this.reconnectTimer = null;
    this.yahooPollTimer = null;
    this.yahooInFlight = false;
    this.recoveryTimer = null;
    this.healthTimer = null;
    this.idleTimer = null;
    this.ssePingTimer = null;

    this.sseClients = new Set();
    this.sqlReady = false;
  }

  hasApiKey() {
    return Boolean(String(this.env?.FUGLE_API_KEY || '').trim());
  }

  ensureSqlVisitsSchema() {
    if (!this.sql || this.sqlReady) return;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS site_counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)',
    );
    this.sql.exec(
      'INSERT OR IGNORE INTO site_counters (key, value, updated_at) VALUES (?, ?, ?)',
      VISIT_KEY,
      0,
      taipeiDateTimeString(new Date(this.nowFn())),
    );
    this.sqlReady = true;
  }

  handleSqlVisits(increment = false) {
    this.ensureSqlVisitsSchema();
    if (increment) {
      this.sql.exec(
        'UPDATE site_counters SET value = value + 1, updated_at = ? WHERE key = ?',
        taipeiDateTimeString(new Date(this.nowFn())),
        VISIT_KEY,
      );
    }
    const rows = [...this.sql.exec('SELECT value FROM site_counters WHERE key = ? LIMIT 1', VISIT_KEY)];
    return Number(rows[0]?.value || 0);
  }

  getStatusSnapshot() {
    return {
      ok: true,
      mode: this.mode,
      backupReason: this.backupReason,
      wsStatus: this.wsStatus,
      symbol: this.symbol,
      hasApiKey: this.hasApiKey(),
      latestQuoteTimestamp: this.latestQuoteTimestamp,
      consecutiveFailures: this.consecutiveFailures,
      lastCloseCode: this.lastCloseCode,
      sseClients: this.sseClients.size,
      quote: this.latestQuote,
    };
  }

  broadcastSse(eventName, payload) {
    const text = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of [...this.sseClients]) {
      try {
        client.write(text);
      } catch {
        this.removeSseClient(client);
      }
    }
  }

  broadcastComment(comment) {
    const text = `: ${comment}\n\n`;
    for (const client of [...this.sseClients]) {
      try {
        client.write(text);
      } catch {
        this.removeSseClient(client);
      }
    }
  }

  applyQuote(quote) {
    if (!shouldAcceptQuote(this.latestQuoteTimestamp, quote)) return false;
    this.latestQuoteTimestamp = quote.timestampMs;
    this.latestQuote = quote;
    this.broadcastSse('quote', quote);
    return true;
  }

  async refreshFugleSnapshot() {
    const apiKey = String(this.env?.FUGLE_API_KEY || '').trim();
    if (!apiKey) return null;
    const ctrl = new AbortController();
    const timer = this.setTimeoutFn(() => ctrl.abort(), 3000);
    try {
      const url = `${FUGLE_REST_BASE}/${encodeURIComponent(this.symbol)}`;
      const res = await this.fetchImpl(url, {
        headers: { 'X-API-KEY': apiKey, Accept: 'application/json', 'Cache-Control': 'no-cache' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Fugle REST HTTP ${res.status}`);
      const json = await res.json();
      const parsed = parseFugleSnapshot(json);
      if (parsed) {
        this.snapshot = parsed;
        this.applyQuote(parsed);
      }
      return parsed;
    } catch (err) {
      console.warn('Fugle snapshot failed:', err?.message ?? err);
      return null;
    } finally {
      this.clearTimeoutFn(timer);
    }
  }

  /** Singleton 入口：保證同時只啟動一條富果 WS 與監控排程 */
  async ensureStarted() {
    this.clearTimer('idleTimer');
    this.startHealthLoop();

    if (!this.hasApiKey()) {
      this.enterYahooBackup('no_api_key');
      if (!this.latestQuote) await this.pollYahooOnce();
      return;
    }

    const needSnapshot = !this.snapshot || this.snapshot.date !== taipeiNowParts(new Date(this.nowFn())).date;
    const snapPromise = needSnapshot ? this.refreshFugleSnapshot() : Promise.resolve(this.snapshot);

    if (this.mode === 'fugle') {
      await Promise.all([snapPromise, this.connectFugle()]);
    } else {
      await snapPromise;
      this.ensureYahooPolling();
      this.ensureRecoveryLoop();
    }
  }

  clearTimer(prop) {
    if (this[prop] != null) {
      this.clearTimeoutFn(this[prop]);
      this[prop] = null;
    }
  }

  /** 建立唯一一條富果 WebSocket 連線（嚴禁重複開啟） */
  async connectFugle() {
    const apiKey = String(this.env?.FUGLE_API_KEY || '').trim();
    if (!apiKey) return false;
    if (['connecting', 'open', 'authenticated'].includes(this.wsStatus) || this.ws) {
      return false; // Singleton 守門：連線中或已連線皆嚴禁再開第 2 條
    }

    const now = this.nowFn();
    if (this.lastCloseCode === 1013 && now < this.cooldownUntil1013) {
      return false;
    }

    this.clearTimer('reconnectTimer');
    const epoch = ++this.wsAttemptEpoch;
    this.wsStatus = 'connecting';
    this.intentionalClose = false;

    const ctrl = new AbortController();
    const timer = this.setTimeoutFn(() => ctrl.abort(), 5000);
    let sock;
    try {
      sock = await this.connectWsImpl(FUGLE_WS_HTTP_URL, ctrl.signal);
    } catch (err) {
      this.clearTimeoutFn(timer);
      if (epoch === this.wsAttemptEpoch) {
        this.ws = null;
        this.wsStatus = 'idle';
        this.onFugleFailure(null, err?.message ?? 'ws_connect_error');
      }
      return false;
    }
    this.clearTimeoutFn(timer);

    if (epoch !== this.wsAttemptEpoch) {
      try {
        sock.close(1000, 'superseded');
      } catch {}
      return false;
    }

    this.ws = sock;
    this.wsStatus = 'open';
    this.lastFugleActivityAt = this.nowFn();
    this.pingSentAt = 0;

    sock.addEventListener('message', (ev) => this.handleFugleMessage(ev?.data, sock));
    sock.addEventListener('close', (ev) => this.handleFugleClose(ev?.code ?? 1006, sock));
    sock.addEventListener('error', () => {
      if (this.ws === sock) this.onFugleFailure(null, 'ws_error');
    });

    try {
      sock.send(JSON.stringify({ event: 'auth', data: { apikey: apiKey } }));
    } catch (err) {
      this.handleFugleClose(1006, sock);
      return false;
    }
    return true;
  }

  handleFugleMessage(raw, sock) {
    if (this.ws !== sock) return;
    let msg;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return;
    }

    this.lastFugleActivityAt = this.nowFn();
    this.pingSentAt = 0;

    if (msg.event === 'authenticated') {
      this.wsStatus = 'authenticated';
      const channel = this.symbol.startsWith('IX') ? 'indices' : 'trades';
      try {
        sock.send(JSON.stringify({ event: 'subscribe', data: { channel, symbol: this.symbol } }));
      } catch {
        this.handleFugleClose(1006, sock);
      }
      return;
    }

    if (msg.event === 'subscribed') {
      // 若背景回復已通過 auth/subscribe，且富果快照已有不落後於現況的有效報價，可直接回切主力
      if (
        this.mode === 'yahoo' &&
        this.snapshot &&
        this.snapshot.close > 0 &&
        this.snapshot.timestampMs >= this.latestQuoteTimestamp
      ) {
        this.consecutiveFailures = 0;
        this.disconnectedSince = 0;
        this.lastCloseCode = null;
        this.exitYahooBackupToFugle();
      }
      return;
    }

    if (msg.event === 'heartbeat' || msg.event === 'pong') {
      return;
    }

    if (msg.event === 'error') {
      const code = Number(msg.data?.code ?? msg.code);
      const errText = String(msg.data?.message || msg.message || '');
      if (code === 1013 || /1013|maximum number of connections/i.test(errText)) {
        this.lastCloseCode = 1013;
        this.cooldownUntil1013 = this.nowFn() + WS_COOLDOWN_1013_MS;
        this.closeActiveWs(1000, '1013_backoff');
        this.enterYahooBackup('close_1013');
      }
      return;
    }

    if (msg.event === 'data') {
      const parsed = parseFugleWsTick(msg, this.snapshot, this.latestQuote);
      if (!parsed) return;

      // 跨日開盤的第一筆推播若早於快照更新，背景同步今日 Intraday Quote 以取得精準開盤與昨收
      if (!this.snapshot || this.snapshot.date !== parsed.date) {
        this.refreshFugleSnapshot();
      }

      this.consecutiveFailures = 0;
      this.disconnectedSince = 0;
      this.lastCloseCode = null;
      if (this.mode !== 'fugle') {
        this.exitYahooBackupToFugle();
      }
      this.applyQuote(parsed);
    }
  }

  handleFugleClose(code, sock) {
    if (this.ws !== sock) return;
    this.ws = null;
    this.wsStatus = 'idle';
    if (this.intentionalClose) {
      this.intentionalClose = false;
      return;
    }
    this.onFugleFailure(code, `ws_close_${code}`);
  }

  closeActiveWs(code = 1000, reason = 'close') {
    const sock = this.ws;
    this.ws = null;
    this.wsStatus = 'idle';
    if (!sock) return;
    this.intentionalClose = true;
    try {
      sock.close(code, reason);
    } catch {}
  }

  onFugleFailure(code, reason) {
    const now = this.nowFn();
    if (code) this.lastCloseCode = code;
    if (!this.disconnectedSince) this.disconnectedSince = now;
    this.consecutiveFailures += 1;

    if (code === 1013) {
      this.cooldownUntil1013 = now + WS_COOLDOWN_1013_MS;
      this.enterYahooBackup('close_1013');
      return;
    }

    const disconnectedMs = now - this.disconnectedSince;
    if (this.consecutiveFailures >= WS_FAILOVER_RETRIES || disconnectedMs > WS_FAILOVER_DISCONNECT_MS) {
      this.enterYahooBackup(reason);
      return;
    }

    // 仍在 3 次 / 10 秒門檻內：不啟動 Yahoo，等待 3 秒後進行下一輪重連
    if (this.mode === 'fugle' && !this.reconnectTimer) {
      this.reconnectTimer = this.setTimeoutFn(() => {
        this.reconnectTimer = null;
        if (this.mode === 'fugle') this.connectFugle();
      }, 3000);
    }
  }

  enterYahooBackup(reason = 'fallback') {
    const changed = this.mode !== 'yahoo' || this.backupReason !== reason;
    this.mode = 'yahoo';
    this.backupReason = reason;
    this.clearTimer('reconnectTimer');

    if (changed) {
      this.broadcastSse('status', { mode: 'yahoo', reason });
    }
    this.ensureYahooPolling();
    if (this.hasApiKey()) {
      this.ensureRecoveryLoop();
    }
  }

  exitYahooBackupToFugle() {
    this.mode = 'fugle';
    this.backupReason = null;
    this.clearTimer('yahooPollTimer');
    this.clearTimer('recoveryTimer');
    this.broadcastSse('status', { mode: 'fugle', reason: 'recovered' });
  }

  /** 僅在 Yahoo 備援模式下啟動遞迴 setTimeout 輪詢（禁止 setInterval 造成請求堆積） */
  ensureYahooPolling() {
    if (this.mode !== 'yahoo' || this.yahooPollTimer) return;
    this.scheduleYahooPoll(0);
  }

  scheduleYahooPoll(delayMs) {
    this.clearTimer('yahooPollTimer');
    if (this.mode !== 'yahoo') return;
    this.yahooPollTimer = this.setTimeoutFn(async () => {
      this.yahooPollTimer = null;
      if (this.mode !== 'yahoo') return;
      await this.pollYahooOnce();
      if (this.mode === 'yahoo') {
        const nextDelay = isTaiwanIntraday(new Date(this.nowFn()))
          ? YAHOO_POLL_INTRADAY_MS
          : YAHOO_POLL_OFFHOURS_MS;
        this.scheduleYahooPoll(nextDelay);
      }
    }, delayMs);
  }

  async pollYahooOnce() {
    if (this.yahooInFlight) return null;
    this.yahooInFlight = true;
    const ctrl = new AbortController();
    const timer = this.setTimeoutFn(() => ctrl.abort(), YAHOO_TIMEOUT_MS);

    try {
      const ts = this.nowFn();
      const urls = [withYahooCacheBuster(YAHOO_TW_URL, ts), withYahooCacheBuster(YAHOO_CHART_URL, ts)];
      for (const u of urls) {
        try {
          const res = await this.fetchImpl(u, { headers: YAHOO_HEADERS, signal: ctrl.signal });
          if (!res.ok) continue;
          const json = await res.json();
          const parsed = parseYahooBackup(json);
          if (parsed) {
            this.applyQuote(parsed);
            return parsed;
          }
        } catch (err) {
          if (ctrl.signal.aborted) throw err;
        }
      }
      return null;
    } catch (err) {
      console.warn('Yahoo backup poll failed:', err?.message ?? err);
      return null;
    } finally {
      this.clearTimeoutFn(timer);
      this.yahooInFlight = false;
    }
  }

  /** 進入 Yahoo 備援後，每 15 秒於背景嘗試重建富果 WebSocket */
  ensureRecoveryLoop() {
    if (!this.hasApiKey() || this.mode !== 'yahoo' || this.recoveryTimer) return;
    const scheduleNext = () => {
      this.clearTimer('recoveryTimer');
      if (this.mode !== 'yahoo' || !this.hasApiKey()) return;
      this.recoveryTimer = this.setTimeoutFn(async () => {
        this.recoveryTimer = null;
        if (this.mode !== 'yahoo' || !this.hasApiKey()) return;
        await this.refreshFugleSnapshot();
        await this.connectFugle();
        if (this.mode === 'yahoo') scheduleNext();
      }, WS_RECOVERY_INTERVAL_MS);
    };
    scheduleNext();
  }

  startHealthLoop() {
    if (this.healthTimer) return;
    this.healthTimer = this.setIntervalFn(() => this.checkHealth(), 2000);
    if (!this.ssePingTimer) {
      this.ssePingTimer = this.setIntervalFn(() => {
        if (this.sseClients.size > 0) this.broadcastComment('keepalive');
      }, 25000);
    }
  }

  checkHealth() {
    const now = this.nowFn();
    if (!this.hasApiKey()) {
      if (this.mode !== 'yahoo') this.enterYahooBackup('no_api_key');
      return;
    }

    if (this.mode === 'fugle') {
      if (this.wsStatus === 'idle' && this.disconnectedSince > 0 && now - this.disconnectedSince > WS_FAILOVER_DISCONNECT_MS) {
        this.enterYahooBackup('disconnect_over_10s');
        return;
      }

      if (isTaiwanIntraday(new Date(now)) && this.wsStatus !== 'idle') {
        const silence = now - (this.lastFugleActivityAt || now);
        if (silence > WS_INTRADAY_SILENCE_MS) {
          this.closeActiveWs(1000, 'silence_12s');
          this.enterYahooBackup('intraday_silence_12s');
          return;
        }
        if (silence >= WS_SILENCE_PING_MS && this.wsStatus === 'authenticated' && this.ws && !this.pingSentAt) {
          this.pingSentAt = now;
          try {
            this.ws.send(JSON.stringify({ event: 'ping', data: { state: 'hc' } }));
          } catch {}
        }
      }
    }
  }

  addSseClient(client) {
    this.clearTimer('idleTimer');
    this.sseClients.add(client);
  }

  removeSseClient(client) {
    this.sseClients.delete(client);
    try {
      client.close?.();
    } catch {}

    if (this.sseClients.size === 0 && !this.idleTimer) {
      this.idleTimer = this.setTimeoutFn(() => {
        this.idleTimer = null;
        if (this.sseClients.size === 0) this.shutdownIdle();
      }, IDLE_RELEASE_MS);
    }
  }

  shutdownIdle() {
    this.clearTimer('reconnectTimer');
    this.clearTimer('yahooPollTimer');
    this.clearTimer('recoveryTimer');
    if (this.healthTimer != null) {
      this.clearIntervalFn(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.ssePingTimer != null) {
      this.clearIntervalFn(this.ssePingTimer);
      this.ssePingTimer = null;
    }
    this.closeActiveWs(1000, 'idle_release');
  }

  async handleFetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/internal/stats/visits') {
      const visits = this.handleSqlVisits(request.method === 'POST');
      return new Response(JSON.stringify({ ok: true, visits }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    if (url.pathname === '/internal/status') {
      return new Response(JSON.stringify(this.getStatusSnapshot()), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    await this.ensureStarted();

    if (url.pathname === '/api/stream') {
      const encoder = new TextEncoder();
      let clientHandle = null;
      const stream = new ReadableStream({
        start: (controller) => {
          clientHandle = {
            write: (text) => controller.enqueue(encoder.encode(text)),
            close: () => {
              try {
                controller.close();
              } catch {}
            },
          };
          this.addSseClient(clientHandle);
          clientHandle.write(`event: status\ndata: ${JSON.stringify({ mode: this.mode, reason: this.backupReason })}\n\n`);
          if (this.latestQuote) {
            clientHandle.write(`event: quote\ndata: ${JSON.stringify(this.latestQuote)}\n\n`);
          }
          request.signal?.addEventListener('abort', () => this.removeSseClient(clientHandle), { once: true });
        },
        cancel: () => {
          if (clientHandle) this.removeSseClient(clientHandle);
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Connection: 'keep-alive',
          ...buildCorsHeaders(request, this.env),
        },
      });
    }

    if (!this.latestQuote && this.hasApiKey()) {
      await this.refreshFugleSnapshot();
    }
    if (!this.latestQuote) {
      await this.pollYahooOnce();
    }

    if (this.latestQuote) {
      return jsonResponse(this.latestQuote, 200, request, this.env);
    }
    return jsonResponse({ ok: false, error: '暫時無法取得即時行情' }, 502, request, this.env);
  }
}

async function defaultCloudflareWsConnect(fetchImpl, url, signal) {
  const res = await fetchImpl(url, { headers: { Upgrade: 'websocket' }, signal });
  const ws = res?.webSocket;
  if (!ws) throw new Error(`WebSocket upgrade failed (HTTP ${res?.status ?? '?'})`);
  ws.accept();
  return ws;
}

/* ========================================================
   臺南市氣溫（中央氣象署 467410 臺南站 10 分鐘更新）與臺南測站 AQI（環境部）
   API Key 僅由 Cloudflare Worker Secrets 讀取，不暴露於前端
   ======================================================== */
export const CWA_OBS_AUTO_URL = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001';
export const CWA_OBS_SYNOPTIC_URL = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0003-001';
export const MOENV_AQI_URL = 'https://data.moenv.gov.tw/api/v2/aqx_p_432';
export const CWA_TAINAN_STATION_ID = '467410'; // 臺南氣象站（每 10 分鐘一筆）
export const CWA_NORTH_STATION_ID = 'C0X100'; // 臺南市北區自動氣象站（備援）
export const CWA_TAINAN_FALLBACK_ID = '467410';
export const MOENV_TAINAN_SITE = '臺南';
export const WEATHER_CACHE_TTL_SEC = 180; // 3 分鐘邊緣快取，對齊雙站每 3 分鐘更新一次
const WEATHER_EDGE_CACHE_KEY = 'https://cache.cmoney.local/api/weather-v3';

export function computeAqiStatus(aqi) {
  if (aqi <= 50) return '良好';
  if (aqi <= 100) return '普通';
  if (aqi <= 150) return '對敏感族群不健康';
  if (aqi <= 200) return '對所有族群不健康';
  if (aqi <= 300) return '非常不健康';
  return '危害';
}

export function parseCwaTemperature(json, preferredId = CWA_TAINAN_STATION_ID) {
  const rec = json?.records;
  const list = rec?.Station || rec?.station;
  if (!Array.isArray(list) || !list.length) return null;
  const st = list.find((item) => (item?.StationId ?? item?.stationId) === preferredId) || list[0];
  const we = st?.WeatherElement || st?.weatherElement;
  const rawTemp = we?.AirTemperature ?? we?.airTemperature;
  const temp = parseNum(rawTemp);
  if (!Number.isFinite(temp) || temp <= -90 || temp > 65) return null;
  const obs = st?.ObsTime || st?.obsTime;
  const tempObsTime = String(obs?.DateTime ?? obs?.dateTime ?? '').trim();
  const station = String(st?.StationName ?? st?.stationName ?? '臺南').trim();
  return {
    station,
    stationId: String(st?.StationId ?? st?.stationId ?? preferredId).trim(),
    temperature: Math.round(temp * 10) / 10,
    tempObsTime,
  };
}

export function parseMoenvAqi(json, siteName = MOENV_TAINAN_SITE) {
  const list = Array.isArray(json) ? json : json?.records;
  if (!Array.isArray(list) || !list.length) return null;
  const rec = list.find((r) => (r?.sitename ?? r?.SiteName) === siteName) || list[0];
  const aqi = parseInt(rec?.aqi ?? rec?.AQI, 10);
  if (!Number.isFinite(aqi) || aqi < 0 || aqi > 1000) return null;
  const aqiStatus = String(rec?.status ?? rec?.Status ?? '').trim() || computeAqiStatus(aqi);
  const aqiPublishTime = String(rec?.publishtime ?? rec?.PublishTime ?? '').trim();
  const aqiSite = String(rec?.sitename ?? rec?.SiteName ?? siteName).trim();
  return { aqiSite, aqi, aqiStatus, aqiPublishTime };
}

async function fetchJsonWithTimeout(fetchImpl, url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const defaultWeatherState = { inFlight: null, lastGood: null };

export async function fetchWeatherReport(
  env,
  { fetchImpl = globalThis.fetch.bind(globalThis), state = defaultWeatherState } = {},
) {
  const cwaKey = String(env?.CWA_API_KEY || '').trim();
  const moenvKey = String(env?.MOENV_API_KEY || '').trim();
  const stationId = String(env?.CWA_STATION_ID || CWA_TAINAN_STATION_ID).trim() || CWA_TAINAN_STATION_ID;
  const siteName = String(env?.MOENV_SITE_NAME || MOENV_TAINAN_SITE).trim() || MOENV_TAINAN_SITE;

  const missingKeys = [];
  if (!cwaKey) missingKeys.push('CWA_API_KEY');
  if (!moenvKey) missingKeys.push('MOENV_API_KEY');

  const fetchTemp = async () => {
    if (!cwaKey) return null;
    // 直接查詢 O-A0003-001（467410 臺南氣象站，每 10 分鐘一筆）
    const tenMinPrimaryUrl = `${CWA_OBS_SYNOPTIC_URL}?Authorization=${encodeURIComponent(cwaKey)}&StationId=${encodeURIComponent(stationId)}&format=JSON`;
    try {
      const json = await fetchJsonWithTimeout(fetchImpl, tenMinPrimaryUrl, 5000);
      const parsed = parseCwaTemperature(json, stationId);
      if (parsed) return parsed;
    } catch {}
    // 備援：退回 O-A0001-001（C0X100 臺南市北區）
    const fbId = stationId === CWA_TAINAN_STATION_ID ? CWA_NORTH_STATION_ID : stationId;
    try {
      const hourlyUrl = `${CWA_OBS_AUTO_URL}?Authorization=${encodeURIComponent(cwaKey)}&StationId=${encodeURIComponent(fbId)}&format=JSON`;
      const json = await fetchJsonWithTimeout(fetchImpl, hourlyUrl, 5000);
      return parseCwaTemperature(json, fbId);
    } catch {
      return null;
    }
  };

  const fetchAqi = async () => {
    if (!moenvKey) return null;
    try {
      const url = `${MOENV_AQI_URL}?api_key=${encodeURIComponent(moenvKey)}&limit=10&format=json&filters=${encodeURIComponent(`sitename,EQ,${siteName}`)}`;
      const json = await fetchJsonWithTimeout(fetchImpl, url, 5000);
      return parseMoenvAqi(json, siteName);
    } catch {
      return null;
    }
  };

  const [tempRes, aqiRes] = await Promise.allSettled([fetchTemp(), fetchAqi()]);
  const tempData = tempRes.status === 'fulfilled' ? tempRes.value : null;
  const aqiData = aqiRes.status === 'fulfilled' ? aqiRes.value : null;

  const prev =
    state?.lastGood && state.lastGood.requestedStation === stationId && state.lastGood.requestedSite === siteName
      ? state.lastGood.payload
      : null;

  const payload = {
    ok: Boolean(tempData || aqiData || prev),
    station: tempData?.station ?? prev?.station ?? '臺南',
    stationId: tempData?.stationId ?? prev?.stationId ?? stationId,
    temperature: tempData ? tempData.temperature : prev?.temperature ?? null,
    tempObsTime: tempData ? tempData.tempObsTime : prev?.tempObsTime ?? '',
    aqiSite: aqiData?.aqiSite ?? prev?.aqiSite ?? siteName,
    aqi: aqiData ? aqiData.aqi : prev?.aqi ?? null,
    aqiStatus: aqiData ? aqiData.aqiStatus : prev?.aqiStatus ?? '',
    aqiPublishTime: aqiData ? aqiData.aqiPublishTime : prev?.aqiPublishTime ?? '',
    missingKeys,
    updatedAt: new Date().toISOString(),
  };

  if (state && (tempData || aqiData)) {
    state.lastGood = { requestedStation: stationId, requestedSite: siteName, payload };
  }
  return payload;
}

export async function handleWeatherRequest(
  request,
  env,
  {
    fetchImpl = globalThis.fetch.bind(globalThis),
    cacheStore = typeof caches !== 'undefined' ? caches.default : null,
    state = defaultWeatherState,
  } = {},
) {
  const canUseEdgeCache = Boolean(cacheStore && env?.CWA_API_KEY && env?.MOENV_API_KEY);

  if (canUseEdgeCache) {
    try {
      const hit = await cacheStore.match(WEATHER_EDGE_CACHE_KEY);
      if (hit) {
        const body = await hit.text();
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=60, s-maxage=${WEATHER_CACHE_TTL_SEC}`,
            ...buildCorsHeaders(request, env),
          },
        });
      }
    } catch {}
  }

  let task = state?.inFlight;
  if (!task) {
    task = fetchWeatherReport(env, { fetchImpl, state }).finally(() => {
      if (state) state.inFlight = null;
    });
    if (state) state.inFlight = task;
  }
  const payload = await task;
  const jsonText = JSON.stringify(payload);
  const hasAnyData = payload.temperature != null || payload.aqi != null;

  if (canUseEdgeCache && hasAnyData && payload.missingKeys.length === 0) {
    try {
      await cacheStore.put(
        WEATHER_EDGE_CACHE_KEY,
        new Response(jsonText, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=60, s-maxage=${WEATHER_CACHE_TTL_SEC}`,
          },
        }),
      );
    } catch {}
  }

  return new Response(jsonText, {
    status: hasAnyData || payload.missingKeys.length > 0 ? 200 : 502,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control':
        hasAnyData && payload.missingKeys.length === 0
          ? `public, max-age=60, s-maxage=${WEATHER_CACHE_TTL_SEC}`
          : 'no-store, no-cache, must-revalidate',
      ...buildCorsHeaders(request, env),
    },
  });
}

/** 公開路由分派（支援 Durable Object 單例或無 DO 綁定時的安全降級） */
export async function handleWorkerRequest(request, env, fallbackHubFactory) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: buildCorsHeaders(request, env) });
  }

  const url = new URL(request.url);

  if (url.pathname === '/api/stats/visits') {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405, request, env);
    }
    if (env?.DB) {
      const visits = await handleD1Visits(env.DB, request.method === 'POST');
      return jsonResponse({ ok: true, visits }, 200, request, env);
    }
    if (env?.FUGLE_HUB) {
      const id = env.FUGLE_HUB.idFromName('twse-ix0001');
      const stub = env.FUGLE_HUB.get(id);
      const res = await stub.fetch(
        new Request(`https://fugle-hub.internal/internal/stats/visits`, { method: request.method }),
      );
      const data = await res.json();
      return jsonResponse(data, res.status, request, env);
    }
    return jsonResponse({ ok: false, error: '尚未綁定人數計次資料庫 (DB / FUGLE_HUB)' }, 500, request, env);
  }

  if (request.method !== 'GET') {
    return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405, request, env);
  }

  if (url.pathname === '/api/weather' || url.pathname === '/api/env') {
    return handleWeatherRequest(request, env);
  }

  if (url.pathname === '/health') {
    let hubStatus = null;
    if (env?.FUGLE_HUB) {
      const stub = env.FUGLE_HUB.get(env.FUGLE_HUB.idFromName('twse-ix0001'));
      const res = await stub.fetch(new Request('https://fugle-hub.internal/internal/status'));
      hubStatus = await res.json();
    }
    return jsonResponse(
      {
        ok: true,
        service: 'cmoney-taiex',
        primary: 'fugle',
        backup: 'yahoo',
        hasFugleKey: Boolean(env?.FUGLE_API_KEY),
        hasCwaKey: Boolean(env?.CWA_API_KEY),
        hasMoenvKey: Boolean(env?.MOENV_API_KEY),
        hasDurableHub: Boolean(env?.FUGLE_HUB),
        hasD1: Boolean(env?.DB),
        taipeiTime: taipeiNowParts(),
        intradayWindow: isTaiwanIntraday(),
        hub: hubStatus,
      },
      200,
      request,
      env,
    );
  }

  if (url.pathname === '/' || url.pathname === '/api/taiex' || url.pathname === '/api/quote' || url.pathname === '/api/stream') {
    if (env?.FUGLE_HUB) {
      const id = env.FUGLE_HUB.idFromName('twse-ix0001');
      const stub = env.FUGLE_HUB.get(id);
      const forwarded = new Request(`https://fugle-hub.internal${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
      });
      return stub.fetch(forwarded);
    }

    // 過渡相容：若尚未透過 wrangler deploy 綁定 Durable Object，仍可單次退回快照抓取
    const hub = fallbackHubFactory ? fallbackHubFactory(env) : new FugleHubEngine({ env });
    if (url.pathname === '/api/stream') {
      return jsonResponse({ ok: false, error: 'SSE 串流需透過 wrangler deploy 啟用 FugleHub Durable Object' }, 503, request, env);
    }
    return hub.handleFetch(request);
  }

  return jsonResponse({ ok: false, error: 'Not Found' }, 404, request, env);
}
