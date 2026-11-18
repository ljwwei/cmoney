import test from 'node:test';
import assert from 'node:assert/strict';
import { dueTasks, remainingTasks, isTradingDay, taipeiParts, institutionalStage } from '../scripts/schedule.mjs';
import {
  parseHolidays,
  parseMargin,
  parseFuturesCsv,
  parseIndex,
  parseInstitutional,
  parseOpenApiIndexHist,
  parseTwseIndexHist,
  parseBlockTradeScope,
} from '../scripts/parsers.mjs';
import {
  isPending,
  marginYi,
  marginDiffYi,
  toYiSigned,
  resolveApiOrigin,
  resolveLiveApiUrl,
  inIntradayWindow,
  getQuoteTimestampMs,
  acceptLiveQuote,
  selectIndexDisplay,
  renderIndex,
  indexBadge,
  createLiveStreamController,
  initVisitCounter,
  formatWeatherTime,
  aqiStatus,
  aqiLevel,
  initLiveWeather,
  FALLBACK_POLL_MS,
} from '../js/app.js';
import {
  DEFAULT_SYMBOL,
  YAHOO_TIMEOUT_MS,
  WS_FAILOVER_RETRIES,
  WS_INTRADAY_SILENCE_MS,
  WS_RECOVERY_INTERVAL_MS,
  WS_COOLDOWN_1013_MS,
  IDLE_RELEASE_MS,
  CWA_NORTH_STATION_ID,
  normalizeEpochMs,
  withYahooCacheBuster,
  shouldAcceptQuote,
  parseFugleSnapshot,
  parseFugleWsTick,
  parseYahooBackup,
  parseCwaTemperature,
  parseMoenvAqi,
  handleWeatherRequest,
  FugleHubEngine,
  handleWorkerRequest,
} from '../worker/core.mjs';

// 以台北時間建立 Date
const tpe = (s) => new Date(`${s}+08:00`);

// ========================================================
// 1. 排程與盤後解析（已移除證交所 MIS／鉅亨網）
// ========================================================

test('台北時間換算（跨日）', () => {
  assert.deepEqual(taipeiParts(new Date('2026-11-10T16:30:00Z')), { date: '2026-11-11', minutes: 30, dow: 3 });
});

test('週末與休市日不是交易日', () => {
  assert.equal(isTradingDay('2026-11-14', []), false); // 週六
  assert.equal(isTradingDay('2026-11-10', []), true);
  assert.equal(isTradingDay('2026-11-10', ['2026-11-10']), false);
});

test('非交易日永遠不抓', () => {
  assert.deepEqual(dueTasks({ closedDates: [] }, tpe('2026-11-14T21:00:00')), []);
  assert.deepEqual(dueTasks({ closedDates: ['2026-11-10'] }, tpe('2026-11-10T21:00:00')), []);
});

test('各項目開始時間', () => {
  const s = { closedDates: [] };
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T13:29:00')), []);
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T13:30:00')), ['index']);
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T14:30:00')), ['index', 'futures', 'institutional']);
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T20:29:00')), ['index', 'futures', 'institutional']);
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T20:30:00')), ['index', 'futures', 'institutional', 'margin']);
});

test('已抓到當日資料就不再抓；三大法人在 20:00 後再抓一次含鉅額', () => {
  const day = '2026-11-10';
  const s = {
    closedDates: [],
    index: { date: day },
    futures: { date: day },
    institutional: { date: day, stage: 'ex_block' },
    margin: { date: day },
  };
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T19:59:00')), []);
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T20:00:00')), ['institutional']);
  s.institutional.stage = 'with_block';
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T20:40:00')), []);
});

test('加權指數若僅有收盤價且 ohlcPending=true，持續重試至 18:00 為止', () => {
  const day = '2026-11-10';
  const s = { closedDates: [], index: { date: day, source: 'twse', ohlcPending: true } };
  const hasIndex = (time) => dueTasks(s, tpe(`2026-11-10T${time}`)).includes('index');
  assert.equal(hasIndex('13:40:00'), true);
  assert.equal(hasIndex('17:59:00'), true);
  assert.equal(hasIndex('18:00:00'), false);
  s.index.ohlcPending = false;
  assert.equal(hasIndex('13:40:00'), false);
});

test('remainingTasks：今天還沒抓齊的項目（不論開始時間），供常駐輪詢決定是否繼續', () => {
  const day = '2026-11-10';
  const s = { closedDates: [] };
  assert.deepEqual(remainingTasks(s, tpe('2026-11-10T13:00:00')), ['index', 'futures', 'institutional', 'margin']);
  Object.assign(s, {
    index: { date: day, source: 'twse' },
    futures: { date: day },
    institutional: { date: day, stage: 'ex_block' },
  });
  assert.deepEqual(remainingTasks(s, tpe('2026-11-10T16:00:00')), ['institutional', 'margin']);
  s.institutional.stage = 'with_block';
  s.margin = { date: day };
  assert.deepEqual(remainingTasks(s, tpe('2026-11-10T21:00:00')), []);
  assert.deepEqual(remainingTasks({ closedDates: [] }, tpe('2026-11-10T04:16:00')), []);
  assert.deepEqual(remainingTasks({ closedDates: [] }, tpe('2026-11-10T12:59:00')), []);
  assert.deepEqual(remainingTasks({ closedDates: [] }, tpe('2026-11-14T15:00:00')), []);
  assert.deepEqual(remainingTasks({ closedDates: [] }, tpe('2026-11-10T23:55:00')), []);
});

test('前一日的資料不算當日資料', () => {
  const s = { closedDates: [], index: { date: '2026-11-09' } };
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T13:45:00')), ['index']);
});

test('三大法人階段', () => {
  assert.equal(institutionalStage(tpe('2026-11-10T19:59:00')), 'ex_block');
  assert.equal(institutionalStage(tpe('2026-11-10T20:00:00')), 'with_block');
});

test('休市日解析：開始/最後交易日不算休市，民國年轉西元', () => {
  const r = parseHolidays([
    { Name: '國曆新年開始交易日', Date: '1150102' },
    { Name: '中華民國開國紀念日', Date: '1150101' },
    { Name: '農曆春節前最後交易日', Date: '1150211' },
    { Name: '市場無交易，僅辦理結算交割作業', Date: '1150212' },
  ]);
  assert.deepEqual(r, ['2026-01-01', '2026-02-12']);
});

test('融資金額解析', () => {
  const v = parseMargin({
    stat: 'OK',
    tables: [{ data: [['融資金額(仟元)', '1', '2', '3', '539,915,741', '536,678,732']] }],
  });
  assert.deepEqual(v, { balance: 536678732, prevBalance: 539915741 });
});

test('外資期貨淨額解析', () => {
  const csv = [
    '日期,商品名稱,身份別,a,b,c,d,e,f,g,h,i,j,k,l',
    '2026/11/10,臺股期貨,外資及陸資,86285,1,88046,1,-1761,1,9875,1,113348,1,-103473,1',
  ].join('\r\n');
  assert.equal(parseFuturesCsv(csv, '2026-11-10').foreignNet, -103473);
  assert.equal(parseFuturesCsv(csv, '2026-11-11'), null);
});

test('加權指數漲跌正負號', () => {
  const mk = (color, s) => ({
    stat: 'OK',
    tables: [{ data: [['發行量加權股價指數', '42,711.92', `<p style ='color:${color}'>${s}</p>`, '1,050.22', '2.52']] }],
  });
  assert.deepEqual(parseIndex(mk('red', '+')), { close: 42711.92, change: 1050.22, changePct: 2.52 });
  assert.deepEqual(parseIndex(mk('green', '-')), { close: 42711.92, change: -1050.22, changePct: -2.52 });
});

test('尚未揭露：交易日且資料日期早於今天才顯示', () => {
  const closed = ['2026-11-12'];
  assert.equal(isPending('2026-11-10', '2026-11-11', closed), true);
  assert.equal(isPending('2026-11-11', '2026-11-11', closed), false);
  assert.equal(isPending('2026-11-11', '2026-11-12', closed), false);
  assert.equal(isPending('2026-11-13', '2026-11-14', closed), false);
});

test('融資與買賣超格式', () => {
  assert.equal(marginYi(536678732), 5367);
  assert.equal(marginDiffYi(536678732, 539915741), -32.4);
  assert.equal(toYiSigned(-34116689906), '−341.17');
});

test('依證交所說明文字判斷是否含鉅額', () => {
  assert.equal(parseBlockTradeScope(['x', '本統計資訊含一般、零股、盤後定價、鉅額，不含拍賣、標購。']), true);
  assert.equal(parseBlockTradeScope(['本統計資訊含一般、零股、盤後定價，不含鉅額、拍賣、標購。']), false);
  assert.equal(parseBlockTradeScope(['其他說明']), null);
  assert.equal(parseBlockTradeScope(undefined), null);
});

test('OpenAPI 加權指數歷史資料：民國日期、漲跌以前一筆計算', () => {
  const list = [
    { Date: '1151110', ClosingIndex: '42711.92' },
    { Date: '1151111', ClosingIndex: '44257.15' },
  ];
  assert.deepEqual(parseOpenApiIndexHist(list, '2026-11-11'), { close: 44257.15, change: 1545.23, changePct: 3.62 });
  assert.deepEqual(parseOpenApiIndexHist(list, '2026-11-10'), { close: 42711.92, change: null, changePct: null });
  assert.equal(parseOpenApiIndexHist(list, '2026-11-12'), null);
});

test('防呆：外資期貨整列全 0（期交所尚未提供正式資料）視為無資料', () => {
  const head = '日期,商品名稱,身份別,a,b,c,d,e,f,g,h,i,j,k,l';
  const zero = '2026/11/12,臺股期貨,外資及陸資,0,0,0,0,0,0,0,0,0,0,0,0';
  assert.equal(parseFuturesCsv([head, zero].join('\r\n'), '2026-11-12'), null);
  const openZero = '2026/11/12,臺股期貨,外資及陸資,100,1,90,1,10,1,0,0,0,0,0,0';
  assert.equal(parseFuturesCsv([head, openZero].join('\r\n'), '2026-11-12'), null);
  const ok = '2026/11/12,臺股期貨,外資及陸資,86285,1,88046,1,-1761,1,9875,1,113348,1,-103473,1';
  assert.equal(parseFuturesCsv([head, ok].join('\r\n'), '2026-11-12').foreignNet, -103473);
});

test('防呆：三大法人／融資全 0 視為無資料', () => {
  const z = ['0', '0', '0'];
  const inst = {
    stat: 'OK',
    data: [['自營商(自行買賣)', ...z], ['自營商(避險)', ...z], ['投信', ...z], ['外資及陸資(不含外資自營商)', ...z], ['合計', ...z]],
  };
  assert.equal(parseInstitutional(inst), null);
  assert.equal(parseMargin({ stat: 'OK', tables: [{ data: [['融資金額(仟元)', '0', '0', '0', '0', '0']] }] }), null);
});

test('盤後解析擴充 OHLC：parseTwseIndexHist / parseOpenApiIndexHist', () => {
  const histRwd = {
    stat: 'OK',
    data: [
      ['115/11/12', '44,180.46', '44,525.24', '42,943.50', '43,091.87'],
      ['115/11/13', '43,719.75', '44,489.48', '43,534.12', '43,675.12'],
    ],
  };
  assert.deepEqual(parseTwseIndexHist(histRwd, '2026-11-13'), {
    close: 43675.12,
    change: 583.25,
    changePct: 1.35,
    open: 43719.75,
    high: 44489.48,
    low: 43534.12,
  });

  const oa = [
    { Date: '1151112', OpeningIndex: '44180.46', HighestIndex: '44525.24', LowestIndex: '42943.50', ClosingIndex: '43091.87' },
    { Date: '1151113', OpeningIndex: '43719.75', HighestIndex: '44489.48', LowestIndex: '43534.12', ClosingIndex: '43675.12' },
  ];
  assert.deepEqual(parseOpenApiIndexHist(oa, '2026-11-13'), {
    close: 43675.12,
    change: 583.25,
    changePct: 1.35,
    open: 43719.75,
    high: 44489.48,
    low: 43534.12,
  });
});

// ========================================================
// 2. 前端：UI 狀態（僅富果 / Yahoo 備援）、單調時間戳、SSE 單例、計次
// ========================================================

test('前端即時設定、盤中視窗、UI 標籤（僅保留富果盤中即時與 Yahoo 盤中即時備援）與單調時間戳', () => {
  assert.equal(resolveApiOrigin({ metaContent: 'https://cmoney-taiex.example.workers.dev/api/taiex' }), 'https://cmoney-taiex.example.workers.dev');
  assert.equal(resolveLiveApiUrl({ metaContent: 'https://cmoney-taiex.example.workers.dev/' }), 'https://cmoney-taiex.example.workers.dev/api/taiex');
  assert.equal(resolveLiveApiUrl({ search: '?liveApi=https://demo.workers.dev/api/stream', metaContent: 'https://other.workers.dev' }), 'https://demo.workers.dev/api/taiex');
  assert.equal(resolveLiveApiUrl({ search: '?liveApi=javascript:alert(1)' }), '');
  assert.equal(resolveLiveApiUrl({ search: '?liveApi=http://evil.example' }), '');
  assert.equal(resolveLiveApiUrl({ globalApi: 'http://localhost:8787' }), 'http://localhost:8787/api/taiex');

  assert.equal(inIntradayWindow('2026-11-13', '08:54:59', []), false);
  assert.equal(inIntradayWindow('2026-11-13', '08:55:00', []), true);
  assert.equal(inIntradayWindow('2026-11-13', '13:35:00', []), true);
  assert.equal(inIntradayWindow('2026-11-13', '13:35:01', []), false);
  assert.equal(inIntradayWindow('2026-11-13', '10:00:00', ['2026-11-13']), false);
  assert.equal(inIntradayWindow('2026-11-15', '10:00:00', []), false);

  const ts1 = tpe('2026-11-13T10:15:30').getTime();
  const prev = { date: '2026-11-12', close: 43091.87, change: -100, source: 'twse' };
  const fugleLive = {
    date: '2026-11-13',
    time: '10:15:30',
    timestampMs: ts1,
    close: 43800.5,
    open: 43719.75,
    high: 44489.48,
    low: 43000.0,
    prevClose: 43091.87,
    change: 708.63,
    changePct: 1.64,
    source: 'fugle',
  };
  const yahooLive = { ...fugleLive, source: 'yahoo' };
  const settled = {
    date: '2026-11-13',
    close: 43675.12,
    open: 43719.75,
    high: 44489.48,
    low: 43534.12,
    change: 583.25,
    changePct: 1.35,
    source: 'twse',
  };

  assert.equal(selectIndexDisplay(prev, fugleLive, '2026-11-13'), fugleLive);
  assert.equal(selectIndexDisplay(settled, fugleLive, '2026-11-13'), settled);
  assert.equal(selectIndexDisplay(prev, { ...fugleLive, date: '2026-11-12' }, '2026-11-13'), prev);

  const liveHtml = renderIndex(fugleLive);
  assert.ok(liveHtml.includes('開盤') && liveHtml.includes('43,719.75'));
  assert.ok(liveHtml.includes('最高') && liveHtml.includes('44,489.48'));
  assert.ok(liveHtml.includes('最低') && liveHtml.includes('43,000.00'));
  assert.ok(liveHtml.includes('ohlc__val down') && liveHtml.includes('ohlc__val up'));
  assert.equal(/證交所盤中|鉅亨|即時終盤/.test(liveHtml), false);

  // 嚴格僅保留兩種即時狀態標籤
  assert.ok(indexBadge(fugleLive, '2026-11-13').includes('富果盤中即時'));
  assert.ok(indexBadge(yahooLive, '2026-11-13').includes('Yahoo 盤中即時 (備援)'));
  assert.equal(indexBadge(settled, '2026-11-13'), '');
  assert.equal(indexBadge(prev, '2026-11-13'), '');

  // 單調時間戳過濾：新報價時間戳必須嚴格 > latestQuoteTimestamp
  assert.equal(getQuoteTimestampMs(fugleLive), ts1);
  assert.equal(acceptLiveQuote(null, fugleLive, 0).close, 43800.5);
  assert.equal(acceptLiveQuote(fugleLive, { ...fugleLive, timestampMs: ts1, close: 43700 }, ts1), fugleLive);
  assert.equal(acceptLiveQuote(fugleLive, { ...fugleLive, timestampMs: ts1 - 1000, close: 43700 }, ts1), fugleLive);
  const newer = acceptLiveQuote(fugleLive, { ...fugleLive, timestampMs: ts1 + 1000, close: 43888 }, ts1);
  assert.equal(newer.close, 43888);
  assert.equal(newer.timestampMs, ts1 + 1000);
});

test('前端即時控制器：單例 EventSource、卸載 close()、SSE 故障改用遞迴 setTimeout(2.5s)+AbortController(2s)', async () => {
  assert.equal(FALLBACK_POLL_MS, 2500);

  const sockets = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.closed = false;
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    emit(type, payload = {}) {
      for (const fn of this.listeners.get(type) || []) fn(payload);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
  }

  let nextId = 1;
  const timers = new Map();
  const setTimer = (fn, delay) => {
    const id = nextId++;
    timers.set(id, { fn, delay });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);

  let hidden = false;
  const received = [];
  const fetchLog = [];
  const ctl = createLiveStreamController({
    apiOrigin: 'https://cmoney-taiex.example.workers.dev',
    isHidden: () => hidden,
    EventSourceCtor: FakeEventSource,
    fetchImpl: async (url, init) => {
      fetchLog.push({ url, init });
      return new Response(JSON.stringify({ ok: true, close: 43900, timestampMs: 1794792000000 }), { status: 200 });
    },
    nowFn: () => 1794792000123,
    setTimer,
    clearTimer,
    onQuote: (q) => received.push(q),
    onError: () => {},
  });

  // 重複呼叫 start() 仍嚴格維持單例 EventSource
  ctl.start();
  ctl.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'https://cmoney-taiex.example.workers.dev/api/stream');
  assert.equal(ctl.isConnected(), true);

  // 啟動當下也會送出 1 次防空白快照請求，且帶 _t= 時間戳、no-store 與 AbortSignal
  assert.equal(fetchLog.length, 1);
  assert.ok(fetchLog[0].url.endsWith('/api/taiex?_t=1794792000123'));
  assert.equal(fetchLog[0].init.cache, 'no-store');
  assert.ok(fetchLog[0].init.signal instanceof AbortSignal);

  sockets[0].emit('quote', { data: JSON.stringify({ close: 43910, timestampMs: 1794792005000 }) });
  assert.equal(received.at(-1).close, 43910);

  // 分頁隱藏 -> 確實 close() 釋放連線；切回 -> 重新建立唯一一條
  hidden = true;
  ctl.onVisibilityChange();
  assert.equal(sockets[0].closed, true);
  assert.equal(ctl.isConnected(), false);

  hidden = false;
  ctl.onVisibilityChange();
  assert.equal(sockets.length, 2);
  assert.equal(ctl.isConnected(), true);

  // SSE 連線中斷 -> 關閉舊 socket 並啟動遞迴 setTimeout(2500ms) + 15000ms SSE 重建排程
  sockets[1].readyState = 2;
  sockets[1].emit('error', new Error('sse dropped'));
  assert.equal(sockets[1].closed, true);
  assert.equal(ctl.isConnected(), false);
  const delays = [...timers.values()].map((t) => t.delay);
  assert.ok(delays.includes(0));
  assert.ok(delays.includes(15000));

  ctl.stop();
  assert.equal(timers.size, 0);
});

test('網站瀏覽人次計數（initVisitCounter）：呼叫 POST /api/stats/visits 並更新 #siteVisitCount', async () => {
  const el = { textContent: '0' };
  let called = null;
  const count = await initVisitCounter({
    apiOrigin: 'https://cmoney-taiex.example.workers.dev',
    documentRef: { getElementById: (id) => (id === 'siteVisitCount' ? el : null) },
    fetchImpl: async (url, init) => {
      called = { url, init };
      return new Response(JSON.stringify({ ok: true, visits: 12345 }), { status: 200 });
    },
  });
  assert.equal(count, 12345);
  assert.equal(el.textContent, '12,345');
  assert.equal(called.url, 'https://cmoney-taiex.example.workers.dev/api/stats/visits');
  assert.equal(called.init.method, 'POST');
  assert.equal(called.init.cache, 'no-store');
});

// ========================================================
// 3. 後端 Worker（富果 WS 單例 + Yahoo 條件備援 + D1/SQLite 計次）
// ========================================================

test('富果 REST 快照／WS 推播解析（微秒時間戳換算、OHLC 合併）與 Yahoo 備援解析', () => {
  // 2026-11-16 09:20:55.000 Taipei = 2026-11-16T01:20:55Z -> 1794792055000 ms -> 1794792055000000 us
  const us = 1794792055000000;
  assert.equal(normalizeEpochMs(us), 1794792055000);
  assert.equal(normalizeEpochMs(1794792055000), 1794792055000);
  assert.equal(normalizeEpochMs(1794792055), 1794792055000);

  const snap = parseFugleSnapshot({
    symbol: DEFAULT_SYMBOL,
    date: '2026-11-16',
    previousClose: 43675.12,
    openPrice: 43512.42,
    highPrice: 43550.0,
    lowPrice: 42595.92,
    lastPrice: 42693.3,
    lastUpdated: us,
  });
  assert.equal(snap.symbol, 'IX0001');
  assert.equal(snap.date, '2026-11-16');
  assert.equal(snap.time, '09:20:55');
  assert.equal(snap.timestampMs, 1794792055000);
  assert.equal(snap.change, -981.82);
  assert.equal(snap.source, 'fugle');

  // WS 推播跳升創新高（09:21:00）應沿用 open/prevClose 並更新 high
  const tick = parseFugleWsTick(
    { event: 'data', data: { symbol: 'IX0001', index: 43800.12, time: us + 5000000 } },
    snap,
    snap,
  );
  assert.equal(tick.time, '09:21:00');
  assert.equal(tick.open, 43512.42);
  assert.equal(tick.high, 43800.12);
  assert.equal(tick.low, 42595.92);
  assert.equal(tick.prevClose, 43675.12);
  assert.equal(tick.source, 'fugle');

  // Yahoo 備援解析
  const ytw = parseYahooBackup([
    {
      chart: {
        meta: { regularMarketTime: 1794792060, regularMarketPrice: 42693.3, previousClose: 43675.12 },
        quote: {
          price: '42693.30',
          previousClose: '43675.12',
          openPrice: '43512.42',
          dayHighPrice: '43512.42',
          dayLowPrice: '42595.92',
          marketStatus: 'open',
          refreshedTs: '2026-11-16T01:20:55Z',
        },
      },
    },
  ]);
  assert.equal(ytw.source, 'yahoo');
  assert.equal(ytw.time, '09:20:55');

  const yv8 = parseYahooBackup({
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: 43675.12,
            previousClose: 43091.9,
            regularMarketTime: 1794547995,
            regularMarketDayHigh: 44489.48,
            regularMarketDayLow: 43534.12,
          },
          indicators: { quote: [{ open: [null, 43719.75] }] },
        },
      ],
    },
  });
  assert.equal(yv8.source, 'yahoo');
  assert.equal(yv8.open, 43719.75);

  assert.equal(shouldAcceptQuote(1794792055000, { close: 43800, timestampMs: 1794792055000 }), false);
  assert.equal(shouldAcceptQuote(1794792055000, { close: 43800, timestampMs: 1794792056000 }), true);
  assert.equal(withYahooCacheBuster('https://tw.stock.yahoo.com/a;type=tick', 999), 'https://tw.stock.yahoo.com/a;type=tick?_c=1&_=999');
});

function createVirtualTimers(initialNowMs) {
  let now = initialNowMs;
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();

  const setTimeoutFn = (fn, delay) => {
    const id = nextId++;
    timeouts.set(id, { fn, runAt: now + Math.max(0, Number(delay) || 0) });
    return id;
  };
  const clearTimeoutFn = (id) => timeouts.delete(id);

  const setIntervalFn = (fn, delay) => {
    const id = nextId++;
    const step = Math.max(1, Number(delay) || 1);
    intervals.set(id, { fn, step, runAt: now + step });
    return id;
  };
  const clearIntervalFn = (id) => intervals.delete(id);

  const advance = async (ms) => {
    const target = now + ms;
    while (true) {
      let earliest = null;
      for (const [id, t] of timeouts) {
        if (t.runAt <= target && (!earliest || t.runAt < earliest.runAt)) earliest = { kind: 't', id, ...t };
      }
      for (const [id, iv] of intervals) {
        if (iv.runAt <= target && (!earliest || iv.runAt < earliest.runAt)) earliest = { kind: 'i', id, ...iv };
      }
      if (!earliest) break;
      now = earliest.runAt;
      if (earliest.kind === 't') {
        timeouts.delete(earliest.id);
        await earliest.fn();
      } else {
        const cur = intervals.get(earliest.id);
        if (cur) {
          cur.runAt = now + cur.step;
          await cur.fn();
        }
      }
    }
    now = target;
  };

  return {
    nowFn: () => now,
    setTimeoutFn,
    clearTimeoutFn,
    setIntervalFn,
    clearIntervalFn,
    advance,
  };
}

class MockWsSocket {
  constructor() {
    this.sent = [];
    this.listeners = new Map();
    this.closedWith = null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code, reason) {
    this.closedWith = { code, reason };
  }
  emitMessage(obj) {
    for (const fn of this.listeners.get('message') || []) fn({ data: JSON.stringify(obj) });
  }
  emitClose(code) {
    for (const fn of this.listeners.get('close') || []) fn({ code });
  }
}

test('FugleHubEngine：單例 WebSocket（禁開第 2 條）、Yahoo 完全休眠、3 次斷線備援、15 秒回復與 1013 冷卻', async () => {
  assert.equal(YAHOO_TIMEOUT_MS, 2000);
  assert.equal(WS_FAILOVER_RETRIES, 3);
  assert.equal(WS_INTRADAY_SILENCE_MS, 12000);
  assert.equal(WS_RECOVERY_INTERVAL_MS, 15000);
  assert.equal(WS_COOLDOWN_1013_MS, 15000);

  const vt = createVirtualTimers(tpe('2026-11-16T10:00:00').getTime());
  const createdSockets = [];
  let yahooCalls = 0;
  let yahooPrice = 42750;
  let snapshotPrice = 42693.3;

  const hub = new FugleHubEngine({
    env: { FUGLE_API_KEY: 'secret-test-key' },
    nowFn: vt.nowFn,
    setTimeoutFn: vt.setTimeoutFn,
    clearTimeoutFn: vt.clearTimeoutFn,
    setIntervalFn: vt.setIntervalFn,
    clearIntervalFn: vt.clearIntervalFn,
    connectWsImpl: async () => {
      const s = new MockWsSocket();
      createdSockets.push(s);
      return s;
    },
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.includes('api.fugle.tw/marketdata/v1.0/stock/intraday/quote/IX0001')) {
        assert.equal(init.headers['X-API-KEY'], 'secret-test-key');
        return new Response(
          JSON.stringify({
            symbol: 'IX0001',
            date: '2026-11-16',
            previousClose: 43675.12,
            openPrice: 43512.42,
            highPrice: 43550,
            lowPrice: 42595.92,
            lastPrice: snapshotPrice,
            lastUpdated: vt.nowFn() * 1000,
          }),
          { status: 200 },
        );
      }
      if (u.includes('yahoo.com')) {
        yahooCalls += 1;
        assert.match(u, /[?&]_=\d+/);
        assert.ok(init.signal instanceof AbortSignal);
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    regularMarketPrice: yahooPrice,
                    previousClose: 43675.12,
                    regularMarketTime: Math.floor(vt.nowFn() / 1000),
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      throw new Error('Unexpected fetch: ' + u);
    },
  });

  // 1. 同時多次啟動仍嚴格只開 1 條 WS、完成 Snapshot + auth + subscribe，且 Yahoo 保持 0 請求（完全休眠）
  await Promise.all([hub.ensureStarted(), hub.ensureStarted()]);
  assert.equal(createdSockets.length, 1);
  assert.equal(hub.latestQuote.close, 42693.3);
  assert.equal(yahooCalls, 0);

  const ws1 = createdSockets[0];
  assert.deepEqual(ws1.sent[0], { event: 'auth', data: { apikey: 'secret-test-key' } });
  ws1.emitMessage({ event: 'authenticated' });
  assert.deepEqual(ws1.sent[1], { event: 'subscribe', data: { channel: 'indices', symbol: 'IX0001' } });
  ws1.emitMessage({ event: 'subscribed' });
  ws1.emitMessage({ event: 'data', data: { symbol: 'IX0001', index: 42710.5, time: (vt.nowFn() + 1000) * 1000 } });
  assert.equal(hub.latestQuote.close, 42710.5);
  assert.equal(yahooCalls, 0);

  // 單調時間戳保護：更舊的時間戳不覆蓋最新價
  ws1.emitMessage({ event: 'data', data: { symbol: 'IX0001', index: 42600, time: vt.nowFn() * 1000 } });
  assert.equal(hub.latestQuote.close, 42710.5);

  // 2. 斷線重連防抖：第 1、2 次失敗不切 Yahoo，第 3 次失敗才進入 Yahoo 備援
  ws1.emitClose(1006);
  assert.equal(hub.mode, 'fugle');
  assert.equal(yahooCalls, 0);
  await vt.advance(3000);
  assert.equal(createdSockets.length, 2);

  createdSockets[1].emitClose(1006);
  assert.equal(hub.mode, 'fugle');
  assert.equal(yahooCalls, 0);
  await vt.advance(3000);
  assert.equal(createdSockets.length, 3);

  createdSockets[2].emitClose(1006);
  assert.equal(hub.mode, 'yahoo');
  await vt.advance(10); // 讓即時 Yahoo 首次抓取完成
  assert.equal(yahooCalls, 1);
  assert.equal(hub.latestQuote.source, 'yahoo');
  assert.equal(hub.latestQuote.close, 42750);

  // 3. 進入 Yahoo 後，每 15 秒背景嘗試重建 Fugle WS，收到有效推播立刻停 Yahoo 回切 Fugle
  snapshotPrice = 42810;
  await vt.advance(15000);
  assert.equal(createdSockets.length, 4);
  const ws4 = createdSockets[3];
  ws4.emitMessage({ event: 'authenticated' });
  ws4.emitMessage({ event: 'subscribed' });
  ws4.emitMessage({ event: 'data', data: { symbol: 'IX0001', index: 42825, time: (vt.nowFn() + 2000) * 1000 } });
  assert.equal(hub.mode, 'fugle');
  assert.equal(hub.latestQuote.source, 'fugle');
  assert.equal(hub.latestQuote.close, 42825);
  const yahooAfterRecovery = yahooCalls;

  // 確認 Yahoo 輪詢確實已停止
  await vt.advance(5000);
  assert.equal(yahooCalls, yahooAfterRecovery);

  // 4. 盤中靜默超過 12 秒（先於 8 秒主動送 ping）：仍無回應時切入 Yahoo 備援
  await vt.advance(4000); // 距上次活動 ~9 秒 -> 應發送 ping
  assert.ok(ws4.sent.some((m) => m.event === 'ping'));
  await vt.advance(6000); // 超過 12 秒靜默
  assert.equal(hub.mode, 'yahoo');
  assert.equal(hub.backupReason, 'intraday_silence_12s');

  // 5. Close Code 1013 冷卻保護：遭遇 1013 後至少 15 秒內禁止再開 WS
  hub.exitYahooBackupToFugle();
  assert.equal(await hub.connectFugle(), true);
  const ws5 = createdSockets.at(-1);
  const countBefore1013 = createdSockets.length;
  ws5.emitClose(1013);
  assert.equal(hub.mode, 'yahoo');
  assert.equal(await hub.connectFugle(), false);
  assert.equal(createdSockets.length, countBefore1013);

  // 6. SSE 連線全部離開超過 30 秒 → 主動關閉資源
  const closedEvents = [];
  const sseClient = { write() {}, close: () => closedEvents.push('closed') };
  hub.addSseClient(sseClient);
  hub.removeSseClient(sseClient);
  await vt.advance(IDLE_RELEASE_MS + 100);
  assert.equal(hub.yahooPollTimer, null);
  assert.equal(hub.recoveryTimer, null);
  assert.equal(hub.healthTimer, null);
});

test('無 FUGLE_API_KEY 時直接啟用 Yahoo 備援；D1 與 DO SQLite 人數計次正常累加', async () => {
  // 1. 無 API Key 直接 Yahoo 備援
  let yahooCalls = 0;
  const noKeyHub = new FugleHubEngine({
    env: {},
    fetchImpl: async (url) => {
      yahooCalls += 1;
      assert.ok(String(url).includes('yahoo.com'));
      return new Response(
        JSON.stringify({
          chart: { result: [{ meta: { regularMarketPrice: 43100, previousClose: 43000, regularMarketTime: 1794792060 } }] },
        }),
        { status: 200 },
      );
    },
  });
  await noKeyHub.ensureStarted();
  assert.equal(noKeyHub.mode, 'yahoo');
  assert.equal(noKeyHub.backupReason, 'no_api_key');
  assert.equal(yahooCalls, 1);
  noKeyHub.shutdownIdle();

  // 2. DO SQLite 備援計次 + /api/stats/visits + /health
  const store = new Map();
  const mockSql = {
    exec(sql, ...args) {
      if (sql.startsWith('INSERT OR IGNORE')) {
        if (!store.has(args[0])) store.set(args[0], args[1]);
        return [];
      }
      if (sql.startsWith('UPDATE')) {
        const key = args[1];
        store.set(key, (store.get(key) || 0) + 1);
        return [];
      }
      if (sql.startsWith('SELECT value')) {
        return [{ value: store.get(args[0]) ?? 0 }];
      }
      return [];
    },
  };
  const doEngine = new FugleHubEngine({ env: { FUGLE_API_KEY: 'k' }, sql: mockSql });
  const envWithDo = {
    FUGLE_API_KEY: 'k',
    FUGLE_HUB: {
      idFromName: () => 'singleton-id',
      get: () => ({
        fetch: (req) => doEngine.handleFetch(req),
      }),
    },
  };

  const v1 = await handleWorkerRequest(
    new Request('https://w.example/api/stats/visits', { method: 'POST', headers: { Origin: 'https://ljwwei.github.io' } }),
    envWithDo,
  );
  assert.equal((await v1.json()).visits, 1);
  const v2 = await handleWorkerRequest(
    new Request('https://w.example/api/stats/visits', { method: 'POST', headers: { Origin: 'https://ljwwei.github.io' } }),
    envWithDo,
  );
  assert.equal((await v2.json()).visits, 2);

  // 3. D1 計次優先路徑
  let d1Count = 99;
  const mockD1 = {
    prepare(sql) {
      return {
        bind: (...args) => ({
          run: async () => {
            if (sql.startsWith('UPDATE')) {
              d1Count += 1;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
          first: async () => ({ value: d1Count }),
        }),
        run: async () => ({ meta: { changes: 0 } }),
      };
    },
  };
  const d1Res = await handleWorkerRequest(
    new Request('https://w.example/api/stats/visits', { method: 'POST', headers: { Origin: 'https://ljwwei.github.io' } }),
    { DB: mockD1 },
  );
  assert.equal(d1Res.status, 200);
  assert.equal(d1Res.headers.get('Access-Control-Allow-Origin'), 'https://ljwwei.github.io');
  assert.equal((await d1Res.json()).visits, 100);

  // 4. /health 回報主備來源與設定狀態（絕不外洩 API Key 本身）
  const hRes = await handleWorkerRequest(new Request('https://w.example/health'), envWithDo);
  const hJson = await hRes.json();
  assert.equal(hJson.primary, 'fugle');
  assert.equal(hJson.backup, 'yahoo');
  assert.equal(hJson.hasFugleKey, true);
  assert.equal(hJson.hasDurableHub, true);
  assert.equal(hJson.hasCwaKey, false);
  assert.equal(hJson.hasMoenvKey, false);
  assert.equal(JSON.stringify(hJson).includes('secret'), false);
});

// ========================================================
// 4. 臺南市北區氣溫（C0X100）與臺南測站 AQI（Worker 代理 + 前端顯示）
// ========================================================

test('氣象署 CWA（臺南市北區 C0X100）與環境部 MOENV（臺南測站 AQI）解析及備援快取', async () => {
  // 1. 同時支援 PascalCase 與 camelCase，並過濾 -99 / X 異常值
  const pascalTemp = parseCwaTemperature({
    records: {
      Station: [
        {
          StationId: '467410',
          StationName: '臺南',
          ObsTime: { DateTime: '2026-11-18T14:50:00+08:00' },
          WeatherElement: { AirTemperature: '26.1' },
        },
        {
          StationId: CWA_NORTH_STATION_ID,
          StationName: '臺南市北區',
          ObsTime: { DateTime: '2026-11-18T14:50:00+08:00' },
          WeatherElement: { AirTemperature: '26.8' },
        },
      ],
    },
  });
  assert.deepEqual(pascalTemp, {
    station: '臺南市北區',
    stationId: 'C0X100',
    temperature: 26.8,
    tempObsTime: '2026-11-18T14:50:00+08:00',
  });

  const camelTemp = parseCwaTemperature({
    records: {
      station: [
        {
          stationId: 'C0X100',
          stationName: '臺南市北區',
          obsTime: { dateTime: '2026-11-18T15:00:00+08:00' },
          weatherElement: { airTemperature: '27.3' },
        },
      ],
    },
  });
  assert.equal(camelTemp.temperature, 27.3);

  assert.equal(
    parseCwaTemperature({
      records: { Station: [{ StationId: 'C0X100', WeatherElement: { AirTemperature: '-99' } }] },
    }),
    null,
  );
  assert.equal(
    parseCwaTemperature({
      records: { Station: [{ StationId: 'C0X100', WeatherElement: { AirTemperature: 'X' } }] },
    }),
    null,
  );

  // 2. MOENV AQI 解析
  assert.deepEqual(
    parseMoenvAqi({
      records: [{ sitename: '臺南', aqi: '68', status: '', publishtime: '2026/11/18 14:00:00' }],
    }),
    { aqiSite: '臺南', aqi: 68, aqiStatus: '普通', aqiPublishTime: '2026/11/18 14:00:00' },
  );

  // 3. handleWeatherRequest：主站 C0X100 正常、單飛去重、5 分鐘邊緣快取 + 跨來源動態 CORS
  const cacheMap = new Map();
  const mockCache = {
    match: async (k) => {
      const v = cacheMap.get(String(k));
      return v ? v.clone() : undefined;
    },
    put: async (k, res) => {
      cacheMap.set(String(k), res.clone());
    },
  };
  const weatherState = { inFlight: null, lastGood: null };
  let upstreamCalls = 0;
  let primaryBroken = false;

  const mockFetch = async (url) => {
    upstreamCalls += 1;
    const u = String(url);
    if (u.includes('O-A0001-001')) {
      assert.ok(u.includes('Authorization=cwa-secret'));
      assert.ok(u.includes('StationId=C0X100'));
      if (primaryBroken) return new Response(JSON.stringify({ records: { Station: [] } }), { status: 200 });
      return new Response(
        JSON.stringify({
          records: {
            Station: [
              {
                StationId: 'C0X100',
                StationName: '臺南市北區',
                ObsTime: { DateTime: '2026-11-18T14:50:00+08:00' },
                WeatherElement: { AirTemperature: '26.4' },
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    if (u.includes('O-A0003-001')) {
      assert.ok(u.includes('StationId=467410'));
      return new Response(
        JSON.stringify({
          records: {
            Station: [
              {
                StationId: '467410',
                StationName: '臺南',
                ObsTime: { DateTime: '2026-11-18T14:50:00+08:00' },
                WeatherElement: { AirTemperature: '26.0' },
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    if (u.includes('aqx_p_432')) {
      assert.ok(u.includes('api_key=moenv-secret'));
      return new Response(
        JSON.stringify({
          records: [{ sitename: '臺南', aqi: '42', status: '良好', publishtime: '2026/11/18 14:00:00' }],
        }),
        { status: 200 },
      );
    }
    throw new Error('Unexpected url: ' + u);
  };

  const envWeather = { CWA_API_KEY: 'cwa-secret', MOENV_API_KEY: 'moenv-secret' };
  const [rA, rB] = await Promise.all([
    handleWeatherRequest(
      new Request('https://w.example/api/weather', { headers: { Origin: 'https://ljwwei.github.io' } }),
      envWeather,
      { fetchImpl: mockFetch, cacheStore: mockCache, state: weatherState },
    ),
    handleWeatherRequest(
      new Request('https://w.example/api/weather', { headers: { Origin: 'https://ljwwei.github.io' } }),
      envWeather,
      { fetchImpl: mockFetch, cacheStore: mockCache, state: weatherState },
    ),
  ]);
  assert.equal(upstreamCalls, 2, 'concurrent hits share one CWA + one MOENV fetch');
  const jA = await rA.json();
  const jB = await rB.json();
  assert.equal(jA.station, '臺南市北區');
  assert.equal(jA.temperature, 26.4);
  assert.equal(jA.aqi, 42);
  assert.equal(jA.aqiStatus, '良好');
  assert.equal(jB.aqi, 42);
  assert.equal(JSON.stringify(jA).includes('secret'), false);

  // 快取命中應支援不同允許網域的動態 CORS Header，且不再增加上游呼叫
  const rLocal = await handleWeatherRequest(
    new Request('https://w.example/api/weather', { headers: { Origin: 'http://localhost:8080' } }),
    envWeather,
    { fetchImpl: mockFetch, cacheStore: mockCache, state: weatherState },
  );
  assert.equal(rLocal.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');
  assert.equal(upstreamCalls, 2);

  // 清除快取並模擬 C0X100 缺值 -> 自動退回 467410 臺南氣象站備援
  cacheMap.clear();
  primaryBroken = true;
  const rFb = await handleWeatherRequest(
    new Request('https://w.example/api/weather', { headers: { Origin: 'https://ljwwei.github.io' } }),
    envWeather,
    { fetchImpl: mockFetch, cacheStore: mockCache, state: { inFlight: null, lastGood: null } },
  );
  const jFb = await rFb.json();
  assert.equal(jFb.stationId, '467410');
  assert.equal(jFb.temperature, 26);
});

test('前端頂部氣象/空品元件（formatWeatherTime、AQI 等級與 DOM 更新）', async () => {
  const nowMs = tpe('2026-11-18T15:05:00').getTime();
  assert.equal(formatWeatherTime('2026-11-18T14:50:00+08:00', true, nowMs), '14:50');
  assert.equal(formatWeatherTime('2026/11/18 14:00:00', false, nowMs), '14:00');
  assert.equal(formatWeatherTime('2026/11/17 23:00:00', false, nowMs), '11/17 23:00');

  assert.equal(aqiStatus(33), '良好');
  assert.equal(aqiStatus(78), '普通');
  assert.equal(aqiStatus(120), '對敏感族群不健康');
  assert.equal(aqiLevel(33), 0);
  assert.equal(aqiLevel(78), 1);
  assert.equal(aqiLevel(120), 2);
  assert.equal(aqiLevel(220), 4);

  const makeEl = () => ({
    textContent: '',
    attrs: new Map(),
    setAttribute(k, v) {
      this.attrs.set(k, v);
    },
  });
  const tempEl = makeEl();
  const timeEl = makeEl();
  const aqiEl = makeEl();
  let intervalRegistered = null;

  const ctl = initLiveWeather({
    apiOrigin: 'https://cmoney-taiex.example.workers.dev',
    nowFn: () => nowMs,
    setIntervalFn: (_fn, ms) => {
      intervalRegistered = ms;
      return 1;
    },
    documentRef: {
      querySelectorAll(sel) {
        if (sel === '[data-live-temp]') return [tempEl];
        if (sel === '[data-live-temp-time]') return [timeEl];
        if (sel === '[data-live-aqi]') return [aqiEl];
        return [];
      },
    },
    fetchImpl: async (url, init) => {
      assert.equal(url, `https://cmoney-taiex.example.workers.dev/api/weather?_t=${nowMs}`);
      assert.equal(init.cache, 'no-store');
      return new Response(
        JSON.stringify({
          ok: true,
          station: '臺南市北區',
          temperature: 26.8,
          tempObsTime: '2026-11-18T14:50:00+08:00',
          aqiSite: '臺南',
          aqi: 78,
          aqiStatus: '普通',
          aqiPublishTime: '2026/11/18 14:00:00',
        }),
        { status: 200 },
      );
    },
  });

  await ctl.initialPromise;
  assert.equal(tempEl.textContent, '26.8');
  assert.equal(timeEl.textContent, '(14:50)');
  assert.equal(aqiEl.textContent, '空氣品質：普通 AQI 78 (14:00)');
  assert.equal(aqiEl.attrs.get('data-aqi-level'), '1');
  assert.equal(intervalRegistered, 5 * 60 * 1000);
});
