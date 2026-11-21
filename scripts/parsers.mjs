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

/** 證交所休市日（openapi holidaySchedule）。民國日期 1150101 → 2026-01-01，可跨 2027/2028+ 自動沿用 */
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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function shiftIsoDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function isoDateDiffDays(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

function isValidIsoDate(year, month, day) {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day;
}

function resolveMonthDay(month, day, refDateStr) {
  const refYear = Number(refDateStr.slice(0, 4));
  const refMonth = Number(refDateStr.slice(5, 7));
  let year = refYear;
  if (refMonth === 12 && month === 1) year = refYear + 1;
  else if (refMonth === 1 && month === 12) year = refYear - 1;
  if (!isValidIsoDate(year, month, day)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * 合併休市日清單並自動修剪過舊年份（保留前一年、當年度及所有未來已公告年度如 2027/2028+）。
 */
export function mergeClosedDates(existing = [], incoming = [], today = '') {
  const minYear = /^\d{4}-/.test(today) ? Number(today.slice(0, 4)) - 1 : 0;
  const minDate = minYear ? `${minYear}-01-01` : '';
  return [...new Set([...(existing ?? []), ...(incoming ?? [])])]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && (!minDate || d >= minDate))
    .sort();
}

/**
 * 解析證交所 OpenAPI 新聞公告（openapi.twse.com.tw/v1/news/newsList）中的天然災害臨時休市公告。
 * 僅匹配明確宣告集中交易市場全日休市／休市一天之近期新聞，並嚴格排除「不休市／照常／下午停班」等文字。
 */
export function parseTwseDisasterClosures(newsList, today) {
  if (!Array.isArray(newsList) || !/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return [];
  const found = new Set();

  for (const item of newsList) {
    const title = String(item?.Title ?? '').replace(/\s+/g, '');
    const mPub = /^(\d{2,3})(\d{2})(\d{2})$/.exec(String(item?.Date ?? '').trim());
    if (!title || !mPub) continue;

    const pubDate = `${Number(mPub[1]) + 1911}-${mPub[2]}-${mPub[3]}`;
    const pubAge = isoDateDiffDays(today, pubDate);
    if (pubAge > 3 || pubAge < -1) continue; // 只檢視近 3 天內的新聞公告

    const mentionsMarket = /集中交易市場|臺灣證券交易所|台灣證券交易所|證交所|台股|臺股/.test(title);
    const mentionsClosure = /全日休市|休市[一1兩2二三3]?[天日]|全日停止交易|(?:颱風|天災|天然災害).*休市/.test(title);
    const negated = /不休市|照常|正常交易|恢復交易|半日|僅盤後|盤後.*停止|下午.*停止/.test(title);
    if (!mentionsMarket || !mentionsClosure || negated) continue;

    const extracted = [];
    // 1) 帶民國／西元年的日期（如 115年7月24日、2026年7月24日）
    for (const m of title.matchAll(/(\d{3,4})年(\d{1,2})月(\d{1,2})[日號]?(?:[至到及、與](\d{1,2})[日號]?)?/g)) {
      const rawY = Number(m[1]);
      const y = rawY < 1911 ? rawY + 1911 : rawY;
      const mo = Number(m[2]);
      const d1 = Number(m[3]);
      if (isValidIsoDate(y, mo, d1)) extracted.push(`${y}-${pad2(mo)}-${pad2(d1)}`);
      if (m[4]) {
        const d2 = Number(m[4]);
        if (isValidIsoDate(y, mo, d2)) {
          if (/[至到]/.test(m[0])) {
            for (let d = d1 + 1; d <= d2 && d - d1 <= 5; d += 1) {
              if (isValidIsoDate(y, mo, d)) extracted.push(`${y}-${pad2(mo)}-${pad2(d)}`);
            }
          } else {
            extracted.push(`${y}-${pad2(mo)}-${pad2(d2)}`);
          }
        }
      }
    }
    // 2) 不帶年份的月日（如 7月24日、7月24、25日、7月24日至25日）
    if (!extracted.length) {
      for (const m of title.matchAll(/(\d{1,2})月(\d{1,2})[日號]?(?:([至到及、與])(\d{1,2})[日號]?)?/g)) {
        const mo = Number(m[1]);
        const d1 = Number(m[2]);
        const iso1 = resolveMonthDay(mo, d1, pubDate);
        if (iso1) extracted.push(iso1);
        if (m[4]) {
          const sep = m[3];
          const d2 = Number(m[4]);
          if (sep === '至' || sep === '到') {
            for (let d = d1 + 1; d <= d2 && d - d1 <= 5; d += 1) {
              const iso = resolveMonthDay(mo, d, pubDate);
              if (iso) extracted.push(iso);
            }
          } else {
            const iso2 = resolveMonthDay(mo, d2, pubDate);
            if (iso2) extracted.push(iso2);
          }
        }
      }
    }

    for (const iso of extracted) {
      const delta = isoDateDiffDays(iso, pubDate);
      if (delta >= -1 && delta <= 7) found.add(iso);
    }
  }
  return [...found].sort();
}

/**
 * 解析行政院人事行政總處天然災害停止上班及上課網頁（dgpa.gov.tw/typh/daily/nds.html）。
 * 依證交所規定：僅「臺北市」全日或上午全體停止上班時集中交易市場全日休市；
 * 下午停班、僅停課照常上班、部分區域／學校停班或其他縣市停班皆不休市。
 */
export function parseDgpaTaipeiClosures(html, today) {
  const src = String(html || '');
  if (!src || !/^\d{4}-\d{2}-\d{2}$/.test(String(today || '')) || src.includes('無停班停課訊息')) {
    return [];
  }

  let baseDate = today;
  const mHdr = /(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*天然災害停止上班/.exec(src);
  if (mHdr) {
    const y = Number(mHdr[1]) + 1911;
    const mo = Number(mHdr[2]);
    const da = Number(mHdr[3]);
    if (isValidIsoDate(y, mo, da)) {
      const hdrIso = `${y}-${pad2(mo)}-${pad2(da)}`;
      if (Math.abs(isoDateDiffDays(hdrIso, today)) <= 2) baseDate = hdrIso;
    }
  }

  const found = new Set();
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const rowMatch of src.matchAll(rowRegex)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
    if (cells.length < 2) continue;
    const cityText = cells[0].replace(/<[^>]+>/g, '').replace(/\s+/g, '');
    if (!/^[臺台]北市$/.test(cityText)) continue;

    const statusLines = cells[1]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|font|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .split(/[\n。；;]+/)
      .map((s) => s.replace(/\s+/g, '').trim())
      .filter(Boolean);

    for (const line of statusLines) {
      if (!line.includes('停止上班')) continue;
      const partialOrSchool = /尚未|其餘|部分|僅|國小|國中|高中|高職|大學|幼兒園|(?!全區)[一-龥]{1,3}區|[一-龥]{1,3}里/;
      const afternoonOrNormal = /照常上班|正常上班|下午|中午|晚間|晚上|12:00|13:00|14:00|18:00/;
      if (partialOrSchool.test(line)) continue;
      const morningFullStop = /上午(?:各機關學校|全體|全面)?停止上班/.test(line);
      if (!morningFullStop && afternoonOrNormal.test(line)) continue;

      const dates = [];
      for (const m of line.matchAll(/(?:(\d{3,4})年)?(\d{1,2})月(\d{1,2})[日號]?/g)) {
        const mo = Number(m[2]);
        const da = Number(m[3]);
        if (m[1]) {
          const rawY = Number(m[1]);
          const y = rawY < 1911 ? rawY + 1911 : rawY;
          if (isValidIsoDate(y, mo, da)) dates.push(`${y}-${pad2(mo)}-${pad2(da)}`);
        } else {
          const iso = resolveMonthDay(mo, da, baseDate);
          if (iso) dates.push(iso);
        }
      }
      if (!dates.length) {
        if (/明天|明日/.test(line)) dates.push(shiftIsoDate(baseDate, 1));
        else dates.push(baseDate);
      }

      for (const iso of dates) {
        const delta = isoDateDiffDays(iso, today);
        if (delta >= 0 && delta <= 3) found.add(iso);
      }
    }
  }
  return [...found].sort();
}

