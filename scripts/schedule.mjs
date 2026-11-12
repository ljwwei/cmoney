// 排程與交易日判斷（純函式，不做任何網路請求，方便測試）
// 所有時間一律以台北時間 (UTC+8) 計算。

export const TASKS = ['index', 'futures', 'institutional', 'margin'];

// 每日開始抓取的時間（台北時間，單位：從 00:00 起算的分鐘數）。
// 到時間後，由常駐輪詢（見 update.yml）每 30 秒檢查一次，直到抓到為止；
// 提早開始只是多幾次「尚無資料」的查詢，不會有副作用。
export const START_AT = {
  index: 13 * 60 + 30, // 加權指數：13:30 收盤後（即時行情 13:33 即有終盤值）
  futures: 14 * 60 + 30, // 外資期貨未平倉
  institutional: 14 * 60 + 30, // 三大法人（不含鉅額）
  institutionalBlock: 20 * 60, // 三大法人（含鉅額）：20:00 後
  margin: 20 * 60 + 30, // 融資餘額
};

// 交易日、但加權指數到這個時間仍「確定無資料」時，推斷為臨時休市（颱風、天災等）
export const INFER_CLOSED_AT = 16 * 60;

// 加權指數若先取得的是即時行情終盤值（source = 'mis'），要等證交所盤後正式資料來確認；
// 超過這個時間仍未取得正式資料，就以即時行情值為準、不再追。
export const INDEX_CONFIRM_UNTIL = 18 * 60;

// 當日最後輪詢時間（23:55）。過了就不再抓，避免輪詢跨日
export const DAY_END = 23 * 60 + 55;

/** 取得台北時間的日期字串 (YYYY-MM-DD)、分鐘數、星期 */
export function taipeiParts(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
    dow: t.getUTCDay(),
  };
}

export function dayOfWeek(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** 是否為交易日：週末、證交所休市日（國定假日、春節、颱風假等）皆非交易日 */
export function isTradingDay(dateStr, closedDates = []) {
  const dow = dayOfWeek(dateStr);
  if (dow === 0 || dow === 6) return false;
  return !new Set(closedDates).has(dateStr);
}

/** 各項目「今天是否已經抓齊」 */
function isDone(task, state, today, minutes) {
  const d = state[task];
  if (d?.date !== today) return false;
  if (task === 'index') return d.source !== 'mis' || minutes >= INDEX_CONFIRM_UNTIL;
  if (task === 'institutional') return d.stage === 'with_block';
  // 已存的資料若是整列 0（舊版沒有防呆時存進去的），不算抓齊，要重抓
  if (task === 'futures') return !(d.long === 0 && d.short === 0);
  return true;
}

/**
 * 依目前狀態判斷「此刻需要抓取」的項目（已到開始時間、且尚未抓齊）。
 * 回傳陣列，元素為 TASKS 其中之一。非交易日一律回傳空陣列。
 */
export function dueTasks(state, now = new Date()) {
  const { date: today, minutes } = taipeiParts(now);
  if (!isTradingDay(today, state.closedDates)) return [];

  const due = [];
  if (minutes >= START_AT.index && !isDone('index', state, today, minutes)) due.push('index');
  if (minutes >= START_AT.futures && !isDone('futures', state, today, minutes)) due.push('futures');

  const inst = state.institutional;
  if (minutes >= START_AT.institutional) {
    if (inst?.date !== today) {
      due.push('institutional'); // 第一次（20:00 前為不含鉅額）
    } else if (inst.stage === 'ex_block' && minutes >= START_AT.institutionalBlock) {
      due.push('institutional'); // 第二次（含鉅額）
    }
  }

  if (minutes >= START_AT.margin && !isDone('margin', state, today, minutes)) due.push('margin');
  return due;
}

/**
 * 今天「還沒抓齊」的項目（不論開始時間是否已到）。
 * 回傳空陣列＝今天沒事了（非交易日／全部抓齊／已過當日輪詢截止時間），常駐輪詢可以結束。
 */
export function remainingTasks(state, now = new Date()) {
  const { date: today, minutes } = taipeiParts(now);
  if (!isTradingDay(today, state.closedDates) || minutes >= DAY_END) return [];
  return TASKS.filter((t) => !isDone(t, state, today, minutes));
}

/** 三大法人此刻抓到的資料，應標記為哪個階段 */
export function institutionalStage(now = new Date()) {
  return taipeiParts(now).minutes >= START_AT.institutionalBlock ? 'with_block' : 'ex_block';
}
