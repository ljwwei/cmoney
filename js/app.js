// 前端顯示邏輯（純函式 + 渲染）。所有「今天」的判斷都以台北時間為準。

const TZ = 'Asia/Taipei';
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

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

const fmtTime = (iso) => {
  if (!iso) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TZ,
    hourCycle: 'h23',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
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

function renderIndex(d) {
  const cls = dirClass(d.change ?? 0);
  const arrow = d.change > 0 ? '▲' : d.change < 0 ? '▼' : '—';
  const pts = d.change == null ? '—' : `${sgn(d.change)}${fmt(Math.abs(d.change), 2)}`;
  const pct = d.changePct == null ? '—' : `${sgn(d.changePct)}${fmt(Math.abs(d.changePct), 2)}%`;
  return `
    <div class="index ${cls}">
      <div class="index__close">${fmt(d.close, 2)}</div>
      <div class="index__chg">
        <span class="chip ${cls}"><span class="arrow">${arrow}</span> ${pts}</span>
        <span class="chip ${cls}">${pct}</span>
      </div>
    </div>
    <p class="sub">較前一交易日收盤${
      d.source === 'mis' ? '<br>暫用證交所即時行情終盤值，稍後以盤後正式資料確認' : ''
    }</p>`;
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
  { id: 'card-index', key: 'index', render: renderIndex },
  { id: 'card-inst', key: 'institutional', render: renderInst, badge: instBadge },
  { id: 'card-fut', key: 'futures', render: renderFut },
  { id: 'card-margin', key: 'margin', render: renderMargin },
];

function renderCard(card, state, today) {
  const el = document.getElementById(card.id);
  const d = state?.[card.key];
  const body = el.querySelector('.card__body');
  const notice = el.querySelector('.notice');
  const foot = el.querySelector('.card__foot');
  el.querySelector('.badge-slot').innerHTML = d && card.badge ? card.badge(d) : '';

  if (!d) {
    body.innerHTML = '<p class="empty">尚無資料</p>';
    foot.textContent = '';
  } else {
    body.innerHTML = card.render(d);
    foot.innerHTML = `<span>資料日期 <b>${fmtDate(d.date)}</b></span><span>${
      d.fetchedAt ? `擷取 ${fmtTime(d.fetchedAt)}` : ''
    }</span>`;
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

  // 三大法人：已取得當日不含鉅額版本、等待 20:00 後含鉅額版本
  if (card.key === 'institutional' && d && d.date === today && d.stage === 'ex_block') {
    notice.hidden = false;
    notice.textContent = '目前為不含鉅額版本，20:00 後將更新為含鉅額';
    el.classList.add('is-pending');
  }
}

let state = null;
let lastSig = '';

export function renderAll() {
  const { date: today, time } = taipeiNow();
  document.getElementById('clock').textContent = time;
  if (!state) return;
  // 只有「日期變了」或「資料變了」才重畫卡片（避免每秒重繪）
  const sig = `${today}|${state.meta?.updatedAt}`;
  if (sig === lastSig) return;
  lastSig = sig;
  for (const c of CARDS) renderCard(c, state, today);
  document.getElementById('meta-updated').textContent = state.meta?.updatedAt
    ? `資料更新：${fmtTime(state.meta.updatedAt)}（台北時間）`
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
}

if (typeof document !== 'undefined') {
  load();
  setInterval(load, 30 * 1000); // 每 30 秒取得最新資料
  setInterval(renderAll, 1000); // 每秒更新時鐘；跨過 00:00 時自動切換「尚未揭露」狀態
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });
}
