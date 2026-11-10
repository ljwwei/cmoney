// 台股資訊抓取程式（Node 18+，無外部套件）
//
// 用法：
//   node scripts/fetch.mjs                  依目前台北時間，只抓「此刻該抓」的項目
//   node scripts/fetch.mjs --date=2026-11-10  補抓指定日期（視為該日 23:59，所有項目都到時間）
//
// 結束碼 10 代表「融資餘額仍在 20:35 後的 2 分鐘輪詢區間且尚未取得」，
// 由 workflow 依此決定是否 2 分鐘後再跑一次。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dueTasks,
  institutionalStage,
  isTradingDay,
  taipeiParts,
  INFER_CLOSED_AT,
} from './schedule.mjs';
import {
  parseFuturesCsv,
  parseHolidays,
  parseIndex,
  parseInstitutional,
  parseBlockTradeScope,
  parseMargin,
} from './parsers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'data.json');
const UA = 'Mozilla/5.0 (compatible; cmoney-tw-stock-bot/1.0)';

const ymd = (date) => date.replace(/-/g, '');

async function httpGet(url, init = {}, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': UA, Accept: '*/*', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (i < tries) await new Promise((r) => setTimeout(r, i * 1500));
    }
  }
  throw lastErr;
}

const getJson = async (url) => JSON.parse((await httpGet(url)).toString('utf8'));

// ---- 各資料來源。回傳 { status: 'ok' | 'nodata', value } ；網路錯誤則丟出例外 ----

async function fetchIndex(date) {
  const json = await getJson(
    `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(date)}&type=IND&response=json`,
  );
  if (json.date && json.date !== ymd(date)) return { status: 'nodata' };
  const v = parseIndex(json);
  return v ? { status: 'ok', value: v } : { status: 'nodata' };
}

async function fetchInstitutional(date) {
  const json = await getJson(
    `https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${ymd(date)}&response=json`,
  );
  if (json.date && json.date !== ymd(date)) return { status: 'nodata' };
  const v = parseInstitutional(json);
  // 以 API 說明文字判斷是否含鉅額（含：true／不含：false／無法判讀：null）
  return v
    ? { status: 'ok', value: v, blockIncluded: parseBlockTradeScope(json.notes) }
    : { status: 'nodata' };
}

async function fetchMargin(date) {
  const json = await getJson(
    `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd(date)}&selectType=MS&response=json`,
  );
  if (json.date && json.date !== ymd(date)) return { status: 'nodata' };
  const v = parseMargin(json);
  return v ? { status: 'ok', value: v } : { status: 'nodata' };
}

async function fetchFutures(date) {
  const slash = date.replace(/-/g, '/');
  const body = new URLSearchParams({
    queryStartDate: slash,
    queryEndDate: slash,
    commodityId: 'TXF',
  });
  const buf = await httpGet('https://www.taifex.com.tw/cht/3/futContractsDateDown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const csv = new TextDecoder('big5').decode(buf); // 期交所 CSV 為 Big5 編碼
  const v = parseFuturesCsv(csv, date);
  return v ? { status: 'ok', value: v } : { status: 'nodata' };
}

async function refreshHolidays(state, today) {
  try {
    const list = await getJson('https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule');
    const fresh = parseHolidays(list);
    if (fresh.length) {
      state.closedDates = [...new Set([...(state.closedDates ?? []), ...fresh])].sort();
      state.meta.holidaysCheckedOn = today;
    }
  } catch (e) {
    console.warn(`休市日行事曆更新失敗：${e.message}`);
  }
}

// ---- 狀態讀寫 ----

async function loadState() {
  let s = {};
  try {
    s = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch {
    /* 第一次執行 */
  }
  s.meta ??= {};
  s.closedDates ??= [];
  s.inferredClosed ??= [];
  return s;
}

async function saveState(state) {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

const stable = (o) => JSON.stringify(o ?? null);

/** 只有在內容真的有變時才更新（避免無意義的 commit）。只會往「較新的日期」更新。 */
function apply(state, key, date, value, nowIso, extra = {}) {
  const prev = state[key];
  if (prev && prev.date > date) return false; // 補抓舊日期時，不覆蓋較新的資料
  const next = { date, ...value, ...extra };
  const same = prev && stable({ ...prev, fetchedAt: 0 }) === stable({ ...next, fetchedAt: 0 });
  if (same) return false;
  state[key] = { ...next, fetchedAt: nowIso };
  return true;
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--date='));
  const backfill = arg ? arg.slice('--date='.length) : null;
  const now = backfill ? new Date(`${backfill}T23:59:00+08:00`) : new Date();
  const { date: today, minutes } = taipeiParts(now);
  const nowIso = new Date().toISOString();

  const state = await loadState();
  let changed = false;

  // 每個交易日第一次執行，以及早上的檢查（天災臨時休市通常早上公告）時，更新休市日行事曆
  if (backfill || state.meta.holidaysCheckedOn !== today || minutes < 12 * 60) {
    const before = stable(state.closedDates) + state.meta.holidaysCheckedOn;
    await refreshHolidays(state, today);
    if (before !== stable(state.closedDates) + state.meta.holidaysCheckedOn) changed = true;
  }

  if (!isTradingDay(today, state.closedDates)) {
    console.log(`${today} 非交易日，不抓取。`);
    if (changed) await finish(state, nowIso);
    return;
  }

  const due = dueTasks(state, now);
  console.log(`${today} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} 待抓取：${due.join(', ') || '（無）'}`);

  // 1) 加權指數（同時負責偵測臨時休市）
  if (due.includes('index')) {
    try {
      const r = await fetchIndex(today);
      if (r.status === 'ok') {
        let { close, change, changePct } = r.value;
        // 證交所若未提供漲跌，改用前一個交易日收盤價自行計算
        if (change == null || changePct == null) {
          const prev = state.index;
          if (prev && prev.date < today) {
            change = +(close - prev.close).toFixed(2);
            changePct = +((change / prev.close) * 100).toFixed(2);
          }
        }
        changed = apply(state, 'index', today, { close, change, changePct }, nowIso) || changed;
        // 若這天先前被誤判為臨時休市，現在有資料就撤銷
        if (state.inferredClosed.includes(today)) {
          state.inferredClosed = state.inferredClosed.filter((d) => d !== today);
          state.closedDates = state.closedDates.filter((d) => d !== today);
          changed = true;
        }
      } else if (minutes >= INFER_CLOSED_AT && !backfill) {
        console.log(`${today} 已過 ${INFER_CLOSED_AT / 60}:00 仍無加權指數資料，判定為臨時休市，今日不再抓取。`);
        state.inferredClosed = [...new Set([...state.inferredClosed, today])].sort();
        state.closedDates = [...new Set([...state.closedDates, today])].sort();
        changed = true;
        await finish(state, nowIso);
        return;
      } else if (backfill) {
        console.log(`${today} 無加權指數資料（可能為休市日）。`);
      }
    } catch (e) {
      console.warn(`加權指數抓取失敗：${e.message}`);
    }
  }

  // 2) 外資期貨未平倉
  if (due.includes('futures')) {
    try {
      const r = await fetchFutures(today);
      if (r.status === 'ok') changed = apply(state, 'futures', today, r.value, nowIso) || changed;
    } catch (e) {
      console.warn(`外資期貨未平倉抓取失敗：${e.message}`);
    }
  }

  // 3) 三大法人（20:00 前為不含鉅額；20:00 後為含鉅額）
  if (due.includes('institutional')) {
    try {
      const r = await fetchInstitutional(today);
      if (r.status === 'ok') {
        // 以證交所說明文字為準；說明文字缺漏時才退回依時間判斷（20:00 前不含、後含）
        const stage =
          r.blockIncluded === true
            ? 'with_block'
            : r.blockIncluded === false
              ? 'ex_block'
              : institutionalStage(now);
        console.log(`三大法人：證交所說明文字判定為 ${r.blockIncluded === null ? `（無法判讀，依時間）${stage}` : stage}`);
        changed = apply(state, 'institutional', today, r.value, nowIso, { stage }) || changed;
      }
    } catch (e) {
      console.warn(`三大法人抓取失敗：${e.message}`);
    }
  }

  // 4) 融資餘額
  if (due.includes('margin')) {
    try {
      const r = await fetchMargin(today);
      if (r.status === 'ok') changed = apply(state, 'margin', today, r.value, nowIso) || changed;
    } catch (e) {
      console.warn(`融資餘額抓取失敗：${e.message}`);
    }
  }

  if (changed) await finish(state, nowIso);
  else console.log('無資料變動。');

  // 融資餘額仍在 2 分鐘輪詢區間 → 通知 workflow 稍後再跑
  if (!backfill && dueTasks(state, new Date()).includes('margin')) process.exitCode = 10;
}

async function finish(state, nowIso) {
  state.meta.updatedAt = nowIso;
  await saveState(state);
  console.log('data/data.json 已更新。');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

