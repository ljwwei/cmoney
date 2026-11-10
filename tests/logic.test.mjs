import test from 'node:test';
import assert from 'node:assert/strict';
import { dueTasks, isTradingDay, taipeiParts, institutionalStage } from '../scripts/schedule.mjs';
import { parseHolidays, parseMargin, parseFuturesCsv, parseIndex } from '../scripts/parsers.mjs';

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
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T13:39:00')), []);
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T13:40:00')), ['index']);
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T14:50:00')), ['index', 'futures']);
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T15:00:00')), ['index', 'futures', 'institutional']);
  assert.deepEqual(dueTasks(s, tpe('2026-11-10T20:35:00')), ['index', 'futures', 'institutional', 'margin']);
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

import { isPending, marginYi, marginDiffYi, toYiSigned } from '../js/app.js';

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
