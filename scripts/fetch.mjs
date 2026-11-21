// 台股資訊抓取程式（Node 18+，無外部套件）
//
// 用法：
//   node scripts/fetch.mjs                  依目前台北時間，只抓「此刻該抓」的項目
//   node scripts/fetch.mjs --date=2026-11-10  補抓指定日期（視為該日 23:59，所有項目都到時間）
//
// 結束碼：0 = 今天沒事了（非交易日／全部抓齊／已過 23:55）；
//         10 = 今天還有項目沒抓齊，常駐輪詢（workflow）應稍後再跑一次。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
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
  mergeClosedDates,
  parseTwseDisasterClosures,
  parseDgpaTaipeiClosures,
  parseIndex,
  parseInstitutional,
  parseBlockTradeScope,
  parseMargin,
  parseOpenApiIndexHist,
  parseTwseIndexHist,
} from './parsers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'data.json');
const DISASTER_STAMP_FILE = path.join(os.tmpdir(), 'cmoney-disaster-check.json');
const DISASTER_CHECK_INTERVAL_MS = 15 * 60 * 1000;
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

// 加權指數盤後來源：
//   1. 證交所盤後統計 MI_INDEX（正式收盤價與漲跌）
//   2. 證交所每日指數統計 MI_5MINS_HIST（開盤、最高、最低與備援收盤）
//   3. 證交所 OpenAPI MI_5MINS_HIST（前兩者失敗時的備援）
async function fetchIndexTwse(date) {
  const json = await getJson(
    `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(date)}&type=IND&response=json&_=${Date.now()}`,
  );
  if (json.date && json.date !== ymd(date)) return { status: 'nodata' };
  const v = parseIndex(json);
  return v ? { status: 'ok', value: v } : { status: 'nodata' };
}

async function fetchIndexHistRwd(date) {
  const json = await getJson(
    `https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?date=${ymd(date)}&response=json&_=${Date.now()}`,
  );
  const v = parseTwseIndexHist(json, date);
  return v ? { status: 'ok', value: v } : { status: 'nodata' };
}

async function fetchIndexOpenApi(date) {
  const list = await getJson('https://openapi.twse.com.tw/v1/indicesReport/MI_5MINS_HIST');
  const v = parseOpenApiIndexHist(list, date);
  return v ? { status: 'ok', value: v } : { status: 'nodata' };
}

function attachOhlc(base, ...sources) {
  const result = { ...base };
  for (const src of sources) {
    if (!src) continue;
    if (!(result.open > 0) && src.open > 0) result.open = src.open;
    if (!(result.high > 0) && src.high > 0) result.high = src.high;
    if (!(result.low > 0) && src.low > 0) result.low = src.low;
  }
  return result;
}

/**
 * 回傳 { status: 'ok', value, source } 或 { status: 'nodata', certain }。
 * certain = 主要來源都「正常回應、但確定沒有今日資料」（用於判斷臨時休市；網路錯誤不算）。
 * 一併取得開盤、最高、最低（由 MI_5MINS_HIST 補齊）。
 */
async function fetchIndex(date) {
  const [twse, histRwd] = await Promise.allSettled([
    fetchIndexTwse(date),
    fetchIndexHistRwd(date),
  ]);
  const ok = (r) => r.status === 'fulfilled' && r.value.status === 'ok';
  const val = (r) => (ok(r) ? r.value.value : null);

  for (const [name, r] of [['MI_INDEX', twse], ['MI_5MINS_HIST', histRwd]]) {
    if (r.status === 'rejected') console.warn(`加權指數來源 ${name} 失敗：${r.reason?.message ?? r.reason}`);
  }

  let base = null;
  let source = null;
  if (ok(twse)) {
    base = val(twse);
    source = 'twse';
  } else if (ok(histRwd)) {
    base = val(histRwd);
    source = 'twse';
  }

  if (base) {
    let enriched = attachOhlc(base, val(histRwd));
    if (!(enriched.open > 0 && enriched.high > 0 && enriched.low > 0)) {
      try {
        const oa = await fetchIndexOpenApi(date);
        if (oa.status === 'ok') enriched = attachOhlc(enriched, oa.value);
      } catch (e) {
        console.warn(`加權指數補充 OpenAPI OHLC 失敗：${e.message}`);
      }
    }
    return { status: 'ok', value: enriched, source };
  }

  try {
    const r = await fetchIndexOpenApi(date);
    if (r.status === 'ok') return { status: 'ok', value: r.value, source: 'openapi' };
  } catch (e) {
    console.warn(`加權指數來源 OpenAPI 失敗：${e.message}`);
  }
  if (twse.status === 'rejected' && histRwd.status === 'rejected') {
    throw twse.reason;
  }
  return {
    status: 'nodata',
    certain: twse.status === 'fulfilled' && histRwd.status === 'fulfilled',
  };
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

function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

async function fetchFutures(date) {
  const endSlash = date.replace(/-/g, '/');
  const startSlash = shiftDate(date, -20).replace(/-/g, '/');
  const body = new URLSearchParams({
    queryStartDate: startSlash,
    queryEndDate: endSlash,
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
      state.closedDates = mergeClosedDates(state.closedDates, fresh, today);
      state.inferredClosed = mergeClosedDates(state.inferredClosed, [], today);
      if (!state.meta.holidaysCheckedOn || today > state.meta.holidaysCheckedOn) {
        state.meta.holidaysCheckedOn = today;
      }
    }
  } catch (e) {
    console.warn(`休市日行事曆更新失敗：${e.message}`);
  }
}

async function shouldRunDisasterCheck(minutes, nowMs, backfill) {
  if (backfill) return false;
  // 僅於上午（含 08:30 早檢）與晚間 20:00 後（含 20:00/20:20/21:20 隔日颱風停班公告期）檢查
  if (!(minutes < 12 * 60 || minutes >= 20 * 60)) return false;
  try {
    const raw = JSON.parse(await readFile(DISASTER_STAMP_FILE, 'utf8'));
    if (raw?.ts && nowMs - raw.ts < DISASTER_CHECK_INTERVAL_MS) return false;
  } catch {
    /* 尚未建立節流檔 */
  }
  try {
    await writeFile(DISASTER_STAMP_FILE, JSON.stringify({ ts: nowMs }), 'utf8');
  } catch {}
  return true;
}

/** 主動偵測證交所天然災害新聞與人事行政總處臺北市停班公告，於前晚或當日 08:30 提前寫入休市日 */
async function refreshDisasterClosures(state, today) {
  const [twseNews, dgpaHtml] = await Promise.allSettled([
    getJson('https://openapi.twse.com.tw/v1/news/newsList'),
    httpGet('https://www.dgpa.gov.tw/typh/daily/nds.html').then((b) => b.toString('utf8')),
  ]);

  const detected = [];
  if (twseNews.status === 'fulfilled') {
    const dates = parseTwseDisasterClosures(twseNews.value, today);
    if (dates.length) console.log(`證交所新聞公告偵測到臨時休市：${dates.join(', ')}`);
    detected.push(...dates);
  } else {
    console.warn(`證交所新聞公告查詢失敗：${twseNews.reason?.message ?? twseNews.reason}`);
  }

  if (dgpaHtml.status === 'fulfilled') {
    const dates = parseDgpaTaipeiClosures(dgpaHtml.value, today);
    if (dates.length) console.log(`人事行政總處偵測到臺北市停止上班（休市）：${dates.join(', ')}`);
    detected.push(...dates);
  } else {
    console.warn(`人事行政總處停班停課查詢失敗：${dgpaHtml.reason?.message ?? dgpaHtml.reason}`);
  }

  if (detected.length) {
    state.closedDates = mergeClosedDates(state.closedDates, detected, today);
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
    const before = stable(state.closedDates) + stable(state.inferredClosed) + state.meta.holidaysCheckedOn;
    await refreshHolidays(state, today);
    if (before !== stable(state.closedDates) + stable(state.inferredClosed) + state.meta.holidaysCheckedOn) {
      changed = true;
    }
  }

  // 主動偵測證交所新聞公告與人事總處臺北市停班公告（上午早檢＋前晚 20:00 後隔日颱風停班預告，每 15 分鐘節流）
  if (await shouldRunDisasterCheck(minutes, Date.now(), Boolean(backfill))) {
    const before = stable(state.closedDates);
    await refreshDisasterClosures(state, today);
    if (before !== stable(state.closedDates)) changed = true;
  }

  // 若今日先前係依 14:15 無資料自動推斷為臨時休市，後續定時喚醒時做單次輕量自癒複檢：
  // 只要證交所後來釋出今日加權指數即自動撤銷誤判並恢復抓取；否則直接結束不進入輪詢
  let preFetchedIndex = null;
  if (!backfill && state.inferredClosed.includes(today) && minutes >= INFER_CLOSED_AT) {
    try {
      const probe = await fetchIndex(today);
      if (probe.status === 'ok') {
        console.log(`${today} 複檢已取得加權指數，自動撤銷臨時休市推斷並恢復抓取。`);
        state.inferredClosed = state.inferredClosed.filter((d) => d !== today);
        state.closedDates = state.closedDates.filter((d) => d !== today);
        preFetchedIndex = probe;
        changed = true;
      } else {
        console.log(`${today} 臨時休市複檢仍無加權指數資料，維持休市狀態。`);
        if (changed) await finish(state, nowIso);
        return;
      }
    } catch (e) {
      console.warn(`${today} 臨時休市複檢失敗：${e.message}`);
      if (changed) await finish(state, nowIso);
      return;
    }
  }

  if (!backfill && !isTradingDay(today, state.closedDates)) {
    console.log(`${today} 非交易日，不抓取。`);
    if (changed) await finish(state, nowIso);
    return;
  }

  const effectiveState = backfill
    ? { ...state, closedDates: (state.closedDates ?? []).filter((d) => d !== today) }
    : state;
  const due = dueTasks(effectiveState, now);
  if (
    backfill &&
    !due.includes('index') &&
    state.index?.date === today &&
    !(state.index.open > 0 && state.index.high > 0 && state.index.low > 0)
  ) {
    due.push('index');
  }
  if (
    backfill &&
    !due.includes('futures') &&
    state.futures?.date === today &&
    state.futures.prevForeignNet == null
  ) {
    due.push('futures');
  }
  console.log(`${today} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} 待抓取：${due.join(', ') || '（無）'}`);

  // 1) 加權指數（同時負責偵測臨時休市）
  if (due.includes('index')) {
    try {
      const r = preFetchedIndex ?? (await fetchIndex(today));
      if (r.status === 'ok') {
        let { close, change, changePct, open, high, low } = r.value;
        // 證交所若未提供漲跌，改用前一個交易日收盤價自行計算
        if (change == null || changePct == null) {
          const prev = state.index;
          if (prev && prev.date < today) {
            change = +(close - prev.close).toFixed(2);
            changePct = +((change / prev.close) * 100).toFixed(2);
          }
        }
        const payload = {
          close,
          change,
          changePct,
          ...(open > 0 ? { open } : {}),
          ...(high > 0 ? { high } : {}),
          ...(low > 0 ? { low } : {}),
        };
        const hasOhlc = payload.open > 0 && payload.high > 0 && payload.low > 0;
        changed =
          apply(state, 'index', today, payload, nowIso, {
            source: r.source,
            ...(!hasOhlc ? { ohlcPending: true } : {}),
          }) || changed;
        // 若這天先前被誤判為臨時休市，現在有資料就撤銷
        if (state.inferredClosed.includes(today) || (backfill && state.closedDates.includes(today))) {
          state.inferredClosed = state.inferredClosed.filter((d) => d !== today);
          state.closedDates = state.closedDates.filter((d) => d !== today);
          changed = true;
        }
      } else if (minutes >= INFER_CLOSED_AT && !backfill && r.certain) {
        const inferLabel = `${String(Math.floor(INFER_CLOSED_AT / 60)).padStart(2, '0')}:${String(INFER_CLOSED_AT % 60).padStart(2, '0')}`;
        console.log(`${today} 已過 ${inferLabel} 仍無加權指數資料，判定為臨時休市，今日不再抓取。`);
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

  // 2) 外資台股期貨空單（含前一交易日淨額）
  if (due.includes('futures')) {
    try {
      const r = await fetchFutures(today);
      if (r.status === 'ok') {
        const prevFut = state.futures;
        const fallbackPrevNet =
          prevFut && prevFut.date < today && Number.isFinite(prevFut.foreignNet)
            ? prevFut.foreignNet
            : prevFut?.date === today && Number.isFinite(prevFut.prevForeignNet)
              ? prevFut.prevForeignNet
              : null;
        const payload = {
          ...r.value,
          ...(r.value.prevForeignNet == null && fallbackPrevNet != null
            ? { prevForeignNet: fallbackPrevNet }
            : {}),
        };
        changed = apply(state, 'futures', today, payload, nowIso) || changed;
      }
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
  if (!backfill) {
    const remaining = remainingTasks(state, new Date());
    if (remaining.length) {
      process.exitCode = 10;
    } else if (minutes < 13 * 60) {
      console.log('目前尚未到盤後時段（13:00 前），不啟動常駐輪詢，直接退出。');
    }
  }
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

