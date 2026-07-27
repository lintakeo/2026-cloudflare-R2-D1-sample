/**
 * 部署前檢查：確認 wrangler.jsonc 裡該換的值都換過了。
 *
 * 由 package.json 的 predeploy 掛勾自動執行，也可以自己跑：
 *   npm run check
 *
 * 為什麼需要這支：忘記把 database_id 換成自己的 UUID 是這個範例最常見的卡關，
 * 而 Cloudflare 回的錯誤訊息不會告訴你「你忘了改設定檔」。與其讓學員對著
 * 一句 API 錯誤發呆，不如在送出去之前就講清楚。
 *
 * 這裡刻意用純文字比對而不是解析 JSON —— wrangler.jsonc 有註解，
 * JSON.parse 會直接失敗，而我們要找的東西用字串比對就夠可靠了。
 */

import { readFileSync } from 'node:fs';

const CONFIG_URL = new URL('../wrangler.jsonc', import.meta.url);

/** 每一項：[要找的字串, 出問題時要跟學員說什麼] */
const PLACEHOLDERS = [
  [
    'PASTE_YOUR_D1_DATABASE_ID_HERE',
    [
      'wrangler.jsonc 的 database_id 還是預設的佔位字串。',
      '',
      '  1. 執行：npx wrangler d1 create todo-db',
      '  2. 把指令印出來的那串 UUID 貼進 wrangler.jsonc 的 database_id',
      '',
      '（如果資料庫已經建好了，用 npx wrangler d1 list 可以查到它的 UUID。）',
    ],
  ],
];

let config;
try {
  config = readFileSync(CONFIG_URL, 'utf8');
} catch {
  fail(['找不到 wrangler.jsonc。請確認你是在專案根目錄執行這個指令。']);
}

const problems = PLACEHOLDERS.filter(([needle]) => config.includes(needle));

if (problems.length > 0) {
  fail(problems.flatMap(([, lines]) => lines));
}

console.log('✅ 設定檢查通過，可以部署了。');

function fail(lines) {
  console.error('');
  console.error('✘ 設定還沒完成');
  console.error('');
  for (const line of lines) console.error(line ? `  ${line}` : '');
  console.error('');
  process.exit(1);
}
