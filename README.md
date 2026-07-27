# cf-todo-demo — 一個 Worker，四種身分

Cloudflare Workers + D1 + R2 的教學範例。單一頁面，同時是簡介與可操作的 Demo。

一支 Worker 同時扮演四個角色：

| 身分 | 由誰負責 | 對應設定 |
|------|---------|---------|
| 靜態網站主機 | Cloudflare 邊緣節點 | `wrangler.jsonc` 的 `assets` |
| API 伺服器 | `src/index.js` | `run_worker_first: ["/api/*"]` |
| 資料庫用戶端 | `env.DB` | `d1_databases` |
| 物件儲存閘道 | `env.BUCKET` | `r2_buckets` |

頁面上的 **Edge Trace** 會即時顯示每個請求實際走過的路徑與耗時 —— 資料來自 Worker 回應的 `X-Edge-Trace` header，不是寫死的示意圖。

---

## 檔案結構

```
.
├── wrangler.jsonc              # 所有 Cloudflare 設定都在這裡（有詳細註解）
├── package.json
├── .node-version               # 釘住 Node 22，Workers Builds 也吃這個檔
├── migrations/
│   └── 0001_create_todos.sql   # D1 的資料表定義
├── scripts/
│   └── check-setup.mjs         # 部署前檢查該換的值換了沒
├── src/
│   └── index.js                # Worker：只處理 /api/*
└── public/                     # 靜態資產，由邊緣節點直接送出
    ├── index.html
    ├── styles.css
    └── app.js
```

---

## 一、本機跑起來

需要 Node.js 22 以上 —— 這是 wrangler 4 的硬性需求，版本不夠的話 npm install 之後所有 wrangler 指令都會被擋下。

```bash
npm install

# 建立本機的 D1 資料表（會存在 .wrangler/ 底下的 SQLite 檔）
npm run db:local

npm run dev
```

打開終端機印出的網址（預設 <http://localhost:8787>）。

還沒設定 Google 用戶端 ID 也沒關係 —— 頁面會提供「本機示範帳號」，D1 與 R2 的部分照樣能完整操作。

---

## 二、建立 Cloudflare 上的資源

先登入：

```bash
npx wrangler login
```

### D1

```bash
npx wrangler d1 create todo-db
```

> 建立資源的指令要自己打名字，因為東西還不存在、還沒有 binding 可以指。
> 想換名字的話，這裡打什麼，`wrangler.jsonc` 的 `database_name` 就填什麼。

指令會印出一段設定，把裡面的 `database_id` 貼進 `wrangler.jsonc`：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "todo-db",
    "database_id": "貼上這裡"     // ← 換掉 PASTE_YOUR_D1_DATABASE_ID_HERE
  }
]
```

### R2

> R2 需要先在 Cloudflare 後台啟用（**R2 → 開始使用**），過程中要綁定付款方式。免費額度內不會扣款，但這一步跳不過。D1 不需要。

```bash
npx wrangler r2 bucket create todo-images
```

R2 沒有 id，用 bucket 名稱對應，所以 `wrangler.jsonc` 只要 `bucket_name` 跟這裡一致就行。

### 在線上建立資料表

```bash
npm run db:remote      # 等同 npx wrangler d1 migrations apply DB --remote
```

**少了 `--remote` 只會套用到本機那份 SQLite，線上依然是空的。** 這是這個範例最常見的錯誤。

> 注意這裡用的是 `DB` 不是 `todo-db` —— wrangler 的 D1 指令接受「資料庫名稱**或** binding 名稱」。
> 用 binding 的好處是：你改資料庫名稱時，npm script 完全不用動。

---

## 三、設定 Google 登入（選用）

只需要**用戶端 ID**，不需要用戶端密鑰。

1. 到 [Google Cloud Console](https://console.cloud.google.com/apis/credentials) 建立專案
2. **API 和服務 → 憑證 → 建立憑證 → OAuth 用戶端 ID**
3. 應用程式類型選 **網頁應用程式**
4. 「已授權的 JavaScript 來源」加入你會用到的網址：
   - `http://localhost:8787`（本機開發）
   - `https://cf-todo-demo.<你的子網域>.workers.dev`（部署後）
5. 把產生的用戶端 ID 貼進 `wrangler.jsonc`：

```jsonc
"vars": {
  "GOOGLE_CLIENT_ID": "1234567890-abcdefg.apps.googleusercontent.com"
}
```

「已授權的重新導向 URI」留空即可 —— Google Identity Services 的前端登入不會用到。

前端不會把用戶端 ID 寫死在 `app.js`，而是開頁時跟 `GET /api/config` 拿。這樣換 Google 專案只要改 `wrangler.jsonc`，不用動前端程式碼。

> 本機想用另一組 ID，可以建一個 `.dev.vars` 檔（已被 `.gitignore` 擋掉）：
> ```
> GOOGLE_CLIENT_ID=另一組本機專用的 ID
> ```

---

## 四、部署：讓 GitHub 推送自動觸發

### 1. 推上 GitHub

```bash
git init
git add .
git commit -m "init"
git remote add origin <你的 repo 網址>
git push -u origin main
```

### 2. 在 Cloudflare 後台連接 repo

**Workers & Pages → Create → Workers → Import a repository**

選好 repo 之後：

| 欄位 | 填什麼 |
|------|-------|
| Build command | 留空（這個專案沒有建置步驟） |
| Deploy command | `npm run deploy` |
| Root directory | 留空（除非 repo 裡還有其他專案） |

接好之後，每次 push 到 `main` 都會自動部署。

> Deploy command 用 `npm run deploy` 而不是 `npx wrangler deploy`，是為了讓 `predeploy` 的設定檢查
> 也在 CI 跑一次 —— 忘記換 `database_id` 的話，建置會直接停下來並告訴你原因，
> 而不是部署成功、線上卻連不到資料庫。

### 關於 migration

Workers Builds **不會**自動套用 D1 migration。新增 migration 檔之後，記得在本機手動跑一次：

```bash
npm run db:remote
```

也可以把 Deploy command 改成 `npx wrangler d1 migrations apply DB --remote && npm run deploy`，讓部署順便跑 migration。這取決於建置環境的 API token 有沒有 D1 寫入權限，如果失敗就退回手動執行。

---

## 換成你自己的資源名稱

真正**每個人一定不同**的只有 `database_id`。其他名稱整班沿用預設值也不會出事 ——
資源名稱是各自 Cloudflare 帳號內部的，不同帳號之間不會撞名。

要換的話，全部集中在 `wrangler.jsonc` 一個檔案：

| 要換的東西 | 在 `wrangler.jsonc` 的哪一個欄位 | 還有哪裡要跟著改 |
|---|---|---|
| Worker 名稱 | `name` | 沒有（它同時決定 `*.workers.dev` 的網址） |
| D1 名稱 | `database_name` | 建立時打的那行 `npx wrangler d1 create <名稱>` |
| R2 名稱 | `bucket_name` | 建立時打的那行 `npx wrangler r2 bucket create <名稱>` |
| D1 的 UUID | `database_id` | 沒有 |

**不要改的是 binding 名稱**（`DB`、`BUCKET`、`ASSETS`）。那是程式裡的 `env.DB`、`env.BUCKET`，
也是 npm script 用來指涉資源的代號 —— 正因為 script 用的是 binding 而不是資源名稱，
換資源名稱才不用動 `package.json`。改 binding 就要連 `src/index.js` 一起改。

忘記換 `database_id` 就部署的話，`npm run deploy` 會在送出之前先擋下來：

```
✘ 設定還沒完成

  wrangler.jsonc 的 database_id 還是預設的佔位字串。

    1. 執行：npx wrangler d1 create todo-db
    2. 把指令印出來的那串 UUID 貼進 wrangler.jsonc 的 database_id
```

---

## 這些值可以放進環境變數嗎？

`database_id`、`bucket_name` 這些**不行**，但你大概也不需要。

### 為什麼不行

`wrangler.jsonc` 裡有兩種東西，它們活在**不同的時間點**：

| | 誰讀它 | 什麼時候 |
|---|---|---|
| `d1_databases` / `r2_buckets`（綁定） | `wrangler deploy` | **部署時** —— 決定要把哪個資料庫、哪個 bucket 接上去 |
| `vars` / secret | Worker 自己 | **執行時** —— 程式碼用 `env.XXX` 讀 |

`database_id` 是部署時就要用的，所以不可能從執行時的 `vars` 拿 —— 那時候綁定早就決定好了。

而且 `wrangler.jsonc` **不支援** `${VAR}` 這種字串插值。寫了會被當成字面文字：

```
✘ [ERROR] r2_buckets[0].bucket_name="$R2_BUCKET_NAME" is invalid.
  Bucket names must begin and end with an alphanumeric character...
```

### 為什麼不需要

因為這些值都不是機密：

| 值 | 是機密嗎 | 為什麼 |
|---|---|---|
| `database_id` | 不是 | 帳號內的 UUID。沒有 API token，拿到也做不了任何事 |
| `bucket_name` | 不是 | 就是一個名字 |
| `GOOGLE_CLIENT_ID` | 不是 | 設計上就是公開的，本來就會出現在瀏覽器裡 |

整套東西裡唯一的機密是 **Cloudflare API token**，它存在 Cloudflare 的建置環境，從頭到尾不會進你的 repo。Cloudflare 官方範本也是直接把 `database_id` 提交進版控的。

### 如果還是想從設定檔裡拿掉

**做法一：省略 `database_id`，讓 wrangler 用名稱去找**

```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "todo-db" }]
```

這叫自動佈建（auto-provisioning，目前是 beta）。部署時 wrangler 依 `database_name` 找既有的資料庫，找不到就建一個，再把 id 寫回設定檔。教學專案還是建議留著明確的 id —— 行為比較好預測，學員也看得到「這個 UUID 是從哪來的」。

**做法二：把 `GOOGLE_CLIENT_ID` 改成 secret**

`vars` 和 secret 在程式裡都是 `env.GOOGLE_CLIENT_ID`，**程式碼一行都不用改**：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

改用 secret 之後，把 `wrangler.jsonc` 的 `vars.GOOGLE_CLIENT_ID` 那一行刪掉，不要兩邊都設。本機開發改用 `.dev.vars`（已被 `.gitignore` 擋掉）。

> secret 的意思是「不進版控」，不是「不會外流」。這個值最後還是會送到瀏覽器 —— 它本來就該公開。
> secret 與 var 的差別在於**值存在哪裡**，不是它會不會被看見。真正的機密（API key、資料庫密碼）才是 secret 的用途。

**做法三：用 `env` 區分正式與測試環境**

```jsonc
{
  "d1_databases": [{ "binding": "DB", "database_name": "todo-db-dev", "database_id": "開發用的 UUID" }],
  "env": {
    "production": {
      "d1_databases": [{ "binding": "DB", "database_name": "todo-db", "database_id": "正式用的 UUID" }]
    }
  }
}
```

部署時加 `--env production`。兩份設定都在同一個檔案裡，一眼看得出差在哪。

---

## API 一覽

所有端點都在 `/api/*`，其餘路徑由邊緣節點直接送出靜態檔案。

| 方法 | 路徑 | 說明 | 經過 |
|------|------|------|------|
| `GET` | `/api/config` | 取得 Google 用戶端 ID | Worker |
| `GET` | `/api/todos` | 列出自己的待辦 | Worker → D1 |
| `POST` | `/api/todos` | 新增待辦 | Worker → D1 |
| `PATCH` | `/api/todos/:id` | 改標題或完成狀態 | Worker → D1 |
| `DELETE` | `/api/todos/:id` | 刪除待辦（連同 R2 的圖） | Worker → D1 → R2 → D1 |
| `PUT` | `/api/todos/:id/image` | 上傳附圖（`multipart/form-data`，欄位名 `file`） | Worker → D1 → R2 → D1 |
| `DELETE` | `/api/todos/:id/image` | 移除附圖 | Worker → D1 → R2 → D1 |
| `GET` | `/api/images/*` | 從 R2 讀出圖片 | Worker → R2 |

除了 `/api/config` 和 `/api/images/*` 之外，都需要 `X-User-Id` header。

用 curl 試：

```bash
curl -X POST http://localhost:8787/api/todos \
  -H "X-User-Id: test-user" \
  -H "Content-Type: application/json" \
  -d '{"title":"從 curl 新增"}' -i
```

回應的 `X-Edge-Trace` header 就是頁面上那條軌跡的原始資料。

---

## ⚠️ 這個範例故意簡化了什麼

這是教學範例，有兩處**不能照抄到正式產品**。

### 後端沒有驗證身分

前端用 Google Identity Services 登入後，把 ID Token 裡的 `sub` 放進 `X-User-Id` header，Worker 直接信任這個值 —— **沒有驗證簽章**。任何人都能用 curl 帶上別人的編號讀寫別人的資料。

正式做法（一樣不需要用戶端密鑰）：

1. 前端改送 `Authorization: Bearer <ID Token>`
2. Worker 取 `https://www.googleapis.com/oauth2/v3/certs` 的公鑰（JWKS）
3. 用 `crypto.subtle.importKey` + `crypto.subtle.verify` 驗簽
4. 檢查 payload 的 `iss` / `aud` / `exp`
5. 通過之後才拿 `payload.sub` 當使用者編號

`src/index.js` 的 `readUserId()` 有完整註解。

### 圖片端點沒有權限檢查

`GET /api/images/*` 是公開的，因為 `<img src>` 沒辦法帶 header。物件鍵含隨機 UUID 所以猜不到，課堂上夠用，但正式環境應該改用簽章網址或 Cookie session。

**做對的部分**（這些請照抄）：

- 所有 SQL 都用 `prepare().bind()` 預備語句，沒有字串拼接
- R2 的物件鍵有擋路徑穿越（`..`、開頭斜線、前綴檢查）
- `X-User-Id` 即使不驗證也有淨化，因為它會被拿去組物件鍵
- 上傳有限制格式與大小，副檔名由 MIME type 決定而非使用者檔名
- 前端一律用 `textContent` 而非 `innerHTML` 塞使用者輸入
- 每個查詢都帶 `WHERE user_id = ?`，資料天然隔離

---

## 常見錯誤

| 訊息 / 症狀 | 原因 | 解法 |
|------|------|------|
| `Wrangler requires at least Node.js v22.0.0` | Node 版本太舊 | `nvm install 22 && nvm use 22`（或用 Volta / fnm） |
| `npm install` 出現 `EBADENGINE` 警告 | 同上 | 同上。這個警告不會中斷安裝，但之後 wrangler 一定會失敗 |
| `no such table: todos` | 只套用到本機 | `npm run db:remote` |
| 部署失敗，說找不到 database | `database_id` 還是 `PASTE_YOUR_...` | 填入 `npx wrangler d1 create` 印出的 UUID（`npm run check` 會先幫你擋下來） |
| `The given origin is not allowed for the given client ID` | Google 那邊沒加這個網址 | 到憑證設定把網址加進「已授權的 JavaScript 來源」 |
| 頁面正常但 `/api/*` 回 404 或 HTML | `run_worker_first` 沒設好 | 確認 `wrangler.jsonc` 的 `assets.run_worker_first` 是 `["/api/*"]` |
| R2 指令失敗 | 帳號還沒啟用 R2 | 到後台 **R2 → 開始使用**，綁定付款方式 |
| 改了程式碼但線上沒變 | 瀏覽器快取 | 硬重新整理（<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>） |

看線上的即時日誌：

```bash
npm run tail
```

看線上資料庫的內容：

```bash
npm run db:list
```

---

## npm scripts

| 指令 | 做什麼 |
|------|-------|
| `npm run dev` | 本機開發伺服器 |
| `npm run check` | 檢查 `wrangler.jsonc` 該換的值都換過了 |
| `npm run deploy` | 部署（會先自動跑 `check`） |
| `npm run db:local` | 套用 migration 到本機 |
| `npm run db:remote` | 套用 migration 到線上 |
| `npm run db:list` | 查看線上最近 20 筆待辦 |
| `npm run tail` | 即時查看線上日誌 |

這些 script 全部用 binding 名稱（`DB`）而不是資源名稱，所以**改資源名稱不用動 package.json**。
建立資源的兩行指令沒有做成 script，因為那時候資源還不存在、還沒有 binding 可以指 —— 名稱得自己打。

---

## 延伸練習

1. **把身分驗證做完整** —— 依上面的步驟在 Worker 裡驗 ID Token 的簽章
2. **加上編輯功能** —— `PATCH /api/todos/:id` 已經支援改 `title`，前端還沒接
3. **用 Cloudflare Images 產縮圖** —— 現在是直接回傳原圖
4. **加上分頁** —— 待辦超過一定數量時用 `LIMIT` / `OFFSET`
5. **改用 Durable Objects 做多人即時同步** —— 讓兩個瀏覽器看到同一份清單即時更新

---

## 參考資料

- [Workers 靜態資產](https://developers.cloudflare.com/workers/static-assets/)
- [D1 官方文件](https://developers.cloudflare.com/d1/)
- [R2 官方文件](https://developers.cloudflare.com/r2/)
- [Workers Builds（Git 整合）](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Google Identity Services](https://developers.google.com/identity/gsi/web/guides/overview)

各服務的免費額度與限制會調整，數字請以官方文件為準。
