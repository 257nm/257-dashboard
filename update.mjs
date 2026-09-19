// Fetches prices and maintains the 09:00 KST history.
//
// - data/latest.json  : current prices (rebuilt on every run, NOT committed)
// - data/history.json : one row per day at 09:00 KST (committed by the workflow)
//
// Upbit daily candles start at 09:00 KST (= 00:00 UTC), so a candle's opening
// price IS the 09:00 KST price. Using it means the record is exact even when
// GitHub delays the scheduled run by 10-30 minutes.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const UPBIT = "https://api.upbit.com/v1";
const FX_URL = "https://open.er-api.com/v6/latest/USD";
const FX_LABEL = "USD/KRW";

// [display label, Upbit market code]
const MARKETS = [
  ["BTC/KRW", "KRW-BTC"],
  ["BTC/USDT", "USDT-BTC"],
  ["XRP/KRW", "KRW-XRP"],
  ["XRP/USDT", "USDT-XRP"],
  ["USDT/KRW", "KRW-USDT"],
];

const HISTORY_FILE = "data/history.json";
const LATEST_FILE = "data/latest.json";
const MAX_BACKFILL = 200; // Upbit returns at most 200 candles per request
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      lastError = e;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastError;
}

async function readHistory() {
  try {
    const parsed = JSON.parse(await readFile(HISTORY_FILE, "utf8"));
    return Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch (e) {
    if (e.code === "ENOENT") return []; // first run
    throw e; // corrupt file: stop instead of overwriting it
  }
}

async function main() {
  await mkdir("data", { recursive: true });

  const now = new Date();
  const today = now.toISOString().slice(0, 10); // UTC date == 09:00 KST trading day

  const rows = await readHistory();
  const byDate = new Map(rows.map((r) => [r.date, r]));

  // How many daily candles to request: full backfill on the first run,
  // otherwise just enough to cover any days the workflow missed.
  let count = MAX_BACKFILL;
  if (rows.length) {
    const lastDate = rows.map((r) => r.date).sort().pop();
    const gapDays = Math.ceil((Date.parse(today) - Date.parse(lastDate)) / DAY_MS);
    count = Math.min(MAX_BACKFILL, Math.max(3, gapDays + 2));
  }

  // 1) 09:00 KST values = opening price of each daily candle
  await Promise.all(
    MARKETS.map(async ([label, market]) => {
      try {
        const candles = await getJson(`${UPBIT}/candles/days?market=${market}&count=${count}`);
        for (const c of candles) {
          const date = c.candle_date_time_kst.slice(0, 10);
          const row = byDate.get(date) ?? { date };
          row[label] = c.opening_price;
          byDate.set(date, row);
        }
      } catch (e) {
        console.warn(`candles ${label}: ${e.message}`);
      }
    })
  );

  // 2) Current prices
  const tickers = await Promise.all(
    MARKETS.map(async ([label, market]) => {
      try {
        const [t] = await getJson(`${UPBIT}/ticker?markets=${market}`);
        return { label, price: t.trade_price, unit: market.split("-")[0] };
      } catch (e) {
        console.warn(`ticker ${label}: ${e.message}`);
        return null;
      }
    })
  );
  const items = tickers.filter(Boolean);
  if (items.length === 0) throw new Error("No ticker data could be fetched.");

  // 3) USD/KRW. The source updates about once a day and has no history API,
  // so today's row gets the first value seen on or after 09:00 KST.
  try {
    const fx = (await getJson(FX_URL))?.rates?.KRW;
    if (typeof fx === "number") {
      items.push({ label: FX_LABEL, price: fx, unit: "KRW", daily: true });
      const todayRow = byDate.get(today);
      if (todayRow && todayRow[FX_LABEL] == null) todayRow[FX_LABEL] = fx;
    }
  } catch (e) {
    console.warn(`fx: ${e.message}`);
  }

  // 4) Write files (fixed column order keeps git diffs small)
  const ORDER = [...MARKETS.map((m) => m[0]), FX_LABEL];
  const out = [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => {
      const o = { date: r.date };
      for (const k of ORDER) if (r[k] != null) o[k] = r[k];
      return o;
    });

  const historyText =
    '{\n  "rows": [\n' + out.map((r) => "    " + JSON.stringify(r)).join(",\n") + "\n  ]\n}\n";
  await writeFile(HISTORY_FILE, historyText);
  await writeFile(LATEST_FILE, JSON.stringify({ updated: now.toISOString(), items }, null, 2) + "\n");

  console.log(`history rows: ${out.length}, live items: ${items.length}, candles requested: ${count}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
