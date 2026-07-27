-- Migration 0001：建立待辦資料表
--
-- 套用方式：
--   本機   npx wrangler d1 migrations apply todo-db --local
--   線上   npx wrangler d1 migrations apply todo-db --remote
--
-- D1 會在資料庫裡自動維護一張 d1_migrations 表，記錄哪些檔案已經跑過，
-- 所以重複執行同一個指令不會重複建表。

CREATE TABLE IF NOT EXISTS todos (
  -- crypto.randomUUID() 產生的字串，由 Worker 決定，不用資料庫自增序號。
  id         TEXT PRIMARY KEY,

  -- 資料的擁有者。目前存的是 Google 帳號的 sub（穩定不變的使用者編號）。
  user_id    TEXT NOT NULL,

  title      TEXT NOT NULL,

  -- SQLite 沒有 boolean 型別，用 0 / 1 表示。
  done       INTEGER NOT NULL DEFAULT 0,

  -- R2 物件鍵。圖片本體存在 R2，D1 只存這個「指標」。
  -- D1 單列上限 2 MB，二進位檔案一律放 R2。
  image_key  TEXT,

  -- SQLite 沒有 datetime 型別，用 ISO 8601 字串存（可直接排序）。
  created_at TEXT NOT NULL
);

-- 清單查詢固定是「某個使用者的待辦，依建立時間新到舊」，
-- 這個複合索引讓那句 SELECT 不用整表掃描。
CREATE INDEX IF NOT EXISTS idx_todos_user_created
  ON todos (user_id, created_at DESC);
