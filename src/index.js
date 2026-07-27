/**
 * cf-todo-demo — 一個 Worker，四種身分
 * ---------------------------------------------------------------------------
 * 這支 Worker 同時扮演：
 *   1. 靜態網站主機   由 wrangler.jsonc 的 assets 設定處理（/、/styles.css、/app.js）
 *   2. API 伺服器     就是這個檔案，只接 /api/* 的請求
 *   3. D1 資料庫用戶端 env.DB   —— 待辦文字
 *   4. R2 物件儲存閘道 env.BUCKET —— 待辦附圖
 *
 * 讀這份檔案的順序建議：
 *   fetch()      → 進入點，決定要不要接手
 *   route()      → 路由表，一眼看完所有 API
 *   handlers     → 每個端點各做什麼
 *   createTrace()→ 頁面上那條 EDGE TRACE 的資料從哪來
 */

/** 單張圖片上限 5 MB。R2 本身可存到 5 TB，這裡是我們自己設的教學限制。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * 允許的圖片格式。副檔名由 MIME type 決定，不採用使用者上傳的原始檔名。
 *
 * 用 Map 而不是物件字面量，是因為白名單一定要「查不到就是查不到」。
 * 物件的查表會沿著原型鏈往上找，`obj['constructor']`、`obj['toString']`、
 * `obj['__proto__']` 全都會回傳 Object.prototype 上的東西 —— 對白名單來說
 * 就是「通過檢查」。上傳時只要把 Content-Type 設成 constructor 就能繞過去。
 * Map 的 get() 不碰原型鏈，天生沒有這個洞。
 */
const ALLOWED_IMAGE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
]);

/** 待辦文字長度上限。 */
const MAX_TITLE_LENGTH = 200;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // wrangler.jsonc 的 run_worker_first 設成 ["/api/*"]，
    // 所以正常情況下只有 API 請求會進到這裡。
    // 萬一設定被改動，把非 API 請求原封不動交還給靜態資產。
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const trace = createTrace(request);

    try {
      const response = await route(request, env, url, trace);
      return trace.attach(response);
    } catch (error) {
      // console.error 會進 Workers Logs，可用 `npx wrangler tail` 即時查看。
      console.error('[api] 未預期的錯誤', error);
      return trace.attach(json({ error: '伺服器發生未預期的錯誤，請看 wrangler tail 的日誌。' }, 500));
    }
  },
};

// ─── 路由表 ─────────────────────────────────────────────────────────────────

/**
 * 沒有用任何框架 —— 一個 Worker 的路由本來就可以只是幾個 if。
 * 需要更複雜的路由時才考慮 Hono 之類的函式庫。
 */
async function route(request, env, url, trace) {
  const { pathname } = url;
  const method = request.method;

  // 公開端點 1：把 Client ID 交給前端。
  // 放在 API 而不是寫死在 app.js，是為了示範 vars binding：
  // 換一個 Google 專案只要改 wrangler.jsonc，不用動前端程式碼。
  if (pathname === '/api/config') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    trace.route('GET /api/config');
    const clientId = String(env.GOOGLE_CLIENT_ID || '').trim();
    return json({ googleClientId: clientId, configured: clientId.length > 0 });
  }

  // 公開端點 2：從 R2 讀圖。
  // 必須公開，因為 <img src="..."> 沒辦法自訂 request header。
  if (pathname.startsWith('/api/images/')) {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    trace.route('GET /api/images/*');
    return serveImage(pathname.slice('/api/images/'.length), env, trace);
  }

  // 以下所有端點都需要知道「這是誰的資料」。
  const userId = readUserId(request);
  if (!userId) {
    return json({ error: '請先登入再操作待辦清單。' }, 401);
  }

  if (pathname === '/api/todos') {
    if (method === 'GET') {
      trace.route('GET /api/todos');
      return listTodos(env, userId, trace);
    }
    if (method === 'POST') {
      trace.route('POST /api/todos');
      return createTodo(request, env, userId, trace);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  // /api/todos/:id 以及 /api/todos/:id/image
  const match = pathname.match(/^\/api\/todos\/([A-Za-z0-9_-]{1,64})(\/image)?$/);
  if (match) {
    const [, todoId, imageSuffix] = match;

    if (imageSuffix) {
      if (method === 'PUT') {
        trace.route('PUT /api/todos/:id/image');
        return uploadImage(request, env, userId, todoId, trace);
      }
      if (method === 'DELETE') {
        trace.route('DELETE /api/todos/:id/image');
        return removeImage(env, userId, todoId, trace);
      }
      return methodNotAllowed(['PUT', 'DELETE']);
    }

    if (method === 'PATCH') {
      trace.route('PATCH /api/todos/:id');
      return updateTodo(request, env, userId, todoId, trace);
    }
    if (method === 'DELETE') {
      trace.route('DELETE /api/todos/:id');
      return deleteTodo(env, userId, todoId, trace);
    }
    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  return json({ error: `沒有這個 API：${method} ${pathname}` }, 404);
}

// ─── 身分 ───────────────────────────────────────────────────────────────────

/**
 * ⚠️ 教學簡化：這裡直接信任前端送來的 X-User-Id，沒有做任何驗證。
 *
 * 前端用 Google Identity Services 登入後，會解開 ID Token 取出 `sub`
 *（Google 帳號的穩定編號），再放進這個 header。但 Worker 並沒有驗證那張
 * ID Token 的簽章 —— 任何人都能用 curl 帶上別人的 X-User-Id 讀寫別人的資料。
 * 課堂 demo 沒問題，正式產品絕對不行。
 *
 * 正式做法（一樣不需要 Client Secret）：
 *   1. 前端改送 `Authorization: Bearer <ID Token>`
 *   2. Worker 取 https://www.googleapis.com/oauth2/v3/certs 的公鑰（JWKS）
 *   3. 用 crypto.subtle.importKey + crypto.subtle.verify 驗簽
 *   4. 檢查 payload 的 iss / aud / exp 三個欄位
 *   5. 全部通過，才拿 payload.sub 當 userId
 *
 * 不論驗不驗證，這個值都必須淨化 —— 它等一下會被拿去組 R2 的物件鍵。
 */
function readUserId(request) {
  const raw = request.headers.get('X-User-Id') || '';
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned || null;
}

// ─── D1：待辦的增刪查改 ─────────────────────────────────────────────────────

async function listTodos(env, userId, trace) {
  // 一律使用 prepare + bind 的預備語句。
  // 千萬不要用字串拼接把 userId 直接塞進 SQL —— 那就是 SQL injection。
  const { results } = await trace.step('D1', () =>
    env.DB.prepare(
      `SELECT id, title, done, image_key, created_at
         FROM todos
        WHERE user_id = ?
        ORDER BY created_at DESC`
    )
      .bind(userId)
      .all()
  );

  return json({ todos: results.map(toTodo) });
}

async function createTodo(request, env, userId, trace) {
  const body = await readJson(request);
  const title = typeof body.title === 'string' ? body.title.trim() : '';

  if (!title) return json({ error: '待辦內容不能是空白。' }, 400);
  if (title.length > MAX_TITLE_LENGTH) {
    return json({ error: `待辦內容最多 ${MAX_TITLE_LENGTH} 個字，目前是 ${title.length} 個。` }, 400);
  }

  const row = {
    id: crypto.randomUUID(),
    title,
    done: 0,
    image_key: null,
    created_at: new Date().toISOString(),
  };

  await trace.step('D1', () =>
    env.DB.prepare(
      `INSERT INTO todos (id, user_id, title, done, image_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(row.id, userId, row.title, row.done, row.image_key, row.created_at)
      .run()
  );

  return json({ todo: toTodo(row) }, 201);
}

async function updateTodo(request, env, userId, todoId, trace) {
  const body = await readJson(request);

  // 只組出這次真的要改的欄位。
  const assignments = [];
  const values = [];

  if (typeof body.title === 'string') {
    const title = body.title.trim();
    if (!title) return json({ error: '待辦內容不能是空白。' }, 400);
    if (title.length > MAX_TITLE_LENGTH) {
      return json({ error: `待辦內容最多 ${MAX_TITLE_LENGTH} 個字，目前是 ${title.length} 個。` }, 400);
    }
    assignments.push('title = ?');
    values.push(title);
  }

  if (typeof body.done === 'boolean') {
    assignments.push('done = ?');
    // SQLite 沒有 boolean，要自己轉成 1 / 0。
    values.push(body.done ? 1 : 0);
  }

  if (assignments.length === 0) {
    return json({ error: '沒有指定要更新的欄位（可用 title 或 done）。' }, 400);
  }

  // 注意：這裡把 assignments 字串接進 SQL 是安全的，因為 'title = ?' 和 'done = ?'
  // 都是上面寫死的常數，不含任何使用者輸入。真正的值一律走 bind()。
  //
  // RETURNING 讓 UPDATE 直接把更新後的整列還給我們，不用再 SELECT 一次。
  // 沒有更新到任何列時 .first() 回傳 null —— 代表沒有這筆，或它不屬於這個使用者。
  const updated = await trace.step('D1', () =>
    env.DB.prepare(
      `UPDATE todos SET ${assignments.join(', ')}
        WHERE id = ? AND user_id = ?
        RETURNING id, title, done, image_key, created_at`
    )
      .bind(...values, todoId, userId)
      .first()
  );

  if (!updated) {
    return json({ error: '找不到這筆待辦。' }, 404);
  }

  return json({ todo: toTodo(updated) });
}

async function deleteTodo(env, userId, todoId, trace) {
  const row = await trace.step('D1', () =>
    env.DB.prepare(`SELECT image_key FROM todos WHERE id = ? AND user_id = ?`)
      .bind(todoId, userId)
      .first()
  );

  if (!row) return json({ error: '找不到這筆待辦。' }, 404);

  // 先刪 R2 的圖，再刪 D1 的列。
  // 順序反過來的話，一旦刪 R2 失敗，那個檔案就再也沒有人記得它的 key 了。
  if (row.image_key) {
    await trace.step('R2', () => env.BUCKET.delete(row.image_key));
  }

  await trace.step('D1', () =>
    env.DB.prepare(`DELETE FROM todos WHERE id = ? AND user_id = ?`)
      .bind(todoId, userId)
      .run()
  );

  return json({ ok: true, id: todoId });
}

// ─── R2：附圖的上傳、讀取與刪除 ─────────────────────────────────────────────

async function uploadImage(request, env, userId, todoId, trace) {
  const existing = await trace.step('D1', () =>
    env.DB.prepare(`SELECT image_key FROM todos WHERE id = ? AND user_id = ?`)
      .bind(todoId, userId)
      .first()
  );

  if (!existing) return json({ error: '找不到這筆待辦。' }, 404);

  // 前端用 FormData 送檔案，Worker 直接用標準的 request.formData() 解析。
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: '請用 multipart/form-data 上傳檔案。' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return json({ error: '找不到檔案，表單欄位名稱要叫 file。' }, 400);
  }

  // 先正規化再比對。瀏覽器多半會給乾淨的小寫 MIME，但別的用戶端可能送
  // `Image/PNG` 或 `image/png; charset=utf-8`，那些也是合法的同一種格式。
  const mimeType = String(file.type || '').split(';')[0].trim().toLowerCase();
  const extension = ALLOWED_IMAGE_TYPES.get(mimeType);

  if (!extension) {
    return json(
      { error: `不支援的格式 ${file.type || '（未知）'}。可用 PNG、JPEG、WebP、GIF、AVIF。` },
      415
    );
  }

  if (file.size > MAX_IMAGE_BYTES) {
    return json(
      { error: `圖片 ${formatBytes(file.size)} 太大了，上限是 ${formatBytes(MAX_IMAGE_BYTES)}。` },
      413
    );
  }

  // R2 的物件鍵就是一個字串，斜線只是命名習慣，不是真的資料夾。
  // 開頭放 userId 方便日後用 prefix 列出某個人的所有圖片；
  // 結尾的 UUID 讓每次上傳都是新的鍵，天然避開 CDN 快取問題。
  const key = `u/${userId}/${todoId}/${crypto.randomUUID()}.${extension}`;

  // 直接把 File（也是一種 Blob）交給 R2，它的 size 是已知的。
  // 若改傳 file.stream()，R2 會因為長度未知而可能靜默截斷。
  await trace.step('R2', () =>
    env.BUCKET.put(key, file, {
      httpMetadata: {
        contentType: mimeType,
        // 鍵含 UUID、內容不會再變，可以放心讓瀏覽器永久快取。
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: { userId, todoId },
    })
  );

  // D1 只記住「指標」，圖片本體在 R2。
  //
  // 這句 UPDATE 有兩個容易被忽略的細節：
  //
  // 1. `AND image_key IS ?` 是條件更新（compare-and-swap）：只有在指標還是
  //    我們一開始讀到的值時才寫入。少了它，兩個同時進來的上傳會各自把檔案
  //    放上 R2，但只有一個寫得進 D1 —— 另一個檔案從此沒有任何地方記得它，
  //    變成永遠清不掉的孤兒。用 IS 而不是 = 是因為舊值可能是 NULL，
  //    而 SQLite 裡 `NULL = NULL` 不成立，`NULL IS NULL` 才成立。
  //
  // 2. `RETURNING` 讓一句 SQL 同時完成更新與取回。少了它就得再 SELECT 一次，
  //    而那一瞬間資料可能已經被刪掉，回來是 null。
  const updated = await trace.step('D1', () =>
    env.DB.prepare(
      `UPDATE todos SET image_key = ?
        WHERE id = ? AND user_id = ? AND image_key IS ?
        RETURNING id, title, done, image_key, created_at`
    )
      .bind(key, todoId, userId, existing.image_key)
      .first()
  );

  if (!updated) {
    // 沒更新到，代表這筆待辦剛剛被別的請求改掉或刪掉了。
    // 把我們剛放上去的檔案收回來，不要留下沒人指向的孤兒物件。
    await trace.step('R2', () => env.BUCKET.delete(key));
    return json({ error: '這筆待辦剛剛被其他操作改變了，請重新整理後再試一次。' }, 409);
  }

  // 確定贏了，現在才可以安全地刪掉被取代的舊檔案。
  if (existing.image_key) {
    await trace.step('R2', () => env.BUCKET.delete(existing.image_key));
  }

  return json({ todo: toTodo(updated) });
}

async function removeImage(env, userId, todoId, trace) {
  const row = await trace.step('D1', () =>
    env.DB.prepare(
      `SELECT id, title, done, image_key, created_at FROM todos WHERE id = ? AND user_id = ?`
    )
      .bind(todoId, userId)
      .first()
  );

  if (!row) return json({ error: '找不到這筆待辦。' }, 404);
  if (!row.image_key) return json({ error: '這筆待辦本來就沒有圖片。' }, 400);

  await trace.step('R2', () => env.BUCKET.delete(row.image_key));

  const updated = await trace.step('D1', () =>
    env.DB.prepare(
      `UPDATE todos SET image_key = NULL
        WHERE id = ? AND user_id = ?
        RETURNING id, title, done, image_key, created_at`
    )
      .bind(todoId, userId)
      .first()
  );

  if (!updated) {
    return json({ error: '找不到這筆待辦。' }, 404);
  }

  return json({ todo: toTodo(updated) });
}

/**
 * 把 R2 的物件當成一般圖片回應。
 *
 * ⚠️ 這個端點不檢查身分，因為 <img src="..."> 沒辦法帶 header。
 * 物件鍵含有隨機 UUID，猜不到也就等於猜不到別人的圖，課堂上夠用。
 * 正式環境請改成：簽章網址（有效期限）、Cookie session，或把圖片改由
 * 已驗證的 API 回傳 blob URL。
 */
async function serveImage(rawKey, env, trace) {
  let key;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    return json({ error: '圖片路徑格式錯誤。' }, 400);
  }

  // 物件鍵來自網址，一定要擋掉路徑穿越，不然使用者能撈到 bucket 裡的任何東西。
  if (!key || key.length > 512 || key.startsWith('/') || key.includes('..') || !key.startsWith('u/')) {
    return new Response('無效的圖片路徑', { status: 400 });
  }

  const object = await trace.step('R2', () => env.BUCKET.get(key));
  if (!object) return new Response('找不到這張圖片', { status: 404 });

  const headers = new Headers();
  // 把上傳時寫入的 contentType / cacheControl 等中繼資料寫回 response header。
  object.writeHttpMetadata(headers);
  // 用 httpEtag（帶引號的版本），不是 etag。
  headers.set('etag', object.httpEtag);

  return new Response(object.body, { headers });
}

// ─── EDGE TRACE：把看不見的路由變成看得見的資料 ─────────────────────────────

/**
 * 每個 API 回應都會多一個 X-Edge-Trace header，內容像這樣：
 *
 *   {"colo":"TPE","route":"POST /api/todos","chain":["WORKER","D1"],
 *    "steps":[{"name":"D1","ms":6}],"totalMs":8,"status":201}
 *
 * 前端讀到之後就渲染成首頁那條軌跡。這不是裝飾 —— 它是真的量到的數字。
 *
 * 小知識：Workers 的 Date.now() 只在發生 I/O 之後才會前進（這是防時序攻擊的
 * 設計）。所以純運算的迴圈量起來會是 0ms，而 D1 / R2 這種真的走網路的呼叫
 * 才量得到時間。這裡量的正好都是 I/O，剛好適用。
 */
function createTrace(request) {
  const startedAt = Date.now();

  const state = {
    colo: request.cf?.colo || 'LOCAL',
    route: `${request.method} ${new URL(request.url).pathname}`,
    chain: ['WORKER'],
    steps: [],
  };

  return {
    /** 用固定的路由樣板取代真實路徑，避免把 id 之類的東西寫進 header。 */
    route(pattern) {
      state.route = pattern;
    },

    /** 包住一次 D1 或 R2 呼叫，記錄它花了多久。 */
    async step(name, fn) {
      const startedStep = Date.now();
      const result = await fn();
      if (!state.chain.includes(name)) state.chain.push(name);
      state.steps.push({ name, ms: Date.now() - startedStep });
      return result;
    },

    /** 把軌跡掛上回應。Response 的 headers 是唯讀的，所以要重建一個。 */
    attach(response) {
      const headers = new Headers(response.headers);
      headers.set(
        'X-Edge-Trace',
        JSON.stringify({
          colo: state.colo,
          route: state.route,
          chain: state.chain,
          steps: state.steps,
          totalMs: Date.now() - startedAt,
          status: response.status,
        })
      );
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}

// ─── 小工具 ─────────────────────────────────────────────────────────────────

/** D1 的欄位命名是 snake_case，轉成前端習慣的 camelCase。 */
function toTodo(row) {
  return {
    id: row.id,
    title: row.title,
    done: row.done === 1,
    imageKey: row.image_key ?? null,
    imageUrl: row.image_key ? `/api/images/${row.image_key}` : null,
    createdAt: row.created_at,
  };
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function methodNotAllowed(allowed) {
  return Response.json(
    { error: `這個路徑只接受 ${allowed.join(' / ')}。` },
    { status: 405, headers: { allow: allowed.join(', '), 'cache-control': 'no-store' } }
  );
}

/** 請求主體壞掉時不要整個炸掉，交給各 handler 自己回報缺什麼欄位。 */
async function readJson(request) {
  try {
    const value = await request.json();
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
