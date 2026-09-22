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
  ["ETH/KRW", "KRW-ETH"],
  ["ETH/USDT", "USDT-ETH"],
  ["XRP/KRW", "KRW-XRP"],
  ["XRP/USDT", "USDT-XRP"],
  ["USDT/KRW", "KRW-USDT"],
];

const HISTORY_FILE = "data/history.json";
const LATEST_FILE = "data/latest.json";
const MAX_BACKFILL = 200; // Upbit returns at most 200 candles per request
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQUEST_TIMEOUT_MS = 15_000; // a hung upstream request must not stall the whole run

async function getJson(url, tries = 3) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const body = await res.json();
      return body;
    } catch (e) {
      lastError = e.name === "AbortError" ? new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms for ${url}`) : e;
      await sleep(1000 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

// A number we're willing to write into the committed history/latest files.
// Guards against a malformed or unexpected upstream response (wrong type,
// null, NaN, a negative/zero price, Infinity) silently corrupting the data
// files that the front-end trusts and renders without further validation.
const isFinitePositive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

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

  // How many daily candles to request, per market: a full backfill for a market
  // that has no history yet (e.g. a newly added coin), otherwise just enough to
  // cover any days the workflow missed.
  const lastDateFor = (label) => {
    let last = null;
    for (const r of byDate.values()) if (r[label] != null && (!last || r.date > last)) last = r.date;
    return last;
  };

  // 1) 09:00 KST values = opening price of each daily candle
  const counts = [];
  await Promise.all(
    MARKETS.map(async ([label, market]) => {
      let count = MAX_BACKFILL;
      const last = lastDateFor(label);
      if (last) {
        const gapDays = Math.ceil((Date.parse(today) - Date.parse(last)) / DAY_MS);
        count = Math.min(MAX_BACKFILL, Math.max(3, gapDays + 2));
      }
      counts.push(`${label}:${count}`);
      try {
        const candles = await getJson(`${UPBIT}/candles/days?market=${market}&count=${count}`);
        if (!Array.isArray(candles)) throw new Error("unexpected response shape (not an array)");
        for (const c of candles) {
          const date = typeof c?.candle_date_time_kst === "string" ? c.candle_date_time_kst.slice(0, 10) : null;
          if (!date || !isFinitePositive(c.opening_price)) {
            console.warn(`candles ${label}: skipping malformed row ${JSON.stringify(c)}`);
            continue;
          }
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
        const body = await getJson(`${UPBIT}/ticker?markets=${market}`);
        const t = Array.isArray(body) ? body[0] : null;
        if (!isFinitePositive(t?.trade_price)) throw new Error("unexpected or missing trade_price");
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
    if (isFinitePositive(fx)) {
      items.push({ label: FX_LABEL, price: fx, unit: "KRW", daily: true });
      const todayRow = byDate.get(today);
      if (todayRow && todayRow[FX_LABEL] == null) todayRow[FX_LABEL] = fx;
    } else {
      console.warn(`fx: unexpected or missing rate in response`);
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

  console.log(`history rows: ${out.length}, live items: ${items.length}, candles requested: ${counts.join(" ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
