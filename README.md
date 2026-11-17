# 台股資訊 cmoney

台股盤中即時大盤（富果 WebSocket 主力 + Yahoo 條件備援）+ 每日盤後資訊網站（純靜態頁 + GitHub Actions 定時抓取 + Cloudflare Worker / Durable Object 單例即時代理 + 網站瀏覽人次計數），電腦版與手機版各自優化排版。

| 資訊 | 來源 | 規則 |
|---|---|---|
| 加權指數 | 盤中：Cloudflare Worker + Durable Object (`FugleHub`) 單例連線**富果 Fugle WebSocket** + Intraday Quote 快照（嚴格條件啟動 **Yahoo `^TWII`** 備援）<br>盤後：證交所 `MI_INDEX` + `MI_5MINS_HIST` | 啟動時先抓快照防空白，並透過唯一一條 WS 接收即時跳動（`/api/stream` SSE 廣播，SSE 受阻時前端自動退回非重疊 2.5 秒輪詢）；單調時間戳防呆只進不退；紅漲綠跌 |
| 三大法人買賣超 | 證交所 `BFI82U` | 外資、投信、自營商（自行買賣＋避險）買賣超金額（億）。買超紅、賣超綠。標註「不含鉅額 / 含鉅額」 |
| 外資台股期貨未平倉 | 期交所「三大法人-區分各期貨契約」CSV | 外資及陸資・臺股期貨・未平倉多空淨額，取絕對值顯示口數（−103473 → 103,473 口 淨空單） |
| 融資餘額 | 證交所 `MI_MARGN` | 融資金額今日餘額（仟元）→ 億（四捨五入），並與「前日餘額」比較顯示增減（億，1 位小數） |
| 累積瀏覽總人次 | Cloudflare D1 (`DB`)／`FugleHub` 內建 SQLite (`site_counters`) | 載入首頁時呼叫 `POST /api/stats/visits`，與民德市政府官網同規格累加顯示於頁尾 |

## 抓取時間（台北時間，非交易日一律不抓）

到開始時間後，**每 30 秒**抓一次，抓到當日資料就停。

| 項目 | 開始 | 結束條件 |
|---|---|---|
| 加權指數 | 13:30 | 取得證交所盤後正式資料（`MI_INDEX` 含完整開高低；若先拿到純收盤值會先顯示並標記 `ohlcPending`，18:00 前持續等待補齊） |
| 外資期貨未平倉 | 14:30 | 抓到當日資料 |
| 三大法人（不含鉅額） | 14:30 | 抓到當日資料 |
| 三大法人（含鉅額） | 20:00 | 證交所說明文字變為「含鉅額」 |
| 融資餘額 | 20:30 | 抓到當日資料 |

### 加權指數來源
1. **盤中即時（主力）**：Cloudflare Worker `FugleHub` Durable Object 維持唯一一條 `wss://api.fugle.tw/marketdata/v1.0/stock/streaming`（`indices` 頻道、`IX0001`）＋ 初期 `/stock/intraday/quote/IX0001` 快照防空白。無任何前端連線超過 30 秒自動關閉 WS 釋放免費額度；遭遇 `Close Code 1013` 冷卻至少 15 秒。
2. **盤中備援（預設完全休眠）**：僅在「未設定 `FUGLE_API_KEY`」、「WS 連敗 3 次或斷線逾 10 秒」、或「盤中 `09:00–13:30` 逾 12 秒無資料與 ping/pong 回應」時，啟動 Yahoo 輪詢（`AbortController` `2000ms` + `&_=` 防快取 + 遞迴 `setTimeout`），並在背景每 15 秒嘗試回切富果。
3. **盤後正式**：證交所 `MI_INDEX?type=IND` ＋ `MI_5MINS_HIST`（失敗時退回證交所 OpenAPI `/v1/indicesReport/MI_5MINS_HIST`）。

> `/indicesReport/MFI94U` 是「發行量加權股價**報酬**指數」，不是我們要的加權股價指數，所以不採用。

### 排程喚醒架構
1. **精準喚醒（Cloudflare Workers Cron）**：透過 Worker `scheduled` Cron Trigger（平日 13:20–21:30 區間）發送 `workflow_dispatch` 喚醒 GitHub Actions。
2. **常駐輪詢與時段守門員**：進入 13:00~23:55 盤後時段後在同一個 runner 內每 30 秒執行一次抓取，直到當日所有項目抓齊退出。
3. **前端即時同步**：除了 GitHub Pages 的 `data.json`，前端在盤後時段（13:25 後）也會直接透過 GitHub API 讀取最新 raw 檔案，免去 Pages 部署的等待延遲。

### 非交易日機制 & 資料防呆
1. 週六、週日與證交所 `holidaySchedule` 列入 `closedDates` 不抓；16:00 後 `MI_INDEX` 正常回應但確定無今日資料時推斷為臨時休市（`inferredClosed`）。
2. 外資期貨整列全 0、多空未平倉皆為 0，或三大法人／融資金額全 0，皆視為尚未公布正式資料，不寫入並繼續輪詢。

## 專案結構

```
index.html, css/style.css, js/app.js   前端（單例 EventSource SSE、單調時間戳、僅顯示富果/Yahoo備援標籤、頁尾人數計次）
data/data.json                         盤後抓取結果（由 Actions 自動 commit）
scripts/fetch.mjs, parsers.mjs, schedule.mjs   盤後抓取／解析／排程模組
worker/core.mjs                        Fugle WS 單例引擎、Yahoo 條件備援、SSE 與計次純邏輯（可供 Node 單元測試）
worker/worker.js                       Cloudflare Worker + Durable Object (FugleHub) 進入點
wrangler.jsonc                         Cloudflare Worker / SQLite Durable Object 部署組態
.env.example                           環境變數與 FUGLE_API_KEY Secret 設定範例
.github/workflows/update.yml           盤後定時排程
tests/logic.test.mjs                   單元測試（node --test tests/）
```

## 啟用盤中即時大盤與人數計次（Cloudflare Worker）
因富果免費方案嚴格限制 WebSocket 同時連線數（超限會斷線 `Close Code 1013`），本專案使用 `wrangler.jsonc` 定義的 **SQLite-backed Durable Object (`FugleHub`)**（Workers 免費方案即可使用）統一維持後端唯一一條 WS 連線並儲存累積瀏覽人次：

1. **設定環境變數 Secret**（切勿寫死於程式碼或送進 Git）：
   ```bash
   npx wrangler secret put FUGLE_API_KEY
   ```
   （本機開發可複製 `.env.example` 為 `.dev.vars`；若為正式公開網站，請於富果後台限制 API Key 網域或白名單）
2. **部署 Worker**（需讓 `wrangler.jsonc` 中的 Durable Object migration 生效，請勿只用控制台貼上單檔）：
   - 方式 A（本機 CLI）：執行 `npx wrangler deploy`
   - 方式 B（Cloudflare Dashboard 自動部署）：Worker 連結此 GitHub 儲存庫（Workers Builds），每次推上 `main` 即依 `wrangler.jsonc` 自動部署。
   - （選用）若想獨立保存計次於 D1，可在 `wrangler.jsonc` 取消 `d1_databases` 註解並建立資料庫；未綁定 D1 時已自動由 `FugleHub` 內建 SQLite 永久計次。
3. 將部署好的 Worker 網址填入 [index.html](index.html) 的 `<meta name="taiex-api" content="https://你的worker.workers.dev" />`（預設已填 `cmoney-taiex.gamerwillywilly.workers.dev`）。
   - 測試期也可直接在網址後方加上 `?liveApi=https://你的worker.workers.dev&forceLive=1` 立即驗證即時連線。

## 部署與本機測試
1. 推到 GitHub 後啟用 Pages（`main` / `(root)`），網站網址：`https://ljwwei.github.io/cmoney/`
2. 本機指令：
```bash
npm test                                  # 執行單元測試
node scripts/fetch.mjs --date=2026-11-10  # 補抓指定日期盤後資料
node scripts/serve.mjs                    # 預覽 http://localhost:8080
```
