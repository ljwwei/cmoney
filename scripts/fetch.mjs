// 台股資訊抓取程式（Node 18+，無外部套件）
//
// 用法：
//   node scripts/fetch.mjs                  依目前台北時間，只抓「此刻該抓」的項目
//   node scripts/fetch.mjs --date=2026-11-10  補抓指定日期（視為該日 23:59，所有項目都到時間）
//
// 結束碼：0 = 今天沒事了（非交易日／全部抓齊／已過 23:55）；
//         10 = 今天還有項目沒抓齊，常駐輪詢（workflow）應稍後再跑一次。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dueTasks,
  remainingTasks,
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
  parseMisIndex,
  parseOpenApiIndexHist,
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
        // 不吃任何中間快取：「尚無資料」的回應若被快取，會讓抓取延遲到快取過期
        cache: 'no-store',
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (i < tries) await new Promise((r) => setTimeout(r, i * 1000));
    }
  }
  throw lastErr;
}

const getJson = async (url) => JSON.parse((await httpGet(url)).toString('utf8'));

// ---- 各資料來源。回傳 { status: 'ok' | 'nodata', value } ；網路錯誤則丟出例外 ----

// 加權指數有三個來源，依序取用：
//   1. 證交所盤後統計 MI_INDEX（正式資料，含漲跌點數與百分比）
//   2. 證交所即時行情 mis（13:30 收盤後約 13:33 就有終盤值，比盤後統計早）
//   3. 證交所 OpenAPI MI_5MINS_HIST（歷史日資料；前兩者都失敗時的備援）
// 先拿到 mis 的值會標記 source = 'mis'，之後 MI_INDEX 出來會自動覆蓋為正式值。
async function fetchIndexTwse(date) {
  const json = await getJson(
    `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(date)}&type=IND&response=json&_=${Date.now()}`,
  );
  if (json.date && json.date !== ymd(date)) return { status: 'nodata' };
  const v = parseIndex(json);
  return v ? { status: 'ok', value: v } : { status: 'nodata' };
}

async function fetchIndexMis(date) {
  const json = await getJson(
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0&_=${Date.now()}`,
  );
  const v = parseMisIndex(json, date);
  return v ? { status: 'ok', value: v } : { status: 'nodata' };
}

async function fetchIndexOpenApi(date) {
  const list = await getJson('https://openapi.twse.com.tw/v1/indicesReport/MI_5MINS_HIST');
  const v = parseOpenApiIndexHist(list, date);
  return v ? { status: 'ok', value: v } : { status: 'nodata' };
}

/**
 * 回傳 { status: 'ok', value, source } 或 { status: 'nodata', certain }。
 * certain = 兩個主要來源都「正常回應、但確定沒有今日資料」（用於判斷臨時休市；網路錯誤不算）。
 */
async function fetchIndex(date) {
  const [twse, mis] = await Promise.allSettled([fetchIndexTwse(date), fetchIndexMis(date)]);
  const ok = (r) => r.status === 'fulfilled' && r.value.status === 'ok';
  for (const [name, r] of [['MI_INDEX', twse], ['mis', mis]]) {
    if (r.status === 'rejected') console.warn(`加權指數來源 ${name} 失敗：${r.reason?.message ?? r.reason}`);
  }
  if (ok(twse)) return { status: 'ok', value: twse.value.value, source: 'twse' };
  if (ok(mis)) return { status: 'ok', value: mis.value.value, source: 'mis' };

  try {
    const r = await fetchIndexOpenApi(date);
    if (r.status === 'ok') return { status: 'ok', value: r.value, source: 'openapi' };
  } catch (e) {
    console.warn(`加權指數來源 OpenAPI 失敗：${e.message}`);
  }
  if (twse.status === 'rejected' && mis.status === 'rejected') throw twse.reason;
  return { status: 'nodata', certain: twse.status === 'fulfilled' && mis.status === 'fulfilled' };
}

async function fetchInstitutional(date) {
  const json = await getJson(
    `https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${ymd(date)}&response=json&_=${Date.now()}`,
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
    `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd(date)}&selectType=MS&response=json&_=${Date.now()}`,
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
        changed = apply(state, 'index', today, { close, change, changePct }, nowIso, { source: r.source }) || changed;
        // 若這天先前被誤判為臨時休市，現在有資料就撤銷
        if (state.inferredClosed.includes(today)) {
          state.inferredClosed = state.inferredClosed.filter((d) => d !== today);
          state.closedDates = state.closedDates.filter((d) => d !== today);
          changed = true;
        }
      } else if (minutes >= INFER_CLOSED_AT && !backfill && r.certain) {
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

  // 今天還有項目沒抓齊 → 通知 workflow 的常駐輪詢稍後再跑
  if (!backfill && remainingTasks(state, new Date()).length) process.exitCode = 10;
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

