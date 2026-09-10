// scripts/fetch-hive.js
// 定時抓取 Hive 玩家活動，用時間去重，只保留新對局

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(ROOT, 'config', 'players.json');

const MAX_GAMES_PER_PLAYER = 5000; // 每個玩家最多保留幾筆對局
const REQUEST_DELAY_MS = 1000;     // 每次請求之間的延遲

// ========== 工具 ==========
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'HivePlayerActivity-Tracker/1.0' },
      });
      if (res.status === 429) {
        const wait = 5000 * (i + 1);
        console.log(`  429 rate limited, waiting ${wait}ms...`);
        await sleep(wait);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      console.log(`  retry ${i + 1}/${retries} after error: ${e.message}`);
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error('Max retries reached');
}

// 從一筆 activity 取出可作為唯一 key 的時間戳
function getActivityKey(activity) {
  if (!activity || typeof activity !== 'object') return null;
  const candidates = [
    activity.timestamp,
    activity.time,
    activity.date,
    activity.createdAt,
    activity.updatedAt,
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') {
      return String(c);
    }
  }
  return 'raw:' + JSON.stringify(activity);
}

function parseTime(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    return value < 1e10 ? value * 1000 : value;
  }
  const s = String(value).trim();
  const num = Number(s);
  if (!isNaN(num)) return num < 1e10 ? num * 1000 : num;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// 抓一位玩家的資料
async function trackPlayer(uuid, nowIso, customName = null) {
  console.log(`\n=== ${uuid} ===`);

  // 1. 玩家基本資料
  let playerInfo = null;
  try {
    playerInfo = await fetchJson(
      `https://api.playhive.com/v0/game/all/main/${uuid}`
    );
  } catch (e) {
    console.warn(`  playerInfo failed: ${e.message}`);
  }
  await sleep(REQUEST_DELAY_MS);

  // 2. 活動記錄
  let activityResponse = null;
  try {
    activityResponse = await fetchJson(
      `https://api.playhive.com/v0/player/activity/${uuid}`
    );
  } catch (e) {
    console.warn(`  activity failed: ${e.message}`);
  }

  // 3. 讀取現有檔案
  const file = path.join(DATA_DIR, `${uuid}.json`);
  let store = {
    uuid,
    createdAt: nowIso,
    lastUpdated: nowIso,
    playerInfo: null,
    games: [],
    snapshots: [],
  };
  if (fs.existsSync(file)) {
    try {
      store = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(store.games)) store.games = [];
      if (!Array.isArray(store.snapshots)) store.snapshots = [];
    } catch (e) {
      console.warn(`  failed to parse existing file, starting fresh`);
    }
  }

  // 4. 更新玩家基本資料
  if (playerInfo) {
    store.playerInfo = {
      ...store.playerInfo,
      ...playerInfo,
      fetchedAt: nowIso,
    };
  }
  // 把自訂名字存進去（優先於 API 回傳的名字）
  if (customName) {
    store.customName = customName;
  }

  // 5. 去重合併新對局
  const newActivities = Array.isArray(activityResponse)
    ? activityResponse
    : (activityResponse?.data || activityResponse?.activities || []);

  const knownKeys = new Set(store.games.map(g => getActivityKey(g)).filter(Boolean));
  let added = 0;
  for (const act of newActivities) {
    const key = getActivityKey(act);
    if (!key || knownKeys.has(key)) continue;
    knownKeys.add(key);
    store.games.push(act);
    added++;
  }

  // 6. 依時間排序（舊→新）
  store.games.sort((a, b) => {
    const ta = parseTime(getActivityKey(a));
    const tb = parseTime(getActivityKey(b));
    if (!ta && !tb) return 0;
    if (!ta) return -1;
    if (!tb) return 1;
    return ta - tb;
  });

  // 7. 超過上限就裁掉最舊的
  if (store.games.length > MAX_GAMES_PER_PLAYER) {
    store.games = store.games.slice(-MAX_GAMES_PER_PLAYER);
  }

  // 8. 記錄快照（趨勢圖用）
  const victories = store.games.filter(g => g.victory === true).length;
  store.snapshots.push({
    timestamp: nowIso,
    totalGames: store.games.length,
    victories,
    winRate: store.games.length ? +(victories / store.games.length * 100).toFixed(2) : 0,
    newGames: added,
  });
  if (store.snapshots.length > 20000) {
    store.snapshots = store.snapshots.slice(-20000);
  }

  store.lastUpdated = nowIso;

  // 9. 寫入
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
  console.log(`  total games: ${store.games.length} (+${added} new)`);
  console.log(`  win rate: ${store.snapshots[store.snapshots.length - 1].winRate}%`);
}

// ========== 主流程 ==========
(async () => {
  const nowIso = new Date().toISOString();

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`Missing config: ${CONFIG_FILE}`);
    process.exit(1);
  }
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const rawPlayers = config.players || [];

  // 兼容兩種格式：字串 或 {uuid, name}
  const players = rawPlayers
    .map(p => typeof p === 'string' ? { uuid: p, name: null } : p)
    .filter(p => p && p.uuid);

  console.log(`Tracking ${players.length} players at ${nowIso}`);

  for (const p of players) {
    try {
      await trackPlayer(p.uuid, nowIso, p.name);
    } catch (e) {
      console.error(`Failed ${p.uuid}: ${e.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log('\nDone.');
})();
