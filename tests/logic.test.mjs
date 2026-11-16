import test from 'node:test';
import assert from 'node:assert/strict';
import { dueTasks, remainingTasks, isTradingDay, taipeiParts, institutionalStage } from '../scripts/schedule.mjs';
import {
  parseHolidays,
  parseMargin,
  parseFuturesCsv,
  parseIndex,
  parseInstitutional,
  parseMisIndex,
  parseOpenApiIndexHist,
  parseTwseIndexHist,
} from '../scripts/parsers.mjs';

// 以台北時間建立 Date
const tpe = (s) => new Date(`${s}+08:00`);

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

test('加權指數先取得即時行情值（mis），要等證交所正式資料確認；18:00 後不再追', () => {
  const day = '2026-11-10';
  const s = { closedDates: [], index: { date: day, source: 'mis' } };
  const hasIndex = (time) => dueTasks(s, tpe(`2026-11-10T${time}`)).includes('index');
  assert.equal(hasIndex('13:40:00'), true);
  assert.equal(hasIndex('17:59:00'), true);
  assert.equal(hasIndex('18:00:00'), false);
  s.index.source = 'twse';
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
  // 非交易日、13:00 前非盤後時段（例如凌晨/上午）、跨過當日截止時間 → 沒事了，不啟動輪詢
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

import {
  isPending,
  marginYi,
  marginDiffYi,
  toYiSigned,
  resolveLiveApiUrl,
  inIntradayWindow,
  selectIndexDisplay,
  renderIndex,
  indexBadge,
  acceptLiveQuote,
} from '../js/app.js';

test('尚未揭露：交易日且資料日期早於今天才顯示', () => {
  const closed = ['2026-11-12'];
  assert.equal(isPending('2026-11-10', '2026-11-11', closed), true);
  assert.equal(isPending('2026-11-11', '2026-11-11', closed), false);
  assert.equal(isPending('2026-11-11', '2026-11-12', closed), false); // 休市日不顯示
  assert.equal(isPending('2026-11-13', '2026-11-14', closed), false); // 週六不顯示
});

test('融資與買賣超格式', () => {
  assert.equal(marginYi(536678732), 5367);
  assert.equal(marginDiffYi(536678732, 539915741), -32.4);
  assert.equal(toYiSigned(-34116689906), '−341.17');
});

import { parseBlockTradeScope } from '../scripts/parsers.mjs';

test('依證交所說明文字判斷是否含鉅額', () => {
  assert.equal(parseBlockTradeScope(['x', '本統計資訊含一般、零股、盤後定價、鉅額，不含拍賣、標購。']), true);
  assert.equal(parseBlockTradeScope(['本統計資訊含一般、零股、盤後定價，不含鉅額、拍賣、標購。']), false);
  assert.equal(parseBlockTradeScope(['其他說明']), null);
  assert.equal(parseBlockTradeScope(undefined), null);
});

test('即時行情 mis：收盤後（t ≥ 13:30）才算終盤值，漲跌以前收計算', () => {
  const mk = (o) => ({ msgArray: [{ d: '20261111', t: '13:33:00', z: '44257.15', y: '42711.92', ...o }] });
  assert.deepEqual(parseMisIndex(mk({}), '2026-11-11'), { close: 44257.15, change: 1545.23, changePct: 3.62 });
  assert.equal(parseMisIndex(mk({ t: '13:29:55' }), '2026-11-11'), null); // 盤中
  assert.equal(parseMisIndex(mk({ d: '20261110' }), '2026-11-11'), null); // 昨天的資料（今天休市）
  assert.equal(parseMisIndex(mk({ z: '-' }), '2026-11-11'), null);
  assert.equal(parseMisIndex({ msgArray: [] }, '2026-11-11'), null);
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
  // 多空未平倉都是 0 也不是正常資料
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

test('盤後解析擴充 OHLC：parseMisIndex / parseTwseIndexHist / parseOpenApiIndexHist', () => {
  const mis = {
    msgArray: [{ d: '20261113', t: '13:33:00', z: '43675.12', y: '43091.87', o: '43719.75', h: '44489.48', l: '43534.12' }],
  };
  assert.deepEqual(parseMisIndex(mis, '2026-11-13'), {
    close: 43675.12,
    change: 583.25,
    changePct: 1.35,
    open: 43719.75,
    high: 44489.48,
    low: 43534.12,
  });

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

test('前端即時設定解析、盤中視窗、資料合併與 OHLC 渲染', () => {
  assert.equal(resolveLiveApiUrl({ metaContent: 'https://cmoney-taiex.example.workers.dev/' }), 'https://cmoney-taiex.example.workers.dev/api/taiex');
  assert.equal(resolveLiveApiUrl({ search: '?liveApi=https://demo.workers.dev/api/taiex', metaContent: 'https://other.workers.dev' }), 'https://demo.workers.dev/api/taiex');
  assert.equal(resolveLiveApiUrl({ search: '?liveApi=javascript:alert(1)' }), '');
  assert.equal(resolveLiveApiUrl({ search: '?liveApi=http://evil.example' }), '');
  assert.equal(resolveLiveApiUrl({ globalApi: 'http://localhost:8787' }), 'http://localhost:8787/api/taiex');

  assert.equal(inIntradayWindow('2026-11-13', '08:58:59', []), false);
  assert.equal(inIntradayWindow('2026-11-13', '09:05:10', []), true);
  assert.equal(inIntradayWindow('2026-11-13', '13:35:00', []), true);
  assert.equal(inIntradayWindow('2026-11-13', '13:35:01', []), false);
  assert.equal(inIntradayWindow('2026-11-13', '10:00:00', ['2026-11-13']), false); // 休市日
  assert.equal(inIntradayWindow('2026-11-15', '10:00:00', []), false); // 週日

  const prev = { date: '2026-11-12', close: 43091.87, change: -100, source: 'twse' };
  const live = {
    date: '2026-11-13',
    time: '10:15:30',
    close: 43800.5,
    open: 43719.75,
    high: 44489.48,
    low: 43000.0,
    prevClose: 43091.87,
    change: 708.63,
    changePct: 1.64,
    marketPhase: 'intraday',
    source: 'mis',
    fetchedAt: '2026-11-13T02:15:31Z',
  };
  const settled = {
    date: '2026-11-13',
    close: 43675.12,
    open: 43719.75,
    high: 44489.48,
    low: 43534.12,
    change: 583.25,
    changePct: 1.35,
    source: 'twse',
    fetchedAt: '2026-11-13T05:46:25Z',
  };

  assert.equal(selectIndexDisplay(prev, live, '2026-11-13'), live);
  assert.equal(selectIndexDisplay(settled, live, '2026-11-13'), settled);
  assert.equal(selectIndexDisplay(prev, { ...live, date: '2026-11-12' }, '2026-11-13'), prev);

  const liveHtml = renderIndex(live);
  assert.ok(liveHtml.includes('開盤') && liveHtml.includes('43,719.75'));
  assert.ok(liveHtml.includes('最高') && liveHtml.includes('44,489.48'));
  assert.ok(liveHtml.includes('最低') && liveHtml.includes('43,000.00'));
  assert.ok(liveHtml.includes('ohlc__val down') && liveHtml.includes('ohlc__val up'));
  assert.ok(liveHtml.includes('證交所盤中即時行情'));

  const closedHtml = renderIndex(settled);
  assert.ok(closedHtml.includes('開盤') && closedHtml.includes('43,719.75'));
  assert.ok(closedHtml.includes('最高') && closedHtml.includes('44,489.48'));
  assert.ok(closedHtml.includes('最低') && closedHtml.includes('43,534.12'));

  assert.ok(indexBadge(live, '2026-11-13').includes('盤中即時'));
  assert.ok(indexBadge({ ...live, source: 'yahoo_tw' }, '2026-11-13').includes('盤中即時'));
  assert.ok(indexBadge({ ...live, marketPhase: 'closed', source: 'mis' }, '2026-11-13').includes('即時終盤'));
  assert.ok(indexBadge(settled, '2026-11-13').includes('已收盤'));
  assert.equal(indexBadge(prev, '2026-11-13'), '');

  const ytwHtml = renderIndex({ ...live, source: 'yahoo_tw' });
  assert.ok(ytwHtml.includes('Yahoo 奇摩股市盤中即時'));
  const cnyesHtml = renderIndex({ ...live, source: 'cnyes' });
  assert.ok(cnyesHtml.includes('鉅亨網盤中即時'));

  // 時間戳只往新不往回退，但同一日較舊快取仍可更新 fetchedAt
  assert.equal(acceptLiveQuote(null, live), live);
  assert.equal(acceptLiveQuote(live, { ...live, date: '2026-11-12' }), live);
  const olderSameDay = acceptLiveQuote(live, { ...live, time: '10:15:10', close: 43750, fetchedAt: '2026-11-13T02:15:40Z' });
  assert.equal(olderSameDay.close, 43800.5);
  assert.equal(olderSameDay.time, '10:15:30');
  assert.equal(olderSameDay.fetchedAt, '2026-11-13T02:15:40Z');
  const newerTick = acceptLiveQuote(live, { ...live, time: '10:15:40', close: 43820 });
  assert.equal(newerTick.close, 43820);
});

import worker, {
  parseMisLive,
  parseYahooTwLive,
  parseCnyesLive,
  parseYahooLive,
  pickFreshestQuote,
  isWorkerIntradayWindow,
} from '../worker/worker.js';

test('Cloudflare Worker：多源盤中搶鮮競速、Cache API 去重、多層備援與陳舊快取保護', async () => {
  // 1. 解析純函式驗證
  assert.equal(parseMisLive({ msgArray: [{ d: '20261113', t: '09:00:00', z: '-', y: '43091.87' }] }), null);
  const parsedMis = parseMisLive({
    msgArray: [{ d: '20261113', t: '09:30:15', z: '43500.5', y: '43091.87', o: '43400', h: '43600', l: '43350' }],
  });
  assert.equal(parsedMis.marketPhase, 'intraday');
  assert.equal(parsedMis.open, 43400);
  assert.equal(parsedMis.change, 408.63);

  const parsedYtw = parseYahooTwLive([
    {
      chart: {
        meta: { regularMarketTime: 1794792060, regularMarketPrice: 42693.3, previousClose: 43675.12 }, // 2026-11-16 09:21:00
        quote: {
          price: '42693.30',
          previousClose: '43675.12',
          openPrice: '43512.42',
          dayHighPrice: '43512.42',
          dayLowPrice: '42595.92',
          marketStatus: 'open',
          refreshedTs: '2026-11-16T01:20:55Z', // 09:20:55 +08:00
        },
      },
    },
  ]);
  assert.equal(parsedYtw.date, '2026-11-16');
  assert.equal(parsedYtw.time, '09:20:55');
  assert.equal(parsedYtw.close, 42693.3);
  assert.equal(parsedYtw.open, 43512.42);
  assert.equal(parsedYtw.source, 'yahoo_tw');

  const parsedCnyes = parseCnyesLive({
    data: [{ 6: 42768.12, 12: 43512.42, 13: 42595.92, 19: 43512.42, 21: 43675.12, 200007: 1794791930 }],
  });
  assert.equal(parsedCnyes.date, '2026-11-16');
  assert.equal(parsedCnyes.time, '09:18:50');
  assert.equal(parsedCnyes.source, 'cnyes');

  const parsedYahoo = parseYahooLive({
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: 43675.12,
            previousClose: 43091.9,
            regularMarketTime: 1794547995, // 2026-11-13 13:33:15 +08:00
            regularMarketDayHigh: 44489.48,
            regularMarketDayLow: 43534.12,
          },
          indicators: { quote: [{ open: [null, 43719.75] }] },
        },
      ],
    },
  });
  assert.equal(parsedYahoo.date, '2026-11-13');
  assert.equal(parsedYahoo.open, 43719.75);
  assert.equal(parsedYahoo.source, 'yahoo');

  // 競速排序：較新時間優先，同分秒以官方 MIS 優先
  const misLag = { ok: true, date: '2026-11-16', time: '09:20:00', close: 42775, source: 'mis' };
  const ytwFresh = { ok: true, date: '2026-11-16', time: '09:20:55', close: 42693, source: 'yahoo_tw' };
  assert.equal(pickFreshestQuote([misLag, ytwFresh]).source, 'yahoo_tw');
  const misTie = { ok: true, date: '2026-11-16', time: '09:20:55', close: 42693, source: 'mis' };
  assert.equal(pickFreshestQuote([ytwFresh, misTie]).source, 'mis');

  assert.equal(isWorkerIntradayWindow(tpe('2026-11-13T10:00:00')), true);
  assert.equal(isWorkerIntradayWindow(tpe('2026-11-13T13:36:00')), false);
  assert.equal(isWorkerIntradayWindow(tpe('2026-11-15T10:00:00')), false);

  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;

  const cacheStore = new Map();
  globalThis.caches = {
    default: {
      async match(key) {
        const hit = cacheStore.get(String(key));
        return hit ? hit.clone() : undefined;
      },
      async put(key, res) {
        cacheStore.set(String(key), res.clone());
      },
    },
  };

  let upstreamCalls = 0;
  let mode = 'ytw_freshest';

  globalThis.fetch = async (url) => {
    upstreamCalls += 1;
    const u = String(url);
    if (u.includes('tw.stock.yahoo.com')) {
      if (mode !== 'ytw_freshest') return new Response('Err', { status: 503 });
      return new Response(
        JSON.stringify([
          {
            chart: {
              meta: { regularMarketTime: 1794536460, regularMarketPrice: 43888, previousClose: 43091.87 }, // 2026-11-13 10:21:00
              quote: {
                price: '43888',
                previousClose: '43091.87',
                openPrice: '43719.75',
                dayHighPrice: '43920',
                dayLowPrice: '43600',
                marketStatus: 'open',
                refreshedTs: '2026-11-13T02:20:55Z', // 10:20:55
              },
            },
          },
        ]),
        { status: 200 },
      );
    }
    if (u.includes('ws.api.cnyes.com')) {
      if (mode === 'mis_only' || mode === 'yahoo_backup' || mode === 'all_fail') {
        return new Response('Err', { status: 503 });
      }
      return new Response(
        JSON.stringify({
          data: [{ 6: 43850, 12: 43900, 13: 43600, 19: 43719.75, 21: 43091.87, 200007: 1794536430 }], // 10:20:30
        }),
        { status: 200 },
      );
    }
    if (u.includes('mis.twse.com.tw')) {
      if (mode === 'yahoo_backup' || mode === 'all_fail') {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(
        JSON.stringify({
          msgArray: [{ d: '20261113', t: '10:20:00', z: '43800', y: '43091.87', o: '43719.75', h: '43900', l: '43600' }],
        }),
        { status: 200 },
      );
    }
    if (u.includes('query1.finance.yahoo.com')) {
      if (mode === 'all_fail') return new Response('Err', { status: 503 });
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 43810,
                  previousClose: 43091.87,
                  regularMarketTime: 1794536400, // 2026-11-13 10:20:00 +08:00
                  regularMarketDayHigh: 43900,
                  regularMarketDayLow: 43600,
                },
                indicators: { quote: [{ open: [43719.75] }] },
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    throw new Error('Unexpected fetch url: ' + u);
  };

  try {
    // CORS preflight
    const preflightAllowed = await worker.fetch(
      new Request('https://taiex.example/api/taiex', {
        method: 'OPTIONS',
        headers: { Origin: 'https://ljwwei.github.io' },
      }),
      {},
    );
    assert.equal(preflightAllowed.status, 204);
    assert.equal(preflightAllowed.headers.get('Access-Control-Allow-Origin'), 'https://ljwwei.github.io');

    const preflightDenied = await worker.fetch(
      new Request('https://taiex.example/api/taiex', {
        method: 'OPTIONS',
        headers: { Origin: 'https://untrusted.example' },
      }),
      {},
    );
    assert.equal(preflightDenied.headers.get('Access-Control-Allow-Origin'), null);

    // Health check
    const healthRes = await worker.fetch(new Request('https://taiex.example/health'), {});
    assert.equal(healthRes.status, 200);
    assert.equal((await healthRes.json()).ok, true);

    // 搶鮮挑選時間最新的 yahoo_tw (10:20:55 勝過 mis 10:20:00)，且不讓瀏覽器自行快取
    const r1 = await worker.fetch(
      new Request('https://taiex.example/api/taiex', { headers: { Origin: 'https://ljwwei.github.io' } }),
      {},
    );
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get('Cache-Control') || '', /no-store/);
    const j1 = await r1.json();
    assert.equal(j1.source, 'yahoo_tw');
    assert.equal(j1.time, '10:20:55');
    assert.equal(j1.close, 43888);
    assert.equal(upstreamCalls, 3);

    const r2 = await worker.fetch(
      new Request('https://taiex.example/api/taiex?t=cachebust', { headers: { Origin: 'http://localhost:8080' } }),
      {},
    );
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');
    assert.equal(upstreamCalls, 3, 'Cache API hit must reuse edge cache across allowed origins');

    // Yahoo TW 失敗 -> Cnyes (10:20:30) 自動補上搶鮮
    cacheStore.delete('https://cache.cmoney.local/api/taiex-v2');
    mode = 'cnyes_freshest';
    const rCnyes = await worker.fetch(new Request('https://taiex.example/api/taiex'), {});
    assert.equal((await rCnyes.json()).source, 'cnyes');

    // Yahoo TW & Cnyes 失敗 -> MIS (10:20:00) 正常接手
    cacheStore.delete('https://cache.cmoney.local/api/taiex-v2');
    mode = 'mis_only';
    const rMis = await worker.fetch(new Request('https://taiex.example/api/taiex'), {});
    assert.equal((await rMis.json()).source, 'mis');

    // 前三者全失敗 -> Yahoo 全域備援
    cacheStore.delete('https://cache.cmoney.local/api/taiex-v2');
    mode = 'yahoo_backup';
    const r3 = await worker.fetch(
      new Request('https://taiex.example/api/taiex', { headers: { Origin: 'https://ljwwei.github.io' } }),
      {},
    );
    assert.equal(r3.status, 200);
    const j3 = await r3.json();
    assert.equal(j3.source, 'yahoo');
    assert.equal(j3.close, 43810);

    // Clear live cache -> simulate all upstreams failing -> return stale cache gracefully
    cacheStore.delete('https://cache.cmoney.local/api/taiex-v2');
    mode = 'all_fail';
    const r4 = await worker.fetch(
      new Request('https://taiex.example/api/taiex', { headers: { Origin: 'https://ljwwei.github.io' } }),
      {},
    );
    assert.equal(r4.status, 200);
    const j4 = await r4.json();
    assert.equal(j4.stale, true);

    // No stale cache either -> 502
    cacheStore.clear();
    const r5 = await worker.fetch(new Request('https://taiex.example/api/taiex'), {});
    assert.equal(r5.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});