# 台股資訊 cmoney

每日台股盤後資訊網站（純靜態頁 + GitHub Actions 定時抓取），電腦版與手機版各自優化排版。

| 資訊 | 來源 | 規則 |
|---|---|---|
| 加權指數 | 證交所 `MI_INDEX` | 收盤、漲跌點數、漲跌幅% 直接取自證交所；若缺漏則以前一交易日收盤自行計算。紅漲綠跌 |
| 三大法人買賣超 | 證交所 `BFI82U` | 外資、投信、自營商（自行買賣＋避險）買賣超金額（億）。買超紅、賣超綠。標註「不含鉅額 / 含鉅額」 |
| 外資台股期貨未平倉 | 期交所「三大法人-區分各期貨契約」CSV | 外資及陸資・臺股期貨・未平倉多空淨額，取絕對值顯示口數（−103473 → 103,473 口 淨空單） |
| 融資餘額 | 證交所 `MI_MARGN` | 融資金額今日餘額（仟元）→ 億（四捨五入），並與「前日餘額」比較顯示增減（億，1 位小數） |

## 抓取時間（台北時間，非交易日一律不抓）

| 項目 | 開始 | 頻率 | 結束條件 |
|---|---|---|---|
| 加權指數 | 13:40 | 5 分鐘 | 抓到當日資料 |
| 外資期貨未平倉 | 14:50 | 5 分鐘 | 抓到當日資料 |
| 三大法人（不含鉅額） | 15:00 | 5 分鐘 | 抓到當日資料 |
| 三大法人（含鉅額） | 20:00 | 5 分鐘 | 抓到 20:00 後的資料 |
| 融資餘額 | 20:35 | 2 分鐘 | 抓到當日資料 |

### 非交易日機制
1. 週六、週日不抓。
2. 國定假日、春節長假等：每天讀取證交所 `holidaySchedule`（排除「開始交易日／最後交易日」），列入 `closedDates`。
3. 颱風等**臨時休市**：08:30 會更新行事曆；若行事曆尚未收錄，則在 16:00 後加權指數仍「確定無資料」時，推斷當日休市（寫入 `inferredClosed`），當日不再抓取。
4. 若誤判，可用 Actions 手動補抓該日期，有資料時會自動撤銷休市判定。

### 「當日資訊尚未揭露」
前端以台北時間判斷：**今天是交易日、且該項資料日期早於今天**（即 00:00 之後到抓到新資料前）→ 該卡片顯示註明並維持顯示前一交易日資料；抓到當日資料後註明自動消失。今天不是交易日則不顯示註明，直到交易日當天 00:00。四個資訊各自獨立判斷。

## 專案結構

```
index.html, css/style.css, js/app.js   前端（RWD：手機 <600px、平板、電腦 ≥960px 各自排版）
data/data.json                         抓取結果（由 Actions 自動 commit）
scripts/fetch.mjs                      抓取主程式
scripts/schedule.mjs                   排程／交易日判斷（純函式）
scripts/parsers.mjs                    各來源解析
.github/workflows/update.yml           定時排程
tests/logic.test.mjs                   單元測試（node --test tests/）
```

## 部署
1. 推到 GitHub 後：**Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**。
2. **Settings → Actions → General → Workflow permissions** 選 *Read and write permissions*（workflow 已宣告 `contents: write`，通常即可）。
3. 網站網址：`https://ljwwei.github.io/cmoney/`

## 本機
```
npm test                                # 單元測試
node scripts/fetch.mjs --date=2026-11-10  # 補抓指定日期
node scripts/serve.mjs                  # 預覽 http://localhost:8080
```

## 注意
- GitHub Actions 的 cron 最短 5 分鐘，且高峰時可能延遲數分鐘；融資餘額的 2 分鐘頻率是在一次排程內重複執行 3 輪（0／2／4 分鐘）達成。
- 證交所公開資料的內容與公布時間以證交所為準；三大法人「不含／含鉅額」依抓取時間（20:00 前／後）標註。
- 資料僅供參考，不構成投資建議。
