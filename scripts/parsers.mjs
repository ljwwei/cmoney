// 各資料來源的解析函式（純函式）

const num = (s) => {
  if (typeof s === 'number') return s;
  const n = Number(String(s ?? '').replace(/,/g, '').replace(/<[^>]*>/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
};

/**
 * 證交所 MI_INDEX（type=IND）：發行量加權股價指數
 * 漲跌正負號放在「漲跌(+/-)」欄位的 HTML 裡（color:red 為漲、color:green 為跌）
 */
export function parseIndex(json) {
  if (!json || json.stat !== 'OK') return null;
  for (const table of json.tables ?? []) {
    for (const row of table.data ?? []) {
      if (String(row[0]).trim() !== '發行量加權股價指數') continue;
      const close = num(row[1]);
      const signCell = String(row[2] ?? '');
      const sign = /green|-/.test(signCell) ? -1 : /red|\+/.test(signCell) ? 1 : 0;
      const points = Math.abs(num(row[3]));
      const pct = Math.abs(num(row[4]));
      if (!Number.isFinite(close)) return null;
      return {
        close,
        change: Number.isFinite(points) ? sign * points : null,
        changePct: Number.isFinite(pct) ? sign * pct : null,
      };
    }
  }
  return null;
}

/**
 * 證交所盤後日統計 /indicesReport/MI_5MINS_HIST（含單日開盤、最高、最低、收盤指數）。
 * 支援依指定日期回溯歷史或當日收盤 OHLC。
 */
export function parseTwseIndexHist(json, date) {
  if (!json || json.stat !== 'OK' || !Array.isArray(json.data)) return null;
  const rocSlash = `${Number(date.slice(0, 4)) - 1911}/${date.slice(5, 7)}/${date.slice(8, 10)}`;
  const idx = json.data.findIndex((r) => String(r[0] ?? '').trim() === rocSlash);
  if (idx < 0) return null;
  const row = json.data[idx];
  const open = num(row[1]);
  const high = num(row[2]);
  const low = num(row[3]);
  const close = num(row[4]);
  if (!Number.isFinite(close) || close <= 0) return null;
  const prevRow = idx > 0 ? json.data[idx - 1] : null;
  const prev = prevRow ? num(prevRow[4]) : NaN;
  const change = Number.isFinite(prev) && prev > 0 ? +(close - prev).toFixed(2) : null;
  const changePct = change != null ? +((change / prev) * 100).toFixed(2) : null;
  return {
    close,
    change,
    changePct,
    ...(open > 0 ? { open } : {}),
    ...(high > 0 ? { high } : {}),
    ...(low > 0 ? { low } : {}),
  };
}

/**
 * 證交所 OpenAPI /indicesReport/MI_5MINS_HIST（發行量加權股價指數歷史資料，日資料）。
 * 日期為民國 yyyMMdd；漲跌以清單中前一個交易日收盤計算（月初第一天無前一筆時為 null）。
 */
export function parseOpenApiIndexHist(list, date) {
  if (!Array.isArray(list)) return null;
  const roc = (d) => `${Number(d.slice(0, 4)) - 1911}${d.slice(5, 7)}${d.slice(8, 10)}`;
  const rows = list
    .map((r) => ({
      date: String(r.Date ?? '').trim(),
      open: num(r.OpeningIndex),
      high: num(r.HighestIndex),
      low: num(r.LowestIndex),
      close: num(r.ClosingIndex),
    }))
    .filter((r) => r.date && Number.isFinite(r.close))
    .sort((a, b) => a.date.localeCompare(b.date));
  const i = rows.findIndex((r) => r.date === roc(date));
  if (i < 0) return null;
  const { close, open, high, low } = rows[i];
  const ohlc = {
    ...(open > 0 ? { open } : {}),
    ...(high > 0 ? { high } : {}),
    ...(low > 0 ? { low } : {}),
  };
  if (i === 0) return { close, change: null, changePct: null, ...ohlc };
  const prev = rows[i - 1].close;
  const change = +(close - prev).toFixed(2);
  return { close, change, changePct: +((change / prev) * 100).toFixed(2), ...ohlc };
}

/**
 * 從 BFI82U 回傳的 notes 判斷統計範圍是否含鉅額。
 * 證交所說明文字：
 *   含鉅額　→「本統計資訊含一般、零股、盤後定價、鉅額，不含拍賣、標購。」
 *   不含鉅額 → 鉅額會被列在「不含」之後
 * 回傳 true（含）、false（不含）、null（說明文字缺漏或無法判讀）。
 */
export function parseBlockTradeScope(notes) {
  const note = (Array.isArray(notes) ? notes : []).find((n) => /本統計資訊/.test(String(n)));
  if (!note) return null;
  const text = String(note).replace(/<[^>]*>/g, '');
  const i = text.indexOf('不含');
  const included = i >= 0 ? text.slice(0, i) : text;
  const excluded = i >= 0 ? text.slice(i) : '';
  if (included.includes('鉅額')) return true;
  if (excluded.includes('鉅額')) return false;
  return null;
}

/** 證交所 BFI82U：三大法人買賣金額統計表（單位：元） */
export function parseInstitutional(json) {
  if (!json || json.stat !== 'OK' || !Array.isArray(json.data)) return null;
  const rows = new Map(json.data.map((r) => [String(r[0]).trim(), r]));
  const pick = (...names) => {
    for (const n of names) {
      for (const [k, r] of rows) {
        if (k === n || k.startsWith(n)) return { buy: num(r[1]), sell: num(r[2]), net: num(r[3]) };
      }
    }
    return null;
  };
  const sum = (a, b) => ({ buy: a.buy + b.buy, sell: a.sell + b.sell, net: a.net + b.net });

  // 自營商 = 自行買賣 + 避險（外資自營商已計入自營商，不重複）
  const dealerSelf = pick('自營商(自行買賣)');
  const dealerHedge = pick('自營商(避險)');
  const dealer = dealerSelf && dealerHedge ? sum(dealerSelf, dealerHedge) : pick('自營商');
  const trust = pick('投信');
  const foreign = pick('外資及陸資(不含外資自營商)', '外資及陸資');
  const total = pick('合計');
  if (!dealer || !trust || !foreign) return null;
  if ([dealer, trust, foreign].some((x) => Object.values(x).some(Number.isNaN))) return null;
  // 防呆：整張表金額全是 0 不是正常資料（尚未開始提供），視為無資料
  if ([dealer, trust, foreign].every((x) => x.buy === 0 && x.sell === 0)) return null;
  return { dealer, trust, foreign, total };
}

/** 證交所 MI_MARGN（selectType=MS）：信用交易統計，融資金額（仟元） */
export function parseMargin(json) {
  if (!json || json.stat !== 'OK') return null;
  for (const table of json.tables ?? []) {
    for (const row of table.data ?? []) {
      if (!String(row[0]).startsWith('融資金額')) continue;
      const prevBalance = num(row[4]);
      const balance = num(row[5]);
      if (!Number.isFinite(balance) || !Number.isFinite(prevBalance)) return null;
      if (balance === 0 && prevBalance === 0) return null; // 全 0 不是正常資料
      return { balance, prevBalance };
    }
  }
  return null;
}

function parseFuturesRow(line) {
  const c = line.split(',').map((s) => s.trim());
  if (c.length < 14) return null;
  if (c[1] !== '臺股期貨' || !c[2].startsWith('外資')) return null;
  const net = num(c[13]);
  if (!Number.isFinite(net)) return null;
  // 防呆：期交所剛開始提供資料時，欄位可能整列都是 0。外資未平倉多空方不可能同時為 0，
  // 整列全 0 一律視為「尚未提供正式資料」，繼續等
  const nums = c.slice(3, 15).map(num);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (nums.every((n) => n === 0)) return null;
  const long = num(c[9]);
  const short = num(c[11]);
  if (long === 0 && short === 0) return null;
  return { rowDate: c[0], foreignNet: net, long, short };
}

/**
 * 期交所「三大法人-區分各期貨契約」CSV（臺股期貨）。
 * 回傳指定日期、外資及陸資的未平倉多空淨額口數；若 CSV 含較早交易日資料，亦帶回最近一筆前一交易日淨額 (prevForeignNet)。
 * @param {string} csv 已解碼的 CSV 文字
 * @param {string} date YYYY-MM-DD
 */
export function parseFuturesCsv(csv, date) {
  const want = date.replace(/-/g, '/');
  let target = null;
  let prev = null;
  for (const line of String(csv).split(/\r?\n/)) {
    const row = parseFuturesRow(line);
    if (!row) continue;
    if (row.rowDate === want) {
      target = row;
    } else if (/^\d{4}\/\d{2}\/\d{2}$/.test(row.rowDate) && row.rowDate < want) {
      if (!prev || row.rowDate > prev.rowDate) prev = row;
    }
  }
  if (!target) return null;
  return {
    foreignNet: target.foreignNet,
    long: target.long,
    short: target.short,
    ...(prev ? { prevForeignNet: prev.foreignNet } : {}),
  };
}

/** 證交所休市日（openapi holidaySchedule）。民國日期 1150101 → 2026-01-01 */
export function parseHolidays(list) {
  const closed = [];
  for (const h of Array.isArray(list) ? list : []) {
    const name = String(h.Name ?? '');
    // 「開始交易日」「最後交易日」是有交易的日子，不是休市
    if (/開始交易|最後交易/.test(name)) continue;
    const m = /^(\d{2,3})(\d{2})(\d{2})$/.exec(String(h.Date ?? '').trim());
    if (!m) continue;
    closed.push(`${Number(m[1]) + 1911}-${m[2]}-${m[3]}`);
  }
  return closed;
}

