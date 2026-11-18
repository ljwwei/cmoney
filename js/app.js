// 前端顯示邏輯（純函式 + 渲染）。所有「今天」的判斷都以台北時間為準。
// 主力走 Worker SSE（/api/stream）轉發富果 WebSocket；SSE 無法連線時退回遞迴 setTimeout 輪詢。
// API Key 完全不經手前端，僅存於 Cloudflare Worker Secret (FUGLE_API_KEY)。

const TZ = 'Asia/Taipei';
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

const DEFAULT_LIVE_API = '';
export const FALLBACK_POLL_MS = 2500;
export const STREAM_RETRY_MS = 15000;
export const FETCH_TIMEOUT_MS = 2000;

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isSafeHttpOrigin(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const isHttps = u.protocol === 'https:';
    const isLocalHttp = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    if (!isHttps && !isLocalHttp) return '';
    return s.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function resolveApiOrigin({
  globalApi = typeof globalThis !== 'undefined' ? globalThis.CMONEY_TAIEX_API : '',
  search = typeof location !== 'undefined' ? location.search : '',
  metaContent = typeof document !== 'undefined'
    ? document.querySelector?.('meta[name="taiex-api"]')?.getAttribute?.('content') ?? ''
    : '',
  defaultApi = DEFAULT_LIVE_API,
} = {}) {
  const fromQuery = search ? new URLSearchParams(search).get('liveApi') || '' : '';
  const candidate = [fromQuery, globalApi, metaContent, defaultApi]
    .map((v) => isSafeHttpOrigin(v))
    .find(Boolean);
  if (!candidate) return '';
  return candidate.replace(/\/api\/(taiex|quote|stream)\/?$/i, '').replace(/\/+$/, '');
}

export function resolveLiveApiUrl(opts = {}) {
  const origin = resolveApiOrigin(opts);
  return origin ? `${origin}/api/taiex` : '';
}

// ---------- 時間 / 交易日 ----------

export function taipeiNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

export function isTradingDay(dateStr, closedDates = []) {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !closedDates.includes(dateStr);
}

/**
 * 是否要顯示「當日資訊尚未揭露」：
 * 今天（台北時間）是交易日，而已抓到的資料日期早於今天。
 */
export function isPending(dataDate, today, closedDates) {
  return isTradingDay(today, closedDates) && (!dataDate || dataDate < today);
}

/** 台北時間交易日 08:55:00 ～ 13:35:00：啟用大盤盤中即時串流 */
export function inIntradayWindow(dateStr, timeStr, closedDates = []) {
  return isTradingDay(dateStr, closedDates) && timeStr >= '08:55:00' && timeStr <= '13:35:00';
}

/** 取得報價實際成交 Unix Timestamp（毫秒） */
export function getQuoteTimestampMs(quote) {
  if (!quote || typeof quote !== 'object') return NaN;
  const direct = Number(quote.timestampMs);
  if (Number.isFinite(direct) && direct > 0) return direct;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(quote.date || '')) && /^\d{2}:\d{2}(:\d{2})?$/.test(String(quote.time || ''))) {
    const t = quote.time.length === 5 ? `${quote.time}:00` : quote.time;
    const ms = Date.parse(`${quote.date}T${t}+08:00`);
    return Number.isFinite(ms) && ms > 0 ? ms : NaN;
  }
  return NaN;
}

/**
 * 單調時間戳防呆（Monotonic Timestamp Guard）：
 * 只有當「新報價成交時間 > latestQuoteTimestamp」時才允許採用，直接丟棄重複或較舊快取。
 */
export function acceptLiveQuote(current, incoming, latestQuoteTimestamp = 0) {
  if (!incoming || incoming.ok === false || !(incoming.close > 0)) return current;
  const incomingMs = getQuoteTimestampMs(incoming);
  if (!Number.isFinite(incomingMs) || incomingMs <= 0) return current;
  const currentMs = getQuoteTimestampMs(current);
  const floorMs = Math.max(Number(latestQuoteTimestamp) || 0, Number.isFinite(currentMs) ? currentMs : 0);
  if (incomingMs <= floorMs) return current;
  return { ...incoming, timestampMs: incomingMs };
}

/**
 * 決定大盤卡片此刻應顯示哪份資料：
 * 1. 若盤後正式資料（twse / openapi）已就緒於今日 → 顯示盤後正式資料
 * 2. 若即時行情（富果 / Yahoo 備援）屬於今日 → 顯示即時行情
 * 3. 否則顯示前一交易日資料
 */
export function selectIndexDisplay(stateIndex, liveIndex, today) {
  if (stateIndex?.date === today && (stateIndex.source === 'twse' || stateIndex.source === 'openapi')) {
    return stateIndex;
  }
  if (liveIndex?.date === today) {
    return liveIndex;
  }
  return stateIndex;
}

// ---------- 單例即時串流與防卡頓備援輪詢控制器 ----------

/**
 * 前端統一以單例 EventSource 連接 Worker `/api/stream`（避免多餘連線）：
 *  - start / stop / visibilitychange / pagehide / beforeunload 皆確實呼叫 close()
 *  - 若瀏覽器環境或網路阻擋 EventSource，自動切換為非重疊遞迴 setTimeout（2.5s + AbortController 2s），
 *    並每 15 秒嘗試重建 SSE 連線
 */
export function createLiveStreamController({
  apiOrigin,
  isHidden = () => false,
  EventSourceCtor = typeof globalThis !== 'undefined' ? globalThis.EventSource : undefined,
  fetchImpl = typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
  nowFn = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  pollMs = FALLBACK_POLL_MS,
  streamRetryMs = STREAM_RETRY_MS,
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
  onQuote = () => {},
  onError = (e) => console.warn('即時行情連線異常', e?.message ?? e),
} = {}) {
  let es = null;
  let active = false;
  let pollTimer = null;
  let retrySseTimer = null;
  let inFlight = false;
  let inFlightCtrl = null;
  let inFlightAbortTimer = null;
  let sseErrorCount = 0;

  function abortInFlight() {
    if (inFlightAbortTimer != null) {
      clearTimer(inFlightAbortTimer);
      inFlightAbortTimer = null;
    }
    if (inFlightCtrl) {
      try {
        inFlightCtrl.abort();
      } catch {}
      inFlightCtrl = null;
    }
    inFlight = false;
  }

  function clearTimers() {
    if (pollTimer != null) {
      clearTimer(pollTimer);
      pollTimer = null;
    }
    if (retrySseTimer != null) {
      clearTimer(retrySseTimer);
      retrySseTimer = null;
    }
    abortInFlight();
  }

  function closeEventSource() {
    if (!es) return;
    try {
      es.close();
    } catch {}
    es = null;
  }

  async function fetchSnapshotOnce() {
    if (!apiOrigin || !fetchImpl || inFlight || isHidden()) return;
    inFlight = true;
    const ctrl = new AbortController();
    inFlightCtrl = ctrl;
    inFlightAbortTimer = setTimer(() => ctrl.abort(), fetchTimeoutMs);
    try {
      const res = await fetchImpl(`${apiOrigin}/api/taiex?_t=${nowFn()}`, {
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (!res.ok) return;
      const json = await res.json();
      onQuote(json);
    } catch (err) {
      if (!ctrl.signal.aborted) onError(err);
    } finally {
      if (inFlightCtrl === ctrl) {
        if (inFlightAbortTimer != null) {
          clearTimer(inFlightAbortTimer);
          inFlightAbortTimer = null;
        }
        inFlightCtrl = null;
        inFlight = false;
      }
    }
  }

  function schedulePoll(delay = pollMs) {
    if (pollTimer != null) {
      clearTimer(pollTimer);
      pollTimer = null;
    }
    if (!active || isHidden() || es) return;
    pollTimer = setTimer(async () => {
      pollTimer = null;
      if (!active || isHidden() || es) return;
      await fetchSnapshotOnce();
      if (active && !isHidden() && !es) schedulePoll(pollMs);
    }, delay);
  }

  function scheduleSseRetry() {
    if (retrySseTimer != null || !active || isHidden() || typeof EventSourceCtor !== 'function') return;
    retrySseTimer = setTimer(() => {
      retrySseTimer = null;
      if (active && !isHidden() && !es) openStream();
    }, streamRetryMs);
  }

  function openStream() {
    if (!active || isHidden() || !apiOrigin) return;
    if (es) return; // 單例守門：不允許同時存在兩條 EventSource

    if (typeof EventSourceCtor !== 'function') {
      schedulePoll(0);
      return;
    }

    const sock = new EventSourceCtor(`${apiOrigin}/api/stream`);
    es = sock;

    sock.addEventListener('open', () => {
      if (es !== sock) return;
      sseErrorCount = 0;
      if (pollTimer != null) {
        clearTimer(pollTimer);
        pollTimer = null;
      }
      if (retrySseTimer != null) {
        clearTimer(retrySseTimer);
        retrySseTimer = null;
      }
    });

    sock.addEventListener('quote', (ev) => {
      if (es !== sock) return;
      sseErrorCount = 0;
      try {
        const data = typeof ev?.data === 'string' ? JSON.parse(ev.data) : ev?.data;
        onQuote(data);
      } catch {}
    });

    sock.addEventListener('error', (err) => {
      if (es !== sock) return;
      sseErrorCount += 1;
      if (sseErrorCount >= 3 || sock.readyState === 2) {
        closeEventSource();
        onError(err);
        schedulePoll(0);
        scheduleSseRetry();
      }
    });
  }

  function start() {
    if (!apiOrigin || isHidden()) return;
    if (active && es) return;
    active = true;
    sseErrorCount = 0;
    openStream();
    // 同步立即拉一次快照，避免 SSE 握手期間畫面空白
    fetchSnapshotOnce();
  }

  function stop() {
    active = false;
    clearTimers();
    closeEventSource();
  }

  function onVisibilityChange() {
    if (isHidden()) {
      clearTimers();
      closeEventSource();
    } else if (active) {
      sseErrorCount = 0;
      openStream();
      fetchSnapshotOnce();
    }
  }

  return {
    start,
    stop,
    onVisibilityChange,
    isConnected: () => Boolean(es),
  };
}

// ---------- 格式化 ----------

const fmt = (n, d = 0) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const dirClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const sgn = (n) => (n > 0 ? '+' : n < 0 ? '−' : '');

export const fmtDate = (d) => {
  const [y, m, day] = d.split('-');
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  return `${y}/${m}/${day}（${WEEK[dow]}）`;
};

const fmtTime = (isoOrMs, withSec = false) => {
  if (!isoOrMs) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TZ,
    hourCycle: 'h23',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSec ? { second: '2-digit' } : {}),
  }).format(new Date(isoOrMs));
};

export function formatQuoteTime(timestampMs) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TZ,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestampMs));
}

/** 元 → 億（兩位小數，含正負號） */
export const toYiSigned = (yuan) => {
  const v = yuan / 1e8;
  return `${sgn(+v.toFixed(2))}${fmt(Math.abs(v), 2)}`;
};

/** 融資餘額：仟元 → 億，四捨五入到整數。536,678,732 仟元 → 5367 億 */
export const marginYi = (thousandYuan) => Math.round(thousandYuan / 1e5);

/** 融資增減（億，取一位小數） */
export const marginDiffYi = (today, prev) => +((today - prev) / 1e5).toFixed(1);

// ---------- 各卡片內容 ----------

export function renderIndex(d) {
  const cls = dirClass(d.change ?? 0);
  const arrow = d.change > 0 ? '▲' : d.change < 0 ? '▼' : '—';
  const pts = d.change == null ? '—' : `${sgn(d.change)}${fmt(Math.abs(d.change), 2)}`;
  const pct = d.changePct == null ? '—' : `${sgn(d.changePct)}${fmt(Math.abs(d.changePct), 2)}%`;

  const prevClose =
    d.prevClose > 0
      ? d.prevClose
      : d.change != null
        ? +(Number(d.close) - Number(d.change)).toFixed(2)
        : null;
  const ohlcCls = (v) => (v > 0 && prevClose > 0 ? dirClass(v - prevClose) : 'flat');
  const hasOhlc = d.open > 0 || d.high > 0 || d.low > 0;
  const ohlcHtml = hasOhlc
    ? `
      <div class="index__ohlc" aria-label="當日開盤最高最低">
        <div class="ohlc__item">
          <span class="ohlc__label">開盤</span>
          <span class="ohlc__val ${ohlcCls(d.open)}">${d.open > 0 ? fmt(d.open, 2) : '—'}</span>
        </div>
        <div class="ohlc__item">
          <span class="ohlc__label">最高</span>
          <span class="ohlc__val ${ohlcCls(d.high)}">${d.high > 0 ? fmt(d.high, 2) : '—'}</span>
        </div>
        <div class="ohlc__item">
          <span class="ohlc__label">最低</span>
          <span class="ohlc__val ${ohlcCls(d.low)}">${d.low > 0 ? fmt(d.low, 2) : '—'}</span>
        </div>
      </div>`
    : '';

  return `
    <div class="index__wrap">
      <div class="index ${cls}">
        <div class="index__close">${fmt(d.close, 2)}</div>
        <div class="index__chg">
          <span class="chip ${cls}"><span class="arrow">${arrow}</span> ${pts}</span>
          <span class="chip ${cls}">${pct}</span>
        </div>
      </div>
      ${ohlcHtml}
    </div>
    <p class="sub">較前一交易日收盤</p>`;
}

/** 畫面資料源標籤僅保留兩種即時狀態：富果盤中即時 與 Yahoo 盤中即時 (備援) */
export function indexBadge(d, today) {
  if (!d || d.date !== today) return '';
  if (d.source === 'fugle') {
    return '<span class="badge badge--live"><i class="live-dot" aria-hidden="true"></i>富果盤中即時</span>';
  }
  if (d.source === 'yahoo') {
    return '<span class="badge badge--backup">Yahoo 盤中即時 (備援)</span>';
  }
  return '';
}

function renderInst(d) {
  const rows = [
    ['外資', d.foreign],
    ['投信', d.trust],
    ['自營商', d.dealer],
  ];
  const max = Math.max(...rows.map(([, r]) => Math.abs(r.net)), 1);
  const items = rows
    .map(([name, r]) => {
      const cls = dirClass(r.net);
      const w = Math.max(2, Math.round((Math.abs(r.net) / max) * 100));
      return `
      <li class="inst__row">
        <span class="inst__name">${name}</span>
        <span class="inst__bar"><i class="${cls}" style="width:${w}%"></i></span>
        <span class="inst__val ${cls}">${toYiSigned(r.net)}<small>億</small></span>
        <span class="inst__detail">買 ${fmt(r.buy / 1e8, 1)}億 ／ 賣 ${fmt(r.sell / 1e8, 1)}億</span>
      </li>`;
    })
    .join('');
  const t = d.total;
  const totalHtml = t
    ? `<div class="inst__total"><span>三大法人合計</span><b class="${dirClass(t.net)}">${toYiSigned(t.net)}<small>億</small></b></div>`
    : '';
  return `<ul class="inst">${items}</ul>${totalHtml}`;
}

function instBadge(d) {
  if (!d) return '';
  return d.stage === 'with_block'
    ? '<span class="badge badge--block">含鉅額</span>'
    : '<span class="badge badge--noblock">不含鉅額</span>';
}

function renderFut(d) {
  const net = d.foreignNet;
  const cls = net < 0 ? 'down' : net > 0 ? 'up' : 'flat';
  const side = net < 0 ? '淨空單' : net > 0 ? '淨多單' : '多空持平';
  return `
    <div class="fut ${cls}">
      <div class="fut__num">${fmt(Math.abs(net))}<small>口</small></div>
      <span class="chip ${cls}">${side}</span>
    </div>
    <p class="sub">外資及陸資・臺股期貨・未平倉多空淨額${
      d.long != null && d.short != null ? `<br>多方 ${fmt(d.long)} 口 ／ 空方 ${fmt(d.short)} 口` : ''
    }</p>`;
}

function renderMargin(d) {
  const diff = marginDiffYi(d.balance, d.prevBalance);
  const cls = dirClass(diff);
  const word = diff > 0 ? '增加' : diff < 0 ? '減少' : '持平';
  return `
    <div class="margin">
      <div class="margin__num">${fmt(marginYi(d.balance))}<small>億</small></div>
      <span class="chip ${cls}">較前一交易日${word}${diff === 0 ? '' : ` ${fmt(Math.abs(diff), 1)} 億`}</span>
    </div>
    <p class="sub">信用交易統計・融資金額今日餘額<br>前一交易日餘額 ${fmt(marginYi(d.prevBalance))} 億</p>`;
}

// ---------- 渲染 ----------

const CARDS = [
  { id: 'card-index', key: 'index', render: renderIndex, badge: indexBadge },
  { id: 'card-inst', key: 'institutional', render: renderInst, badge: instBadge },
  { id: 'card-fut', key: 'futures', render: renderFut },
  { id: 'card-margin', key: 'margin', render: renderMargin },
];

function renderCard(card, state, today, liveIndex) {
  const el = document.getElementById(card.id);
  const d = card.key === 'index' ? selectIndexDisplay(state?.index, liveIndex, today) : state?.[card.key];
  const body = el.querySelector('.card__body');
  const notice = el.querySelector('.notice');
  const foot = el.querySelector('.card__foot');
  el.querySelector('.badge-slot').innerHTML = d && card.badge ? card.badge(d, today) : '';

  if (!d) {
    body.innerHTML = '<p class="empty">尚無資料</p>';
    foot.textContent = '';
  } else {
    body.innerHTML = card.render(d);
    let timeText = '';
    if (card.key === 'index' && d.date === today) {
      const tsMs = getQuoteTimestampMs(d);
      const clockStr = Number.isFinite(tsMs) ? formatQuoteTime(tsMs) : d.time;
      if (clockStr) timeText = `成交時間 ${escapeHtml(clockStr)}`;
      else if (d.fetchedAt) timeText = `擷取 ${fmtTime(d.fetchedAt)}`;
    } else if (d.fetchedAt) {
      timeText = `擷取 ${fmtTime(d.fetchedAt)}`;
    }
    foot.innerHTML = `<span>資料日期 <b>${fmtDate(d.date)}</b></span><span>${timeText}</span>`;
  }

  const pending = isPending(d?.date, today, state?.closedDates ?? []);
  notice.hidden = !pending;
  if (pending) {
    notice.textContent = d
      ? `當日資訊尚未揭露（目前顯示 ${fmtDate(d.date)} 資料）`
      : '當日資訊尚未揭露';
  }
  el.classList.toggle('is-pending', pending);

  if (card.key === 'institutional' && d && d.date === today && d.stage === 'ex_block') {
    notice.hidden = false;
    notice.textContent = '目前為不含鉅額版本，20:00 後將更新為含鉅額';
  }
}

let state = null;
let liveState = null;
let latestQuoteTimestamp = 0;
let lastSig = '';

export function renderAll() {
  const { date: today, time } = taipeiNow();
  document.getElementById('clock').textContent = time;
  if (!state) return;

  const activeIndex = selectIndexDisplay(state.index, liveState, today);
  const liveSig =
    activeIndex === liveState && liveState
      ? `${liveState.date}|${getQuoteTimestampMs(liveState)}|${liveState.close}|${liveState.source}`
      : '';
  const sig = `${today}|${state.meta?.updatedAt}|${liveSig}`;
  if (sig === lastSig) return;
  lastSig = sig;

  for (const c of CARDS) renderCard(c, state, today, liveState);

  const metaEl = document.getElementById('meta-updated');
  if (activeIndex === liveState && liveState?.date === today) {
    const quoteMs = getQuoteTimestampMs(liveState);
    metaEl.textContent = Number.isFinite(quoteMs)
      ? `報價成交時間：${fmtTime(quoteMs, true)}（台北時間）`
      : '報價成交時間：—';
  } else {
    metaEl.textContent = state.meta?.updatedAt
      ? `資料更新：${fmtTime(state.meta.updatedAt)}（台北時間）`
      : '資料更新：—';
  }
}

/** 與民德市政府官網同規格的累積瀏覽總人次計數 */
export async function initVisitCounter({
  apiOrigin = resolveApiOrigin(),
  fetchImpl = typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
  documentRef = typeof document !== 'undefined' ? document : null,
} = {}) {
  const el = documentRef?.getElementById?.('siteVisitCount');
  if (!el || !apiOrigin || !fetchImpl) return null;
  try {
    const res = await fetchImpl(`${apiOrigin}/api/stats/visits`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    const count = Number(data?.visits);
    if (data?.ok && Number.isFinite(count) && count >= 0) {
      el.textContent = Math.max(0, Math.floor(count)).toLocaleString('zh-TW');
      return Math.floor(count);
    }
  } catch (err) {
    console.warn('讀取網站累積瀏覽人數失敗', err?.message ?? err);
  }
  return null;
}

/* ========================================================
   臺南市氣溫（3 分鐘）& 臺南測站 AQI（每小時 05～20 分每 1 分鐘抓取至取得新資料為止）
   ======================================================== */
export const WEATHER_REFRESH_MS = 3 * 60 * 1000;
export const WEATHER_AQI_HUNT_MS = 60 * 1000;

export function nextWeatherDelayMs(aqiPublishTime, nowMs = Date.now(), refreshMs = WEATHER_REFRESH_MS) {
  const tw = new Date(nowMs + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const currentHour = `${tw.getUTCFullYear()}/${pad(tw.getUTCMonth() + 1)}/${pad(tw.getUTCDate())} ${pad(tw.getUTCHours())}`;
  const minute = tw.getUTCMinutes();
  const sec = tw.getUTCSeconds();
  const storedHour = String(aqiPublishTime || '').slice(0, 13);
  const needAqi = !storedHour || storedHour < currentHour;

  if (needAqi && minute >= 5 && minute <= 20) {
    return WEATHER_AQI_HUNT_MS;
  }
  if (needAqi && minute < 5) {
    const msTo05 = ((5 - minute) * 60 - sec) * 1000 + 2000;
    return Math.max(1000, Math.min(refreshMs, msTo05));
  }
  return refreshMs;
}

export function formatWeatherTime(raw, hasOffset, nowMs = Date.now()) {
  if (!raw) return '';
  let y;
  let mo;
  let da;
  let hh;
  let mi;
  if (hasOffset) {
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return '';
    const tw = new Date(dt.getTime() + 8 * 3600 * 1000);
    [y, mo, da, hh, mi] = [
      tw.getUTCFullYear(),
      tw.getUTCMonth() + 1,
      tw.getUTCDate(),
      tw.getUTCHours(),
      tw.getUTCMinutes(),
    ];
  } else {
    const m = String(raw).match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if (!m) return '';
    [y, mo, da, hh, mi] = m.slice(1).map(Number);
  }
  const p = (n) => String(n).padStart(2, '0');
  const now = new Date(nowMs + 8 * 3600 * 1000);
  const isToday = y === now.getUTCFullYear() && mo === now.getUTCMonth() + 1 && da === now.getUTCDate();
  return `${isToday ? '' : `${mo}/${da} `}${p(hh)}:${p(mi)}`;
}

export function aqiStatus(aqi) {
  if (aqi <= 50) return '良好';
  if (aqi <= 100) return '普通';
  if (aqi <= 150) return '對敏感族群不健康';
  if (aqi <= 200) return '對所有族群不健康';
  if (aqi <= 300) return '非常不健康';
  return '危害';
}

export function aqiLevel(aqi) {
  if (aqi <= 50) return 0;
  if (aqi <= 100) return 1;
  if (aqi <= 150) return 2;
  if (aqi <= 200) return 3;
  if (aqi <= 300) return 4;
  return 5;
}

export function initLiveWeather({
  apiOrigin = resolveApiOrigin(),
  fetchImpl = typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
  documentRef = typeof document !== 'undefined' ? document : null,
  nowFn = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  refreshMs = WEATHER_REFRESH_MS,
} = {}) {
  const tempEls = documentRef?.querySelectorAll?.('[data-live-temp]') ?? [];
  const tempTimeEls = documentRef?.querySelectorAll?.('[data-live-temp-time]') ?? [];
  const aqiEls = documentRef?.querySelectorAll?.('[data-live-aqi]') ?? [];
  if ((!tempEls.length && !aqiEls.length) || !apiOrigin || !fetchImpl) return null;

  let lastFetchedAt = 0;
  let lastAqiPublishTime = '';
  let timerId = null;
  let stopped = false;

  function setTemp(text, timeText) {
    tempEls.forEach((el) => {
      el.textContent = text;
    });
    tempTimeEls.forEach((el) => {
      el.textContent = timeText ? `(${timeText})` : '';
    });
  }

  function setAqi(text, level) {
    aqiEls.forEach((el) => {
      el.textContent = text;
      el.setAttribute('data-aqi-level', level ?? '');
    });
  }

  function clearTimer() {
    if (timerId != null) {
      clearTimeoutFn(timerId);
      timerId = null;
    }
  }

  function scheduleNext() {
    clearTimer();
    if (stopped) return;
    const delay = nextWeatherDelayMs(lastAqiPublishTime, nowFn(), refreshMs);
    timerId = setTimeoutFn(() => {
      timerId = null;
      return runCycle();
    }, delay);
  }

  async function refresh() {
    try {
      const res = await fetchImpl(`${apiOrigin}/api/weather?_t=${nowFn()}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      lastFetchedAt = nowFn();
      if (d?.aqiPublishTime) lastAqiPublishTime = d.aqiPublishTime;

      const t = parseFloat(d?.temperature);
      setTemp(Number.isNaN(t) ? '--' : t.toFixed(1), Number.isNaN(t) ? '' : formatWeatherTime(d.tempObsTime, true, nowFn()));

      const aqi = parseInt(d?.aqi, 10);
      if (Number.isNaN(aqi)) {
        setAqi('空氣品質 --', '');
      } else {
        const status = d.aqiStatus || aqiStatus(aqi);
        const aqiTime = formatWeatherTime(d.aqiPublishTime, false, nowFn());
        setAqi(`空氣品質：${status} AQI ${aqi}${aqiTime ? ` (${aqiTime})` : ''}`, String(aqiLevel(aqi)));
      }
      return d;
    } catch (err) {
      console.warn('讀取氣象/空品失敗', err?.message ?? err);
      setTemp('--', '');
      setAqi('空氣品質 --', '');
      return null;
    }
  }

  async function runCycle() {
    if (stopped) return null;
    const data = await refresh();
    scheduleNext();
    return data;
  }

  const initialPromise = runCycle();

  return {
    refresh,
    onVisibilityShow() {
      const minWait = Math.min(nextWeatherDelayMs(lastAqiPublishTime, nowFn(), refreshMs), refreshMs);
      if (!stopped && nowFn() - lastFetchedAt >= minWait) {
        clearTimer();
        runCycle();
      }
    },
    stop() {
      stopped = true;
      clearTimer();
    },
    getNextDelayMs: () => nextWeatherDelayMs(lastAqiPublishTime, nowFn(), refreshMs),
    initialPromise,
  };
}

/* ========================================================
   常駐型 OLED 防烙印微幅像素位移 (Always-On Pixel Shift)
   每 60 秒依 8 點路徑循環位移 ±3px，卸載時 clearInterval 釋放
   ======================================================== */
export const PIXEL_SHIFT_INTERVAL_MS = 60 * 1000;
export const PIXEL_SHIFT_PATH = [
  [0, 0],
  [3, 0],
  [3, 3],
  [0, 3],
  [-3, 3],
  [-3, 0],
  [-3, -3],
  [0, -3],
];

export function initPixelShift({
  documentRef = typeof document !== 'undefined' ? document : null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = PIXEL_SHIFT_INTERVAL_MS,
} = {}) {
  const targets = [...(documentRef?.querySelectorAll?.('.pixel-shift') ?? [])];
  if (!targets.length) return null;

  let stepIndex = 0;

  function applyStep(idx) {
    const [x, y] = PIXEL_SHIFT_PATH[idx];
    const transform = `translate(${x}px, ${y}px)`;
    targets.forEach((el) => {
      el.style.transform = transform;
    });
  }

  applyStep(0);
  let timerId = setIntervalFn(() => {
    stepIndex = (stepIndex + 1) % PIXEL_SHIFT_PATH.length;
    applyStep(stepIndex);
  }, intervalMs);

  return {
    step() {
      stepIndex = (stepIndex + 1) % PIXEL_SHIFT_PATH.length;
      applyStep(stepIndex);
    },
    stop() {
      if (timerId != null) {
        clearIntervalFn(timerId);
        timerId = null;
      }
    },
    getStepIndex: () => stepIndex,
  };
}

function githubApiUrl() {
  if (typeof location === 'undefined' || !location.hostname.endsWith('.github.io')) return null;
  const owner = location.hostname.split('.')[0];
  const repo = location.pathname.split('/')[1];
  return repo ? `https://api.github.com/repos/${owner}/${repo}/contents/data/data.json` : null;
}

function inFreshWindow() {
  const { date, time } = taipeiNow();
  return isTradingDay(date, state?.closedDates ?? []) && time >= '13:25:00' && time < '23:59:59';
}

async function fetchPages() {
  const res = await fetch(`data/data.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

async function fetchGithubApi() {
  const url = githubApiUrl();
  if (!url || !inFreshWindow()) return null;
  const res = await fetch(url, {
    cache: 'no-cache',
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

const newer = (a, b) => ((a?.meta?.updatedAt ?? '') >= (b?.meta?.updatedAt ?? '') ? a : b);

function syncLiveLifecycle() {
  if (!liveController || !state) return;
  const { date: today, time } = taipeiNow();
  const forceLive =
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('forceLive') === '1';
  const settledToday =
    state.index?.date === today && (state.index.source === 'twse' || state.index.source === 'openapi');

  if (forceLive || (!settledToday && inIntradayWindow(today, time, state.closedDates ?? []))) {
    liveController.start();
  } else {
    liveController.stop();
  }
}

function handleIncomingQuote(raw) {
  const next = acceptLiveQuote(liveState, raw, latestQuoteTimestamp);
  if (next && next !== liveState) {
    latestQuoteTimestamp = getQuoteTimestampMs(next);
    liveState = next;
    renderAll();
  }
}

async function load() {
  if (typeof document !== 'undefined' && document.hidden && state) return;
  const [pages, api] = await Promise.allSettled([fetchPages(), fetchGithubApi()]);
  const got = [pages, api].filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
  if (got.length) {
    state = got.reduce(newer);
  } else {
    console.warn('讀取資料失敗', pages.reason);
    if (!state) {
      for (const c of CARDS) {
        document.querySelector(`#${c.id} .card__body`).innerHTML = '<p class="empty">資料讀取失敗，請稍後重新整理</p>';
      }
    }
  }
  renderAll();
  syncLiveLifecycle();
}

let liveController = null;
let weatherController = null;
let pixelShiftController = null;

if (typeof document !== 'undefined') {
  const apiOrigin = resolveApiOrigin();
  liveController = createLiveStreamController({
    apiOrigin,
    isHidden: () => document.hidden,
    onQuote: handleIncomingQuote,
  });

  initVisitCounter({ apiOrigin });
  weatherController = initLiveWeather({ apiOrigin });
  pixelShiftController = initPixelShift();
  load();
  const loadTimer = setInterval(load, 30 * 1000);
  const clockTimer = setInterval(() => {
    renderAll();
    syncLiveLifecycle();
  }, 1000);

  const cleanup = () => {
    liveController?.stop();
    weatherController?.stop();
    pixelShiftController?.stop();
    clearInterval(loadTimer);
    clearInterval(clockTimer);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      liveController.onVisibilityChange();
    } else {
      load();
      liveController.onVisibilityChange();
      weatherController?.onVisibilityShow();
    }
  });
  window.addEventListener('pagehide', cleanup);
  window.addEventListener('beforeunload', cleanup);
}
