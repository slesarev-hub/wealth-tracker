// All arithmetic. Kept pure and free of React so it can be tested directly.
//
// The rules this module enforces, each of which v1 got wrong:
//   * a month is valued at THAT month's FX rates when they were recorded, not
//     at today's rates, so the history and the chart stop moving under the user;
//   * one missing rate degrades a single account, it does not turn every
//     aggregate into NaN;
//   * an account with no snapshot for a month keeps its last known balance
//     instead of silently counting as 0;
//   * a debt account subtracts everywhere, including in per-account deltas;
//   * an account is included in a month iff it was open in that month, and the
//     same rule is used by totals, breakdowns and the record form;
//   * the cost basis is the sum of monthly contributions up to the month, so a
//     skipped or edited month cannot reset it.

import {
  BASE_CURRENCY, HAS_PNL, balSign, isOpenAt, live, isMonth, roundAmount, isCrypto,
} from "./model.js";

// ── rates ────────────────────────────────────────────────────────────────────

// Rates are "units of X per 1 USD", the shape open.er-api.com returns.
export const ratesIndex = (data) => {
  const idx = new Map();
  for (const r of data.rates || []) {
    if (!idx.has(r.month)) idx.set(r.month, {});
    idx.get(r.month)[r.currency] = r.perUSD;
  }
  return idx;
};

// Returns the rate table to value `month` with, plus whether it came from the
// stored per-month stamp (history is reproducible) or from today's live rates
// (history still floats — the UI says so).
export const makeRatesOf = (data, liveRates) => {
  const idx = ratesIndex(data);
  const liveTable = liveRates && liveRates.rates ? liveRates.rates : liveRates || null;
  return (month) => {
    const stored = idx.get(month);
    const hasStored = stored && Object.keys(stored).length > 0;
    const table = { USD: 1, ...(liveTable || {}), ...(stored || {}) };
    return { table, stamped: !!hasStored, stampedCurrencies: new Set(Object.keys(stored || {})) };
  };
};

// True only if EVERY currency asked about is covered by that month's stored
// stamp. A month with one stamped currency is not a reproducible month.
export const stampedFor = (ratesOf, month, currencies) => {
  const { stampedCurrencies } = ratesOf(month);
  for (const c of currencies) {
    if (c === "USD") continue;
    if (!stampedCurrencies.has(c)) return false;
  }
  return true;
};

export const currenciesInMonth = (data, month, idx) => {
  const out = new Set();
  for (const { snap } of accountsInMonth(data, month, idx)) {
    out.add(snap.currency);
    if (snap.contribCurrency) out.add(snap.contribCurrency);
  }
  return out;
};

export const convert = (amount, from, to, table) => {
  if (!Number.isFinite(amount)) return NaN;
  if (from === to) return amount;
  if (!table) return NaN;
  const f = table[from];
  const t = table[to];
  if (!Number.isFinite(f) || !Number.isFinite(t) || f <= 0 || t <= 0) return NaN;
  return (amount / f) * t;
};

// ── snapshot lookup ──────────────────────────────────────────────────────────

export const snapshotIndex = (data) => {
  const byAccount = new Map();
  for (const s of live(data.snapshots || [])) {
    if (!byAccount.has(s.accountId)) byAccount.set(s.accountId, []);
    byAccount.get(s.accountId).push(s);
  }
  // Total order: an incomplete comparator makes the result depend on input order.
  for (const list of byAccount.values()) list.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  return byAccount;
};

export const monthsOf = (data) =>
  [...new Set(live(data.snapshots || []).map((s) => s.month))].sort();

export const getSnapshot = (idx, accountId, month) =>
  (idx.get(accountId) || []).find((s) => s.month === month) || null;

// The snapshot in effect for a month: the one recorded that month, or the most
// recent earlier one carried forward. v1 treated a gap as a balance of zero,
// which read as a crash in net worth.
export const effectiveSnapshot = (idx, accountId, month) => {
  const list = idx.get(accountId) || [];
  let best = null;
  for (const s of list) {
    if (s.month > month) break;
    best = s;
  }
  if (!best) return null;
  return { snap: best, carried: best.month !== month };
};

// ── totals ───────────────────────────────────────────────────────────────────

// One inclusion rule, used by every view: the account must be open in the
// month and must already have been recorded at or before it.
export const accountsInMonth = (data, month, idx) => {
  const out = [];
  for (const acc of live(data.accounts || [])) {
    if (!isOpenAt(acc, month)) continue;
    const eff = effectiveSnapshot(idx, acc.id, month);
    if (!eff) continue;
    out.push({ acc, snap: eff.snap, carried: eff.carried });
  }
  return out;
};

export const monthTotal = (data, month, toCurrency, table, idx) => {
  const rows = accountsInMonth(data, month, idx);
  let total = 0;
  const unconverted = [];
  const carried = [];
  for (const { acc, snap, carried: isCarried } of rows) {
    const v = convert(snap.balance, snap.currency, toCurrency, table);
    if (!Number.isFinite(v)) { unconverted.push(acc); continue; }
    total += v * balSign(acc);
    if (isCarried) carried.push(acc);
  }
  return { total, unconverted, carried, count: rows.length };
};

// ── cost basis and P&L ───────────────────────────────────────────────────────

// Sum of every contribution up to and including `month`. Because contributions
// are stored per month, editing or skipping one month changes only that month.
// A contribution made in another currency is converted at the rate of the month
// it was made in, never at today's rate.
export const costBasis = (data, accountId, month, idx, ratesOf) => {
  const list = (idx.get(accountId) || []).filter((s) => s.month <= month && s.contributed !== null);
  if (!list.length) return null;

  const denom = (s) => s.contribCurrency || s.currency;
  const hasCoin = list.some((s) => isCrypto(denom(s)));
  const hasFiat = list.some((s) => !isCrypto(denom(s)));

  // Prefer a fiat denomination when one exists: a cost basis is a fiat idea.
  // If the series mixes coin-denominated and fiat contributions, converting the
  // coin ones would invent a purchase price, so the basis is marked unusable
  // rather than silently fabricated.
  const fiatList = list.filter((s) => !isCrypto(denom(s)));
  const currency = denom((hasFiat ? fiatList : list)[(hasFiat ? fiatList : list).length - 1]);

  let amount = 0;
  let exact = true;
  for (const s of list) {
    const from = denom(s);
    if (from === currency) { amount += s.contributed; continue; }
    const v = convert(s.contributed, from, currency, ratesOf(s.month).table);
    // Converting at a rate that was never stamped means today's rate is being
    // applied to a past contribution: the number is an estimate, not a fact.
    if (!Number.isFinite(v) || !stampedFor(ratesOf, s.month, [from, currency])) exact = false;
    if (Number.isFinite(v)) amount += v;
  }
  return {
    amount: roundAmount(amount),
    currency,
    exact,
    basisIsCoins: hasCoin && !hasFiat,
    mixed: hasCoin && hasFiat,
  };
};

// P&L is value minus cost basis, both expressed in the basis currency. When the
// basis was recorded in coins (the v1 crypto case) this is structurally zero,
// which `meaningful` reports so the UI can ask for a real cost basis instead of
// showing a fake "+0".
export const pnlFor = (data, acc, month, idx, ratesOf) => {
  if (!HAS_PNL.has(acc.type)) return null;
  const eff = effectiveSnapshot(idx, acc.id, month);
  if (!eff) return null;
  const basis = costBasis(data, acc.id, month, idx, ratesOf);
  if (!basis) return null;
  const value = convert(eff.snap.balance, eff.snap.currency, basis.currency, ratesOf(month).table);
  if (!Number.isFinite(value)) return null;
  return {
    value: roundAmount(value),
    basis: basis.amount,
    currency: basis.currency,
    pnl: roundAmount(value - basis.amount),
    exact: basis.exact,
    // A basis recorded in coins yields a return expressed in coins: useful as
    // "how many more coins than I put in", but not a fiat return. A mixed
    // series cannot be trusted at all.
    basisIsCoins: basis.basisIsCoins,
    mixed: basis.mixed,
    meaningful: !basis.basisIsCoins && !basis.mixed,
  };
};

// ── monthly change, decomposed ───────────────────────────────────────────────

// v1 showed a single "За месяц" number and called it the month's result. It is
// really three different things added together. This splits them:
//
//   change  = total(m) - total(prev)              what the headline number was
//   fx      = the same holdings revalued          pure exchange-rate movement
//   added   = contributions recorded this month   money the user put in
//   rest    = change - fx - added                 everything else (income,
//                                                 spending, market moves)
export const monthlyChange = (data, month, prevM, toCurrency, ratesOf, idx) => {
  if (!prevM) return null;
  const rNow = ratesOf(month).table;
  const rPrev = ratesOf(prevM).table;

  const now2 = accountsInMonth(data, month, idx);
  const now = monthTotal(data, month, toCurrency, rNow, idx);
  const before = monthTotal(data, prevM, toCurrency, rPrev, idx);
  const change = now.total - before.total;

  // Revalue last month's holdings at this month's rates: the difference is the
  // part of `change` that no transaction caused. Only accounts that are still
  // present this month count — an account that closed did not "move with the
  // rate", it left, and its exit belongs in `rest`.
  const stillHere = new Set(now2.map(({ acc }) => acc.id));
  let fx = 0;
  for (const { acc, snap } of accountsInMonth(data, prevM, idx)) {
    if (!stillHere.has(acc.id)) continue;
    if (snap.currency === toCurrency) continue;
    const atNow = convert(snap.balance, snap.currency, toCurrency, rNow);
    const atPrev = convert(snap.balance, snap.currency, toCurrency, rPrev);
    if (!Number.isFinite(atNow) || !Number.isFinite(atPrev)) continue;
    fx += (atNow - atPrev) * balSign(acc);
  }

  let added = 0;
  let addedExact = true;
  for (const { acc, snap, carried } of now2) {
    if (carried || snap.contributed === null || snap.contributed === 0) continue;
    const v = convert(snap.contributed, snap.contribCurrency || snap.currency, toCurrency, rNow);
    if (!Number.isFinite(v)) { addedExact = false; continue; }
    added += v * balSign(acc);
  }

  return {
    change: roundAmount(change),
    fx: roundAmount(fx),
    added: roundAmount(added),
    rest: roundAmount(change - fx - added),
    addedExact,
    ratesStamped:
      stampedFor(ratesOf, month, currenciesInMonth(data, month, idx))
      && stampedFor(ratesOf, prevM, currenciesInMonth(data, prevM, idx)),
    unconverted: [...new Set([...now.unconverted, ...before.unconverted])],
  };
};

// Percent change. v1 divided by the previous total, which flips the sign when
// the previous total is negative and reports "0%" when it is zero.
export const percentChange = (delta, prev) => {
  if (!Number.isFinite(delta) || !Number.isFinite(prev) || prev === 0) return null;
  return (delta / Math.abs(prev)) * 100;
};

// ── per-account delta ────────────────────────────────────────────────────────

// Signed the same way the total is: a debt that grows is a negative event.
export const accountDelta = (data, acc, month, prevM, idx) => {
  if (!prevM) return null;
  const a = effectiveSnapshot(idx, acc.id, month);
  const b = effectiveSnapshot(idx, acc.id, prevM);
  if (!a || !b) return null;
  if (a.snap.currency !== b.snap.currency) return null;   // currency changed: not comparable
  return { delta: roundAmount((a.snap.balance - b.snap.balance) * balSign(acc)), currency: a.snap.currency };
};

// ── breakdowns ───────────────────────────────────────────────────────────────

// Assets and liabilities are reported separately: v1 mixed a debt into the
// denominator of the currency breakdown and omitted it from the numerator.
export const breakdown = (data, month, toCurrency, table, idx) => {
  const byCurrency = new Map();
  const byType = new Map();
  let assets = 0;
  let liabilities = 0;
  const unconverted = [];

  for (const { acc, snap } of accountsInMonth(data, month, idx)) {
    const v = convert(snap.balance, snap.currency, toCurrency, table);
    if (!Number.isFinite(v)) { unconverted.push(acc); continue; }
    const signed = v * balSign(acc);
    if (balSign(acc) < 0) liabilities += v; else assets += v;

    if (balSign(acc) > 0) {
      if (!byCurrency.has(snap.currency)) byCurrency.set(snap.currency, { native: 0, converted: 0 });
      const c = byCurrency.get(snap.currency);
      c.native = roundAmount(c.native + snap.balance);
      c.converted += v;
    }
    if (!byType.has(acc.type)) byType.set(acc.type, { converted: 0 });
    byType.get(acc.type).converted += signed;
  }
  return {
    byCurrency: [...byCurrency.entries()].map(([currency, v]) => ({ currency, ...v, converted: roundAmount(v.converted) }))
      .sort((a, b) => b.converted - a.converted),
    byType: [...byType.entries()].map(([type, v]) => ({ type, converted: roundAmount(v.converted) }))
      .sort((a, b) => b.converted - a.converted),
    assets: roundAmount(assets),
    liabilities: roundAmount(liabilities),
    net: roundAmount(assets - liabilities),
    unconverted,
  };
};

// ── recording ────────────────────────────────────────────────────────────────

// Which accounts the record form should offer for a given month: exactly those
// open in that month. v1 offered "not closed today", so a closed account could
// never be zeroed and a past month could not be backfilled.
export const accountsForMonth = (data, month) =>
  live(data.accounts || []).filter((acc) => isOpenAt(acc, month));

// What the "внесено за месяц" box should show when opening the form.
export const contributionFor = (idx, accountId, month) => {
  const s = getSnapshot(idx, accountId, month);
  if (!s || s.contributed === null) return "";
  return String(s.contributed);
};

export const isMonthValid = isMonth;
