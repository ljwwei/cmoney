// 前端顯示邏輯（純函式 + 渲染）。所有「今天」的判斷都以台北時間為準。

const TZ = 'Asia/Taipei';
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

// 若已部署 worker/worker.js，可於 index.html 的 <meta name="taiex-api" content="..."> 或此處填入 Worker 網址
const DEFAULT_LIVE_API = '';
// 台股盤中每 5 秒撮合一次；以 2.5 秒輪詢（比撮合週期更密）才不會錯過剛出爐的報價
export const LIVE_POLL_MS = 2500;

/**
 * 遞迴 setTimeout 輪詢器（不是 setInterval）：
 *  - 一定等「上一次請求結束」後才開始倒數下一次，不會請求堆疊
 *  - 分頁隱藏即暫停；切回時立刻抓一次並恢復固定間隔
 */
export function createLivePoller({
  run,
  isHidden = () => false,
  intervalMs = LIVE_POLL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let running = false;

  function schedule(delay = intervalMs) {
    clearTimer(timer);
    timer = null;
    if (isHidden()) return;
    timer = setTimer(async () => {
      timer = null;
      if (running || isHidden()) return; // 前一輪仍在進行：交給它結束後自行排程
      running = true;
      try {
        await run();
      } catch (e) {
        console.warn('即時輪詢發生錯誤', e?.message ?? e);
      } finally {
        running = false;
      }
      schedule();
    }, delay);
  }

  return {
    start: () => schedule(0),
    stop() {
      clearTimer(timer);
      timer = null;
    },
    onVisibilityChange() {
      if (isHidden()) this.stop();
      else schedule(0);
    },
  };
}

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

export function resolveLiveApiUrl({
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
  return candidate.endsWith('/api/taiex') ? candidate : `${candidate}/api/taiex`;
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
 * 今天不是交易日 → 不顯示，維持顯示最近一個交易日資訊。
 */
export function isPending(dataDate, today, closedDates) {
  return isTradingDay(today, closedDates) && (!dataDate || dataDate < today);
}

/** 台北時間交易日 08:59:00 ～ 13:35:00：啟用大盤盤中 2.5 秒即時輪詢 */
export function inIntradayWindow(dateStr, timeStr, closedDates = []) {
  return isTradingDay(dateStr, closedDates) && timeStr >= '08:59:00' && timeStr <= '13:35:00';
}

/**
 * 決定大盤卡片此刻應顯示哪份資料：
 * 1. 若盤後正式資料（twse / openapi）已就緒於今日 → 優先顯示盤後正式資料
 * 2. 若盤中即時 Worker 資料屬於今日 → 顯示盤中（或剛收盤之即時終盤），並補齊開高低
 * 3. 否則顯示前一交易日資料
 */
export function selectIndexDisplay(stateIndex, liveIndex, today) {
  if (stateIndex?.date === today && stateIndex.source && stateIndex.source !== 'mis') {
    return stateIndex;
  }
  if (liveIndex?.date === today) {
    if (
      stateIndex?.date === today &&
      stateIndex.fetchedAt &&
      liveIndex.fetchedAt &&
      stateIndex.fetchedAt > liveIndex.fetchedAt
    ) {
      return {
        ...stateIndex,
        ...(stateIndex.open > 0 ? {} : liveIndex.open > 0 ? { open: liveIndex.open } : {}),
        ...(stateIndex.high > 0 ? {} : liveIndex.high > 0 ? { high: liveIndex.high } : {}),
        ...(stateIndex.low > 0 ? {} : liveIndex.low > 0 ? { low: liveIndex.low } : {}),
      };
    }
    return liveIndex;
  }
  return stateIndex;
}

export function acceptLiveQuote(current, incoming) {
  if (!incoming || incoming.ok === false || !(incoming.close > 0)) return current;
  if (!current) return incoming;
  if (incoming.date > current.date) return incoming;
  if (incoming.date < current.date) return current;
  if (incoming.time && current.time && incoming.time < current.time && !current.stale) {
    return { ...current, fetchedAt: incoming.fetchedAt || current.fetchedAt };
  }
  return incoming;
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

const fmtTime = (iso, withSec = false) => {
  if (!iso) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TZ,
    hourCycle: 'h23',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSec ? { second: '2-digit' } : {}),
  }).format(new Date(iso));
};

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

  let subNote = '';
  if (d.marketPhase === 'intraday') {
    if (d.stale) subNote = '（即時連線重試中，暫顯示最近一筆快取）';
    else if (d.source === 'yahoo_tw') subNote = '（Yahoo 奇摩股市盤中即時）';
    else if (d.source === 'cnyes') subNote = '（鉅亨網盤中即時）';
    else if (d.source === 'yahoo') subNote = '（Yahoo Finance 盤中即時備援）';
    else subNote = '（證交所盤中即時行情）';
  } else if (d.source === 'mis') {
    subNote = '<br>暫用證交所即時行情終盤值，稍後以盤後正式資料確認';
  } else if (d.source === 'yahoo' || d.source === 'yahoo_tw' || d.source === 'cnyes') {
    subNote = '<br>暫用即時行情終盤值，稍後以盤後正式資料確認';
  }

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
    <p class="sub">較前一交易日收盤${subNote}</p>`;
}

export function indexBadge(d, today) {
  if (!d || d.date !== today) return '';
  if (d.marketPhase === 'intraday') {
    return '<span class="badge badge--live"><i class="live-dot" aria-hidden="true"></i>盤中即時</span>';
  }
  if (d.source === 'mis' || d.source === 'yahoo' || d.source === 'yahoo_tw' || d.source === 'cnyes') {
    return '<span class="badge badge--temp">即時終盤</span>';
  }
  return '<span class="badge badge--closed">已收盤</span>';
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
    const timeText =
      card.key === 'index' && d.date === today && d.time
        ? `報價 ${escapeHtml(d.time)}`
        : d.fetchedAt
          ? `擷取 ${fmtTime(d.fetchedAt)}`
          : '';
    foot.innerHTML = `<span>資料日期 <b>${fmtDate(d.date)}</b></span><span>${timeText}</span>`;
  }

  // 每個資訊各自判斷：交易日且尚未取得當日資料 → 顯示「當日資訊尚未揭露」
  const pending = isPending(d?.date, today, state?.closedDates ?? []);
  notice.hidden = !pending;
  if (pending) {
    notice.textContent = d
      ? `當日資訊尚未揭露（目前顯示 ${fmtDate(d.date)} 資料）`
      : '當日資訊尚未揭露';
  }
  el.classList.toggle('is-pending', pending);

  // 三大法人：已取得當日不含鉅額版本、等待 20:00 後含鉅額版本。
  // 保留提示文字，但不加粗框（粗框只用在「當日資訊尚未揭露」）
  if (card.key === 'institutional' && d && d.date === today && d.stage === 'ex_block') {
    notice.hidden = false;
    notice.textContent = '目前為不含鉅額版本，20:00 後將更新為含鉅額';
  }
}

let state = null;
let liveState = null;
let lastSig = '';

export function renderAll() {
  const { date: today, time } = taipeiNow();
  document.getElementById('clock').textContent = time;
  if (!state) return;
  // 只有「日期變了」或「盤後／盤中資料變了」才重畫卡片（避免每秒重繪）
  const liveSig = liveState
    ? `${liveState.date}|${liveState.time}|${liveState.close}|${liveState.stale ? 1 : 0}|${liveState.fetchedAt}`
    : '';
  const sig = `${today}|${state.meta?.updatedAt}|${liveSig}`;
  if (sig === lastSig) return;
  lastSig = sig;
  for (const c of CARDS) renderCard(c, state, today, liveState);
  const candidates = [state.meta?.updatedAt];
  if (liveState?.date === today && liveState.fetchedAt) candidates.push(liveState.fetchedAt);
  const latestIso = candidates.filter(Boolean).sort().at(-1);
  const showSec = Boolean(liveState?.date === today && latestIso === liveState.fetchedAt);
  document.getElementById('meta-updated').textContent = latestIso
    ? `資料更新：${fmtTime(latestIso, showSec)}（台北時間）`
    : '資料更新：—';
}

/**
 * GitHub Pages 發佈要等 Pages 部署（通常 30 秒～數分鐘），所以另外直接讀 GitHub API 上的最新檔案，
 * 兩邊取較新的一份。僅在 *.github.io 上、且是盤後資料可能更新的時段才讀（避免耗用 API 額度）。
 */
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
  // cache: 'no-cache' 會帶 ETag 重新驗證；沒變時回 304，不佔 API 額度
  const res = await fetch(url, {
    cache: 'no-cache',
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

const newer = (a, b) => ((a?.meta?.updatedAt ?? '') >= (b?.meta?.updatedAt ?? '') ? a : b);

let liveInFlight = false;

async function loadLive() {
  if (typeof document !== 'undefined' && document.hidden) return;
  const endpoint = resolveLiveApiUrl();
  if (!endpoint || liveInFlight || !state) return;

  const { date: today, time } = taipeiNow();
  const forceLive =
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('forceLive') === '1';
  if (!forceLive) {
    if (!inIntradayWindow(today, time, state.closedDates ?? [])) return;
    if (state.index?.date === today && state.index.source && state.index.source !== 'mis') return;
  }

  liveInFlight = true;
  try {
    // _t 時間戳 + no-store：不吃任何瀏覽器／中間代理的舊快取
    const sep = endpoint.includes('?') ? '&' : '?';
    const res = await fetch(`${endpoint}${sep}_t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const json = await res.json();
    const next = acceptLiveQuote(liveState, json);
    if (next && next !== liveState) {
      liveState = next;
      renderAll();
    }
  } catch (e) {
    console.warn('讀取盤中即時大盤失敗', e?.message ?? e);
  } finally {
    liveInFlight = false;
  }
}

async function load() {
  if (typeof document !== 'undefined' && document.hidden && state) return; // 分頁在背景時不更新
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
  // 第一次取得盤後資料後，啟動盤中即時輪詢（之後由 livePoller 遞迴排程，不再由 load 觸發）
  if (!liveKicked && state) {
    liveKicked = true;
    livePoller?.start();
  }
}

let livePoller = null;
let liveKicked = false;

if (typeof document !== 'undefined') {
  livePoller = createLivePoller({ run: loadLive, isHidden: () => document.hidden });
  load();
  setInterval(load, 30 * 1000); // 每 30 秒同步盤後資料 / 行事曆
  setInterval(renderAll, 1000); // 每秒更新時鐘；跨過 00:00 時自動切換「尚未揭露」狀態
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      livePoller.stop(); // 切到其他分頁／縮小視窗：暫停即時抓取
    } else {
      load(); // 切回網頁：立刻同步盤後資料，並立即抓一次即時報價、恢復 2.5 秒輪詢
      livePoller.start();
    }
  });
}
