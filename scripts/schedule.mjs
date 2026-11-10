// 排程與交易日判斷（純函式，不做任何網路請求，方便測試）
// 所有時間一律以台北時間 (UTC+8) 計算。

export const TASKS = ['index', 'futures', 'institutional', 'margin'];

// 每日開始抓取的時間（台北時間，單位：從 00:00 起算的分鐘數）
export const START_AT = {
  index: 13 * 60 + 40, // 加權指數：13:40 後每 5 分鐘
  futures: 14 * 60 + 50, // 外資期貨未平倉：14:50 後每 5 分鐘
  institutional: 15 * 60, // 三大法人（不含鉅額）：15:00 後每 5 分鐘
  institutionalBlock: 20 * 60, // 三大法人（含鉅額）：20:00 後每 5 分鐘
  margin: 20 * 60 + 35, // 融資餘額：20:35 後每 2 分鐘
};

// 交易日、但加權指數到這個時間仍「確定無資料」時，推斷為臨時休市（颱風、天災等）
export const INFER_CLOSED_AT = 16 * 60;

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

/**
 * 依目前狀態判斷「此刻需要抓取」的項目。
 * 回傳陣列，元素為 TASKS 其中之一。非交易日一律回傳空陣列。
 */
export function dueTasks(state, now = new Date()) {
  const { date: today, minutes } = taipeiParts(now);
  if (!isTradingDay(today, state.closedDates)) return [];

  const due = [];
  if (minutes >= START_AT.index && state.index?.date !== today) due.push('index');
  if (minutes >= START_AT.futures && state.futures?.date !== today) due.push('futures');

  const inst = state.institutional;
  if (minutes >= START_AT.institutional) {
    if (inst?.date !== today) {
      due.push('institutional'); // 第一次（20:00 前為不含鉅額）
    } else if (inst.stage === 'ex_block' && minutes >= START_AT.institutionalBlock) {
      due.push('institutional'); // 第二次（含鉅額）
    }
  }

  if (minutes >= START_AT.margin && state.margin?.date !== today) due.push('margin');
  return due;
}

/** 三大法人此刻抓到的資料，應標記為哪個階段 */
export function institutionalStage(now = new Date()) {
  return taipeiParts(now).minutes >= START_AT.institutionalBlock ? 'with_block' : 'ex_block';
}
