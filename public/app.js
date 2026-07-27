/**
 * cf-todo-demo — 前端
 * ---------------------------------------------------------------------------
 * 三件事：
 *   1. Google 登入（只在前端進行，取得使用者的 sub 當作資料的擁有者）
 *   2. 待辦的增刪查改（呼叫 Worker 的 /api/todos，資料最後落在 D1）
 *   3. 圖片上傳與讀取（走 Worker，檔案落在 R2）
 *
 * 另外，每次呼叫 API 都會讀取回應的 X-Edge-Trace header，
 * 把 Worker 實際走過的路徑畫成首頁那條 Edge Trace。
 */

// ─── 常數 ───────────────────────────────────────────────────────────────────

const STORAGE_USER = 'cf-todo-demo:user';
const STORAGE_DEMO_ID = 'cf-todo-demo:demo-id';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

/** 綁定代號 → 畫面上顯示的名字。跟路由表的 chip 用同一套詞彙。 */
const NODE_LABEL = {
  CLIENT: '瀏覽器',
  ASSETS: '靜態資產',
  WORKER: 'Worker',
  D1: 'D1',
  R2: 'R2',
};

/** Edge Trace 最多保留幾列，以及時間條滿格對應幾毫秒。 */
const TRACE_MAX_ROWS = 8;
const TRACE_FULL_BAR_MS = 300;

// ─── 狀態 ───────────────────────────────────────────────────────────────────

const state = {
  config: { googleClientId: '', configured: false },
  /** { id, name, picture } —— id 就是 Google 帳號的 sub */
  user: null,
  todos: [],
  googleReady: false,
  /** 第一次載入完成前不要顯示「清單是空的」，不然會閃一下。 */
  loaded: false,
  /**
   * 正在等待伺服器回應的待辦 id。
   *
   * 這個狀態一定要放在這裡，不能只放在 DOM 上 —— renderTodos() 會整批重建
   * <li>，放在元素上的標記會跟著舊元素一起被丟掉。那會造成：A 正在上傳圖片時
   * 你新增了一筆待辦，重繪之後 A 的「忙碌中」就消失了，於是可以在上傳途中
   * 按下刪除。
   */
  busy: new Set(),
};

/**
 * imageKey → 一個「最後會變成 blob URL」的 Promise。
 *
 * 存 Promise 而不是存結果，是為了讓還在下載中的請求也能被共用。
 * 如果只在下載完成後才寫進快取，重繪撞上下載中的圖片就會再抓一次，
 * 多出來的那個 blob URL 沒有人記得，就永遠不會被 revoke。
 */
const imageUrls = new Map();

/** 頂欄狀態燈的還原計時器。 */
let signalTimer;

// ─── DOM ────────────────────────────────────────────────────────────────────

const el = {
  signal: document.getElementById('signal'),
  authSlot: document.getElementById('auth-slot'),
  traceList: document.getElementById('trace-list'),
  traceHint: document.getElementById('trace-hint'),
  traceColo: document.getElementById('trace-colo'),
  gate: document.getElementById('gate'),
  gateActions: document.getElementById('gate-actions'),
  workbench: document.getElementById('workbench'),
  composer: document.getElementById('composer'),
  composerInput: document.getElementById('new-todo'),
  composerSubmit: document.getElementById('composer-submit'),
  feedback: document.getElementById('feedback'),
  todos: document.getElementById('todos'),
  empty: document.getElementById('empty'),
};

// ─── 啟動 ───────────────────────────────────────────────────────────────────

async function boot() {
  seedPageLoadTrace();
  el.composer.addEventListener('submit', onComposerSubmit);

  restoreUser();

  // 先畫一次。等 Google 的元件最久要 6 秒，在那之前 Demo 區不該是一片空白，
  // 而且萬一下面出錯，畫面至少已經是可以用的狀態。
  renderAuth();

  try {
    // 這一次呼叫本身就會在 Edge Trace 多一列 —— 讓「這頁沒經過 Worker」和
    // 「這個 API 經過 Worker」的差別，在載入完成的當下就並排出現。
    state.config = await api('/api/config');

    if (state.config.configured) {
      state.googleReady = await setupGoogleSignIn();
    }
  } catch (error) {
    showFeedback(`讀不到設定：${error.message}`);
  }

  // 拿到 Client ID 之後再畫一次，把示範登入按鈕換成真正的 Google 按鈕。
  renderAuth();

  if (state.user) await loadTodos();
}

/**
 * 補上「這一頁自己」的那一列。
 *
 * 這一列是前端自己補的，因為它根本沒有經過 Worker —— run_worker_first 只包含
 * /api/*，index.html 由邊緣節點直接送出，所以沒有 X-Edge-Trace 可讀，
 * 也量不到 Worker 的耗時。這正是要讓學員看見的事。
 */
function seedPageLoadTrace() {
  addTraceRow({
    route: 'GET /',
    chain: ['ASSETS'],
    steps: [],
    totalMs: null,
    status: 200,
  });

  el.traceHint.textContent =
    '第一列是這一頁本身：路徑不符合 /api/*，由邊緣節點直接送出，Worker 沒有執行，所以沒有耗時可量。';
}

// ─── API 用戶端 ─────────────────────────────────────────────────────────────

/**
 * 所有 JSON API 都經過這裡，好處是身分、錯誤處理、Edge Trace 只寫一次。
 */
async function api(path, options = {}) {
  setSignal('busy');

  const headers = new Headers(options.headers || {});

  // ⚠️ 教學簡化：把使用者編號放在自訂 header，Worker 完全不驗證。
  // 正式做法是送 `Authorization: Bearer <ID Token>`，由 Worker 用 Google 的
  // 公鑰驗簽。src/index.js 的 readUserId() 有完整說明。
  if (state.user) headers.set('X-User-Id', state.user.id);

  // 注意：body 是 FormData 時不要自己設 Content-Type，
  // 瀏覽器要自己補上帶 boundary 的那一串才解析得了。
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    setSignal('error');
    throw new Error('連不上 Worker。本機開發請確認 npx wrangler dev 還在跑。');
  }

  recordTrace(response);

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    setSignal('error');
    throw new Error(data.error || `請求失敗（HTTP ${response.status}）`);
  }

  setSignal('ok');
  return data;
}

// ─── Edge Trace ─────────────────────────────────────────────────────────────

/** 從回應 header 取出 Worker 記錄的軌跡。同源請求才讀得到自訂 header。 */
function recordTrace(response) {
  const raw = response.headers.get('X-Edge-Trace');
  if (!raw) return;

  let trace;
  try {
    trace = JSON.parse(raw);
  } catch {
    return;
  }

  addTraceRow(trace);
  flashRoute(trace.route);
  if (trace.colo) el.traceColo.textContent = trace.colo;
}

function addTraceRow(trace) {
  const row = document.createElement('li');
  row.className = 'trace-row';
  row.dataset.fresh = 'true';
  if (trace.status >= 400) row.dataset.status = 'error';

  // 路徑：把 method 拆出來單獨上色
  const [method, ...rest] = String(trace.route || '').split(' ');
  const routeCell = document.createElement('span');
  routeCell.className = 'trace-route';
  const verb = document.createElement('span');
  verb.className = 'verb';
  verb.textContent = method;
  routeCell.append(verb, rest.join(' '));

  // 綁定鏈：Worker 說它經過了哪些東西
  const chainCell = document.createElement('span');
  chainCell.className = 'trace-chain';
  for (const node of trace.chain || []) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.node = node;
    chip.textContent = NODE_LABEL[node] || node;
    chainCell.append(chip);
  }

  // 時間條：寬度按耗時比例，顏色取最慢的那一段
  const barCell = document.createElement('span');
  barCell.className = 'trace-bar';
  if (typeof trace.totalMs === 'number') {
    const fill = document.createElement('i');
    fill.style.setProperty('--w', `${barWidth(trace.totalMs)}%`);
    fill.dataset.node = slowestNode(trace);
    barCell.append(fill);
  }

  const msCell = document.createElement('span');
  msCell.className = 'trace-ms';
  if (typeof trace.totalMs === 'number') {
    msCell.textContent = `${trace.totalMs}ms`;
  } else {
    msCell.textContent = '—';
    msCell.dataset.skipped = 'true';
    msCell.title = 'Worker 未執行，沒有可量測的時間';
  }

  row.append(routeCell, chainCell, barCell, msCell);

  // 最新的放最上面，舊的往下推，超過上限就丟掉。
  el.traceList.prepend(row);
  while (el.traceList.children.length > TRACE_MAX_ROWS) {
    el.traceList.lastElementChild.remove();
  }

  // 動畫只跑一次，跑完把標記拿掉，之後重排版才不會又閃一遍。
  setTimeout(() => row.removeAttribute('data-fresh'), 500);
}

/**
 * 時間條的寬度用對數刻度。
 *
 * 線性刻度在這裡不好用：本機開發的 D1 查詢只要 1~3ms，線上跨區存取 R2 可能
 * 150ms，同一根尺量不出前者的差異。對數刻度讓兩種量級都看得出長短，
 * 精確數字就在右邊，條只負責「哪一次比較慢」。
 */
function barWidth(ms) {
  const ratio = Math.log10(1 + Math.max(0, ms)) / Math.log10(1 + TRACE_FULL_BAR_MS);
  return Math.min(100, Math.max(8, Math.round(ratio * 100)));
}

/** 時間條的顏色代表「這次最花時間的是哪個綁定」。 */
function slowestNode(trace) {
  const steps = trace.steps || [];
  if (steps.length === 0) return 'WORKER';
  return steps.reduce((slowest, step) => (step.ms > slowest.ms ? step : slowest)).name;
}

/** 剛才那個請求對應到路由表的哪一列，就讓那一列閃一下。 */
function flashRoute(route) {
  const target = document.querySelector(`.route[data-route="${CSS.escape(route || '')}"]`);
  if (!target) return;
  target.dataset.live = 'true';
  setTimeout(() => target.removeAttribute('data-live'), 1100);
}

function setSignal(status) {
  clearTimeout(signalTimer);
  el.signal.dataset.state = status;
  if (status !== 'busy') {
    signalTimer = setTimeout(() => (el.signal.dataset.state = 'idle'), 1200);
  }
}

// ─── 登入 ───────────────────────────────────────────────────────────────────

/**
 * 等 Google Identity Services 的 script 載入完成後初始化。
 * Client ID 是在執行期跟 Worker 要的（vars binding），不是寫死在這支檔案裡。
 */
async function setupGoogleSignIn() {
  const ready = await waitFor(() => window.google?.accounts?.id, 6000);
  if (!ready) {
    showFeedback('載入不了 Google 登入元件，改用本機示範帳號也可以操作 D1 與 R2。');
    return false;
  }

  window.google.accounts.id.initialize({
    client_id: state.config.googleClientId,
    callback: onGoogleCredential,
    auto_select: false,
    cancel_on_tap_outside: true,

    // 最常見的部署錯誤：網址沒加進 Google 憑證的「已授權的 JavaScript 來源」。
    // 沒接這個 callback 的話，按下按鈕只會靜靜地什麼都沒發生，非常難查。
    error_callback: (error) => {
      if (error?.type === 'unregistered_origin') {
        showFeedback(
          `Google 不接受 ${location.origin} 這個來源。到 Google Cloud Console 的憑證設定，` +
            '把這個網址加進「已授權的 JavaScript 來源」。'
        );
        return;
      }
      showFeedback(`Google 登入沒有完成：${error?.type || '未知的錯誤'}`);
    },
  });

  return true;
}

function onGoogleCredential(response) {
  // ⚠️ 教學簡化：這裡只把 ID Token 解碼，沒有驗證簽章。
  // 前端本來就沒辦法可信地驗證自己拿到的 token —— 驗證一定要在後端做。
  const payload = decodeJwtPayload(response.credential);

  if (!payload?.sub) {
    showFeedback('讀不到 Google 回傳的帳號資訊，請重新登入。');
    return;
  }

  signIn({
    id: payload.sub,
    name: payload.name || payload.email || 'Google 使用者',
    picture: payload.picture || '',
  });
}

/**
 * 解開 JWT 的 payload（中間那一段）。
 * JWT 用的是 base64url，跟一般 base64 差在 - _ 兩個字元和沒有補 = 號。
 */
function decodeJwtPayload(token) {
  try {
    const segment = String(token).split('.')[1];
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    // 名字可能有中文，一定要用 TextDecoder 而不是直接 atob。
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Client ID 還沒設定時的替代方案，讓 D1 與 R2 的部分照樣能玩。 */
function signInWithDemoAccount() {
  let id = localStorage.getItem(STORAGE_DEMO_ID);
  if (!id) {
    id = `demo-${(crypto.randomUUID?.() || Math.random().toString(36).slice(2)).slice(0, 8)}`;
    localStorage.setItem(STORAGE_DEMO_ID, id);
  }
  signIn({ id, name: '本機示範帳號', picture: '' });
}

async function signIn(user) {
  state.user = user;
  localStorage.setItem(STORAGE_USER, JSON.stringify(user));
  clearFeedback();
  renderAuth();
  await loadTodos();
}

function signOut() {
  window.google?.accounts?.id?.disableAutoSelect?.();
  localStorage.removeItem(STORAGE_USER);
  state.user = null;
  state.todos = [];
  state.loaded = false;
  state.busy.clear();
  for (const key of [...imageUrls.keys()]) releaseImage(key);
  clearFeedback();
  renderAuth();
}

function restoreUser() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_USER) || 'null');
    if (saved?.id) state.user = saved;
  } catch {
    localStorage.removeItem(STORAGE_USER);
  }
}

// ─── 畫面：登入區 ───────────────────────────────────────────────────────────

function renderAuth() {
  el.authSlot.replaceChildren();
  el.gateActions.replaceChildren();

  if (state.user) {
    el.gate.hidden = true;
    el.workbench.hidden = false;
    el.authSlot.append(buildUserBadge());
    return;
  }

  el.gate.hidden = false;
  el.workbench.hidden = true;
  el.todos.replaceChildren();

  if (state.googleReady) {
    // 同一組設定可以渲染多顆按鈕，頂欄一顆、Demo 區一顆。
    const compact = document.createElement('div');
    el.authSlot.append(compact);
    window.google.accounts.id.renderButton(compact, {
      theme: 'filled_black', size: 'medium', shape: 'pill', text: 'signin_with', locale: 'zh_TW',
    });

    const large = document.createElement('div');
    el.gateActions.append(large);
    window.google.accounts.id.renderButton(large, {
      theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'zh_TW',
    });
    return;
  }

  // 沒有 Client ID（或載入失敗）就走示範帳號。
  el.authSlot.append(buildButton('示範登入', signInWithDemoAccount, 'btn btn-ghost'));
  el.gateActions.append(buildButton('用本機示範帳號登入', signInWithDemoAccount, 'btn btn-primary'));

  const note = document.createElement('p');
  note.className = 'gate-note';
  note.style.marginBottom = '0';
  note.textContent = state.config.configured
    ? 'Google 登入元件載入失敗，示範帳號一樣會寫進 D1 與 R2。'
    : 'wrangler.jsonc 的 GOOGLE_CLIENT_ID 還沒填，先用示範帳號體驗 D1 與 R2。';
  el.gateActions.append(note);
}

function buildUserBadge() {
  const wrap = document.createElement('div');
  wrap.className = 'user';

  if (state.user.picture) {
    const avatar = document.createElement('img');
    avatar.className = 'user-avatar';
    avatar.src = state.user.picture;
    avatar.alt = '';
    avatar.referrerPolicy = 'no-referrer';
    wrap.append(avatar);
  }

  const name = document.createElement('span');
  name.className = 'user-name';
  name.textContent = state.user.name;
  name.title = `使用者編號 ${state.user.id}`;

  wrap.append(name, buildButton('登出', signOut, 'btn btn-ghost'));
  return wrap;
}

/** action 是給重繪後找回焦點用的識別字，非待辦列的按鈕可以不給。 */
function buildButton(label, onClick, className, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  if (action) button.dataset.action = action;
  button.addEventListener('click', onClick);
  return button;
}

// ─── 待辦：資料操作 ─────────────────────────────────────────────────────────

async function loadTodos() {
  try {
    const data = await api('/api/todos');
    state.todos = data.todos;
    state.loaded = true;
    renderTodos();
  } catch (error) {
    // 載入失敗時不設 loaded，才不會誤顯示「清單是空的」—— 我們並不知道它是空的。
    showFeedback(error.message);
  }
}

async function onComposerSubmit(event) {
  event.preventDefault();

  const title = el.composerInput.value.trim();
  if (!title) return;

  el.composerSubmit.disabled = true;
  try {
    const { todo } = await api('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    state.todos.unshift(todo);
    el.composerInput.value = '';
    clearFeedback();
    renderTodos();
  } catch (error) {
    showFeedback(error.message);
  } finally {
    el.composerSubmit.disabled = false;
    el.composerInput.focus();
  }
}

async function toggleTodo(todo) {
  setRowBusy(todo.id, true);
  try {
    const data = await api(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ done: !todo.done }),
    });
    clearFeedback();
    replaceTodo(data.todo);
  } catch (error) {
    showFeedback(error.message);
  } finally {
    // 一定要在 finally 清掉。成功時也要 —— 重繪不會幫你把 state.busy 洗掉。
    setRowBusy(todo.id, false);
  }
}

async function removeTodo(todo) {
  setRowBusy(todo.id, true);
  try {
    await api(`/api/todos/${todo.id}`, { method: 'DELETE' });
    if (todo.imageKey) releaseImage(todo.imageKey);
    state.todos = state.todos.filter((item) => item.id !== todo.id);
    clearFeedback();
    renderTodos();
  } catch (error) {
    showFeedback(error.message);
  } finally {
    setRowBusy(todo.id, false);
  }
}

// ─── 待辦：圖片 ─────────────────────────────────────────────────────────────

async function uploadImage(todo, file) {
  // 兩邊都驗一次：前端擋是為了快點給回饋，後端擋才是真的防線。
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    showFeedback(`不支援的格式 ${file.type || '（未知）'}。可用 PNG、JPEG、WebP、GIF、AVIF。`);
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showFeedback(`圖片 ${formatBytes(file.size)} 太大了，上限 ${formatBytes(MAX_IMAGE_BYTES)}。`);
    return;
  }

  const form = new FormData();
  form.append('file', file);

  setRowBusy(todo.id, true);
  try {
    const data = await api(`/api/todos/${todo.id}/image`, { method: 'PUT', body: form });
    if (todo.imageKey) releaseImage(todo.imageKey);
    clearFeedback();
    replaceTodo(data.todo);
  } catch (error) {
    showFeedback(error.message);
  } finally {
    setRowBusy(todo.id, false);
  }
}

async function deleteImage(todo) {
  setRowBusy(todo.id, true);
  try {
    const data = await api(`/api/todos/${todo.id}/image`, { method: 'DELETE' });
    releaseImage(todo.imageKey);
    clearFeedback();
    replaceTodo(data.todo);
  } catch (error) {
    showFeedback(error.message);
  } finally {
    setRowBusy(todo.id, false);
  }
}

/**
 * 用 fetch 而不是直接 <img src="/api/images/…">。
 *
 * 差別在於：fetch 讀得到回應的 X-Edge-Trace header，所以「從 R2 讀圖」
 * 這件事也會出現在 Edge Trace 上。用 <img src> 的話瀏覽器不會把 header
 * 交給 JavaScript，那一段路徑就變成隱形的。
 */
function resolveImageUrl(imageKey) {
  const cached = imageUrls.get(imageKey);
  if (cached) return cached;

  // 先把 Promise 放進快取再開始等，這樣同一張圖的第二個請求會拿到同一個 Promise。
  const pending = fetch(`/api/images/${imageKey}`)
    .then(async (response) => {
      recordTrace(response);
      if (!response.ok) throw new Error('這張圖片讀不到了。');
      return URL.createObjectURL(await response.blob());
    })
    .catch((error) => {
      // 失敗的不要留在快取裡，否則之後每次重繪都只會拿到同一個失敗的 Promise。
      imageUrls.delete(imageKey);
      throw error;
    });

  imageUrls.set(imageKey, pending);
  return pending;
}

function releaseImage(imageKey) {
  const pending = imageUrls.get(imageKey);
  if (!pending) return;
  imageUrls.delete(imageKey);
  // 等它下載完才知道要 revoke 哪個 URL；已經失敗的就沒有東西要收。
  pending.then(URL.revokeObjectURL).catch(() => {});
}

// ─── 畫面：待辦清單 ─────────────────────────────────────────────────────────

function replaceTodo(updated) {
  state.todos = state.todos.map((item) => (item.id === updated.id ? updated : item));
  renderTodos();
}

function renderTodos() {
  // 整批重建 <li> 會把焦點丟回 <body>，只用鍵盤的人會瞬間迷路。
  // 先記住焦點停在哪一列的哪顆按鈕，重繪後再放回去。
  const focused = captureFocus();

  el.todos.replaceChildren(...state.todos.map(buildTodoRow));
  el.empty.hidden = !state.loaded || state.todos.length > 0;

  restoreFocus(focused);
}

function captureFocus() {
  const active = document.activeElement;
  const row = active?.closest?.('.todo');
  if (!row) return null;
  return { id: row.dataset.id, action: active.dataset.action || null };
}

/** 放回同一列的同一顆按鈕；那顆按鈕已經不在（例如剛移除圖片）就退回勾選鈕。 */
function restoreFocus(focused) {
  if (!focused) return;
  const row = el.todos.querySelector(`.todo[data-id="${CSS.escape(focused.id)}"]`);
  if (!row) return;
  const target = focused.action && row.querySelector(`[data-action="${focused.action}"]`);
  (target || row.querySelector('.todo-check'))?.focus();
}

function buildTodoRow(todo) {
  const row = document.createElement('li');
  row.className = 'todo';
  row.dataset.id = todo.id;
  row.dataset.done = String(todo.done);
  // 從 state 還原忙碌狀態，不然重繪會把其他列進行中的操作標記洗掉。
  row.dataset.busy = String(state.busy.has(todo.id));

  // 勾選
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'todo-check';
  check.dataset.action = 'toggle';
  check.textContent = '✓';
  check.setAttribute('aria-pressed', String(todo.done));
  check.setAttribute('aria-label', todo.done ? `把「${todo.title}」改回未完成` : `把「${todo.title}」標成完成`);
  check.addEventListener('click', () => toggleTodo(todo));

  // 內容 —— 一律用 textContent，不要用 innerHTML 拼使用者輸入。
  const body = document.createElement('div');
  body.className = 'todo-body';

  const title = document.createElement('p');
  title.className = 'todo-title';
  title.textContent = todo.title;

  const meta = document.createElement('p');
  meta.className = 'todo-meta';
  meta.append(buildMetaTag('D1', formatTime(todo.createdAt)));
  if (todo.imageKey) meta.append(buildMetaTag('R2', '1 個物件'));

  body.append(title, meta);

  // 操作
  const actions = document.createElement('div');
  actions.className = 'todo-actions';

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.hidden = true;
  picker.accept = ACCEPTED_IMAGE_TYPES.join(',');
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (file) uploadImage(todo, file);
  });

  actions.append(
    buildButton(todo.imageKey ? '換圖片' : '加圖片', () => picker.click(), 'btn btn-ghost', 'image'),
    picker
  );

  if (todo.imageKey) {
    actions.append(buildButton('移除圖片', () => deleteImage(todo), 'btn btn-ghost', 'image-remove'));
  }

  const remove = buildButton('刪除', () => removeTodo(todo), 'btn btn-ghost btn-danger', 'delete');
  remove.setAttribute('aria-label', `刪除「${todo.title}」`);
  actions.append(remove);

  row.append(check, body, actions);

  // 圖片（非同步載入，載好再塞進去）
  if (todo.imageKey) {
    const figure = document.createElement('figure');
    figure.className = 'todo-image';
    row.append(figure);

    resolveImageUrl(todo.imageKey)
      .then((url) => {
        const img = document.createElement('img');
        img.src = url;
        img.alt = `「${todo.title}」的附圖`;

        const caption = document.createElement('figcaption');
        caption.textContent = `r2://todo-images/${todo.imageKey}`;

        figure.replaceChildren(img, caption);
      })
      .catch((error) => showFeedback(error.message));
  }

  return row;
}

function buildMetaTag(node, text) {
  const wrap = document.createElement('span');
  wrap.dataset.node = node;
  const tag = document.createElement('b');
  tag.textContent = node;
  wrap.append(tag, ` ${text}`);
  return wrap;
}

function setRowBusy(id, busy) {
  if (busy) state.busy.add(id);
  else state.busy.delete(id);

  const row = el.todos.querySelector(`.todo[data-id="${CSS.escape(id)}"]`);
  if (row) row.dataset.busy = String(busy);
}

// ─── 提示訊息 ───────────────────────────────────────────────────────────────

function showFeedback(message, tone = 'error') {
  el.feedback.textContent = message;
  el.feedback.dataset.tone = tone;
  el.feedback.hidden = false;
}

function clearFeedback() {
  el.feedback.hidden = true;
  el.feedback.textContent = '';
}

// ─── 小工具 ─────────────────────────────────────────────────────────────────

/** 每 100ms 檢查一次條件，直到成立或逾時。用來等外部 script 載入。 */
function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-TW', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── 進入點 ─────────────────────────────────────────────────────────────────
// 放在檔案最後才呼叫。function 宣告會被提升，但 const / let 不會 ——
// 如果在檔案開頭就 boot()，它只要同步用到下面才宣告的變數就會拋
// 「Cannot access '…' before initialization」。
//
// 一定要接住錯誤：boot() 是 async，沒接的話任何例外都只會變成
// unhandled rejection 靜靜躺在 console，畫面則永遠停在空白。
boot().catch((error) => {
  console.error('[boot] 初始化失敗', error);
  showFeedback(`初始化失敗：${error.message}。開發者工具的 Console 有完整錯誤。`);
});
