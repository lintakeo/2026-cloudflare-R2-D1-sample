# CLAUDE.md

給 AI 助手的專案指南。完整的使用者教學在 `README.md`；這份檔案只講「改這個 repo 時要知道什麼」。

## 專案是什麼

`cf-todo-demo`：Cloudflare Workers + D1 + R2 的**教學範例**。一支 Worker 同時是：

1. 靜態網站主機 —— `public/` 由邊緣節點直接送出（`wrangler.jsonc` 的 `assets`）
2. API 伺服器 —— `src/index.js`，只處理 `/api/*`（`run_worker_first: ["/api/*"]`）
3. D1 用戶端 —— `env.DB`，存待辦文字
4. R2 閘道 —— `env.BUCKET`，存待辦附圖

頁面上的 **Edge Trace** 來自每個 API 回應的 `X-Edge-Trace` header（真實量測，不是示意圖）。

讀者是學員，所以**程式碼與註解本身就是教材**：可讀性、解釋「為什麼」，比精簡更重要。

## 檔案結構

```
wrangler.jsonc              所有 Cloudflare 設定（大量註解，是教材的一部分）
package.json                npm scripts；無執行期依賴，devDependency 只有 wrangler
.node-version               22（Workers Builds 也讀這個檔）
migrations/
  0001_create_todos.sql     todos 資料表 + (user_id, created_at DESC) 索引
scripts/
  apply-build-vars.mjs      Workers Builds 的組建變數 → 改寫 wrangler.jsonc（只在 WORKERS_CI=1 時動手）
  check-setup.mjs           部署前檢查 database_id 不是佔位字串
src/index.js                Worker：路由、handlers、createTrace()、小工具
public/
  index.html                單頁 landing + Demo（zh-Hant）
  app.js                    前端 ES module：Google 登入、待辦 CRUD、圖片、Edge Trace 渲染
  styles.css                深色主題；每個綁定一個固定語意色（--c-assets/--c-worker/--c-d1/--c-r2）
u/smoketest/<uuid>          空檔案，看起來是誤提交的本機測試殘留（與 R2 鍵前綴 u/ 同形），不屬於應用程式
.claude/settings.local.json 作者本機的 Claude Code 權限設定
```

沒有建置步驟、沒有框架、沒有 bundler、沒有 TypeScript、沒有測試框架或 linter。

## 常用指令

| 指令 | 用途 |
|---|---|
| `npm install` | 需要 Node ≥ 22（wrangler 4 硬性要求） |
| `npm run db:local` | 套用 migration 到本機 D1（`.wrangler/`） |
| `npm run dev` | 本機開發，http://localhost:8787 |
| `npm run check` | 檢查 `wrangler.jsonc` 的佔位值 |
| `npm run deploy` | `predeploy` → `prepare:config`（apply-build-vars + check）→ `wrangler deploy` |
| `npm run deploy:migrate` | 同上，但先 `d1 migrations apply DB --remote` |
| `npm run upload` | `wrangler versions upload`（預覽分支用，**刻意不含** migration） |
| `npm run db:remote` / `db:list` / `tail` | 線上 migration / 查最近 20 筆 / 即時日誌 |

驗證方式：沒有自動化測試。改 Worker 後用 `npm run dev` + curl 手動驗證，例如：

```bash
curl -i -X POST http://localhost:8787/api/todos \
  -H "X-User-Id: test-user" -H "Content-Type: application/json" \
  -d '{"title":"test"}'
```

改 `.mjs` 腳本可直接 `node scripts/check-setup.mjs` 測。`npm run check` 在目前的 repo 上**預期會失敗**（`database_id` 刻意保留佔位字串）。

## API

所有端點在 `/api/*`；除 `/api/config`、`/api/images/*` 外都需要 `X-User-Id` header（缺少回 401）。

| 方法 | 路徑 | handler |
|---|---|---|
| GET | `/api/config` | 回傳 `{ googleClientId, configured }` |
| GET / POST | `/api/todos` | `listTodos` / `createTodo` |
| PATCH / DELETE | `/api/todos/:id` | `updateTodo`（`title` 和/或 `done`）/ `deleteTodo` |
| PUT / DELETE | `/api/todos/:id/image` | `uploadImage`（multipart，欄位 `file`）/ `removeImage` |
| GET | `/api/images/*` | `serveImage`（公開，因為 `<img>` 無法帶 header） |

新增端點時：在 `route()` 加分支、呼叫 `trace.route('<METHOD> <樣板路徑>')`（不要把真實 id 寫進 trace），不支援的方法回 `methodNotAllowed([...])`。同步更新 README 的〈API 一覽〉。

## 程式慣例（改程式時請遵守）

**語言**
- 註解、錯誤訊息、UI 文字、文件、commit message 一律**繁體中文**（台灣用語），程式識別字用英文。
- 註解解釋「為什麼」與教學重點，常引用踩過的坑。保持現有的註解密度與 `// ─── 區塊標題 ───` 分隔風格。

**Worker（`src/index.js`）**
- 純 Workers API，不引入框架（註解明說：路由需要更複雜時才考慮 Hono）。
- 所有 SQL 用 `env.DB.prepare(...).bind(...)`，絕不字串拼接使用者輸入。唯一的例外是 `updateTodo` 拼接**寫死的** `'title = ?'` 常數。
- 每個查詢都帶 `WHERE ... AND user_id = ?`，資料以使用者隔離。
- 每次 D1 / R2 呼叫都包在 `trace.step('D1' | 'R2', () => ...)` 裡，Edge Trace 才量得到。
- 回應一律用 `json(data, status)`（附 `cache-control: no-store`）；錯誤格式是 `{ error: '中文訊息' }`。
- D1 欄位是 snake_case，經 `toTodo()` 轉成前端的 camelCase（`done` 0/1 → boolean，附 `imageUrl`）。
- 白名單用 `Map`（不用物件字面量，避免原型鏈繞過，見 `ALLOWED_IMAGE_TYPES` 的註解）。
- R2 物件鍵格式：`u/${userId}/${todoId}/${uuid}.${ext}`；副檔名由正規化後的 MIME 決定，不用使用者檔名。
- 一致性順序很重要：刪除時**先刪 R2 再刪 D1**；上傳用 `AND image_key IS ?` 的條件更新（CAS）+ `RETURNING`，輸了要把剛上傳的 R2 物件刪掉，贏了才刪舊檔。改動這些流程前先讀懂註解。
- `X-User-Id` 必須經 `readUserId()` 淨化（`[A-Za-z0-9_-]`、最長 64），因為它會組進 R2 鍵。
- `serveImage` 的路徑穿越檢查（`..`、開頭 `/`、必須以 `u/` 開頭）不可移除。

**前端（`public/`）**
- 原生 ES module，無建置。所有 API 呼叫走 `api()`（統一帶 `X-User-Id`、錯誤處理、讀 `X-Edge-Trace`）。
- 使用者輸入一律用 `textContent`，不要用 `innerHTML`。
- 忙碌狀態存在 `state.busy`（不是 DOM 上），因為 `renderTodos()` 會整批重建列表。
- 圖片用 `fetch` 取 blob URL（才讀得到 trace），快取的是 Promise；記得 `releaseImage()` revoke。
- `boot()` 放在檔案最後呼叫且必須 `.catch()`。
- localStorage 鍵前綴 `cf-todo-demo:`。
- 前後端的限制常數（5 MB、圖片 MIME 清單、標題 200 字）是重複定義的，改一邊要同步另一邊（`src/index.js`、`public/app.js`、`index.html` 的 `maxlength`）。
- CSS：顏色帶語意（每個綁定一個色），注意現有註解中的 WCAG 對比要求。

**設定與部署**
- **不要改 binding 名稱**（`DB`、`BUCKET`、`ASSETS`）：程式與 npm scripts 都依賴它們。npm scripts 用 binding 名稱而非資源名稱。
- `wrangler.jsonc` 的 `database_id` 在 repo 中**刻意保持** `PASTE_YOUR_D1_DATABASE_ID_HERE`，不要填真值。
- `wrangler.jsonc` 是帶註解的 JSONC：腳本用文字/正則處理它，不要用 `JSON.parse`。`apply-build-vars.mjs` 只替換 `"欄位": "值"` 形式，改欄位名稱或結構會讓它失敗。
- 組建變數對應：`CF_WORKER_NAME→name`、`D1_DATABASE_NAME→database_name`、`D1_DATABASE_ID→database_id`、`R2_BUCKET_NAME→bucket_name`、`GOOGLE_CLIENT_ID→vars.GOOGLE_CLIENT_ID`。新增時要同時更新 `FIELDS`、`wrangler.jsonc` 頂部註解、README 兩處表格、`index.html` 部署步驟。
- Cloudflare 後台的 Deploy / Version command 必須是 `npm run deploy` / `npm run upload`（預設的 `npx wrangler ...` 不會觸發 `predeploy`）。
- 機密不放 `vars`；`.dev.vars`、`.env*`、`.wrangler/` 已被 gitignore。
- Schema 變更：新增 `migrations/000N_*.sql`，不要改已套用的舊檔。現有 migration 都是冪等的 `IF NOT EXISTS`。

## 刻意的教學簡化（不是 bug，別「順手修掉」）

- 後端**不驗證** Google ID Token，直接信任 `X-User-Id`（`readUserId()` 註解寫了正式做法）。
- `/api/images/*` 不檢查權限，靠鍵中的隨機 UUID。
- 沒設 `GOOGLE_CLIENT_ID` 時前端提供「本機示範帳號」。

若被要求實作這些（README〈延伸練習〉也列了），保持同樣的教學註解風格，並同步更新 README 的〈⚠️ 這個範例故意簡化了什麼〉。

## 文件同步

行為改變時，通常要一起改：`README.md`（指令表、API 表、常見錯誤表）、`wrangler.jsonc` 註解、`public/index.html` 的說明文字與部署步驟。這三處重複描述了同一套設定，容易不一致。
