/**
 * 把 Workers Builds 的「組建變數和秘密」寫進 wrangler.jsonc。
 *
 * 為什麼需要這支
 * ---------------------------------------------------------------------------
 * 綁定（d1_databases、r2_buckets）是 `wrangler deploy` 在**部署時**讀設定檔決定的，
 * 而 wrangler.jsonc 不支援 `${VAR}` 這種插值，wrangler CLI 也沒有覆寫 D1 / R2
 * 綁定的旗標（`--var` 只管執行時的 vars）。所以組建變數不會自己生效 ——
 * 得由建置流程自己把值填進設定檔，也就是這支腳本做的事。
 *
 * 安全性
 * ---------------------------------------------------------------------------
 * 只有在 Workers Builds 的環境（WORKERS_CI=1）才會動檔案。那裡的原始碼是每次
 * 建置重新 checkout 的暫時副本，改它不會影響你的 repo。在自己電腦上執行時
 * 這支腳本什麼都不做，不會偷偷改掉你的 wrangler.jsonc。
 *
 * 怎麼用
 * ---------------------------------------------------------------------------
 * Cloudflare 後台 → 你的 Worker → Settings → Build →「Build variables and secrets」
 * 新增底下 FIELDS 列出的任何一個變數即可。沒設的就沿用設定檔裡原本的值。
 *
 * 想在本機試跑：WORKERS_CI=1 D1_DATABASE_ID=xxx npm run deploy
 * （記得跑完把 wrangler.jsonc 改回來）
 */

import { readFileSync, writeFileSync } from 'node:fs';

const CONFIG_URL = new URL('../wrangler.jsonc', import.meta.url);

/**
 * 組建變數名稱 → wrangler.jsonc 裡的欄位名稱
 *
 * GOOGLE_CLIENT_ID 比較特別：它是 vars 區塊裡的執行時變數，本來就可以改用
 * 後台的 Variables and Secrets 設定。但只要 wrangler.jsonc 的 vars 還留著同名
 * 的鍵，每次部署都會用設定檔的值覆蓋掉後台設的（wrangler 預設會先清空 vars
 * 再套用設定檔裡的，除非加 --keep-vars）。從這裡注入就不會有那個問題。
 */
const FIELDS = {
  CF_WORKER_NAME: 'name',
  D1_DATABASE_NAME: 'database_name',
  D1_DATABASE_ID: 'database_id',
  R2_BUCKET_NAME: 'bucket_name',
  GOOGLE_CLIENT_ID: 'GOOGLE_CLIENT_ID',
};

const requested = Object.entries(FIELDS).filter(([envName]) => process.env[envName]);

if (requested.length === 0) {
  // 沒設也是正常情況，但順便把可用的名稱印出來 —— 需要它的時候人通常
  // 正在看部署輸出，而不是在翻 README。
  console.log('· 沒有設定任何組建變數，沿用 wrangler.jsonc 原本的值。');
  console.log('  可用的組建變數（Cloudflare 後台 → Settings → Build → Build variables and secrets）：');
  for (const [envName, field] of Object.entries(FIELDS)) {
    console.log(`      ${envName.padEnd(18)}→ 覆寫 wrangler.jsonc 的 ${field}`);
  }
  process.exit(0);
}

if (!process.env.WORKERS_CI) {
  console.error('');
  console.error('✘ 偵測到組建變數，但目前不在 Workers Builds 環境。');
  console.error('');
  console.error('  這支腳本會改寫 wrangler.jsonc，只該在建置容器裡執行。');
  console.error('  想在本機測試請明確加上 WORKERS_CI=1，並記得事後還原檔案。');
  console.error('');
  process.exit(1);
}

let config = readFileSync(CONFIG_URL, 'utf8');
const applied = [];

for (const [envName, field] of requested) {
  const value = process.env[envName];

  // 只替換 `"欄位": "值"` 這種形式的「值」。註解裡出現的同名文字不會被動到，
  // 因為那裡沒有引號加冒號的結構。
  const pattern = new RegExp(`("${field}"\\s*:\\s*)"[^"]*"`, 'g');
  const matches = config.match(pattern);

  if (!matches) {
    console.error(`✘ 設定了 ${envName}，但 wrangler.jsonc 裡找不到 "${field}" 欄位。`);
    console.error('  設定檔的結構可能被改過了，請確認欄位名稱。');
    process.exit(1);
  }

  config = config.replace(pattern, `$1${JSON.stringify(value)}`);
  applied.push(`${field.padEnd(14)} ← ${envName}${matches.length > 1 ? ` （${matches.length} 處）` : ''}`);
}

writeFileSync(CONFIG_URL, config);

console.log('· 已套用組建變數到 wrangler.jsonc：');
for (const line of applied) console.log(`    ${line}`);
