// Historical coin prices, used only to estimate a cost basis that was never
// recorded in money. CoinGecko's history endpoint returns the price directly in
// roubles for a given date, so no separate USD/RUB history is needed.
import { CRYPTO_IDS, isMonth } from "./model.js";

const HOST = "https://api.coingecko.com/api/v3";

// Mid-month is the least arbitrary single day to stand for "that month": the
// 1st and the 15th of one month can differ by more than 10%.
export const monthToDate = (month) => {
  if (!isMonth(month)) return null;
  const [y, m] = month.split("-");
  return `15-${m}-${y}`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns roubles per one coin, or null. CoinGecko's free tier answers 429
// readily, so a throttled call is retried rather than reported as a failure.
export const fetchCoinPriceRub = async (currency, month, { fetchImpl = fetch, retries = 3 } = {}) => {
  const id = CRYPTO_IDS[currency];
  const date = monthToDate(month);
  if (!id || !date) return null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let r;
    try {
      r = await fetchImpl(`${HOST}/coins/${id}/history?date=${date}&localization=false`);
    } catch { return null; }
    if (r.status === 429 || r.status >= 500) {
      if (attempt === retries) return null;
      await sleep(1200 * (attempt + 1));
      continue;
    }
    if (!r.ok) return null;
    let j;
    try { j = await r.json(); } catch { return null; }
    const v = j?.market_data?.current_price?.rub;
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  return null;
};

// Fetches every (month, currency) pair a basis estimate needs, sequentially so
// the free tier is not hammered. Returns a lookup for estimateCoinBasis.
export const fetchPriceTable = async (pairs, opts = {}) => {
  const table = new Map();
  for (const { month, currency } of pairs) {
    const key = `${month}|${currency}`;
    if (table.has(key)) continue;
    table.set(key, await fetchCoinPriceRub(currency, month, opts));
  }
  return (month, currency) => table.get(`${month}|${currency}`) ?? null;
};
