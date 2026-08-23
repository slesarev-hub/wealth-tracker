// Composition of the portfolio for one month, in a shape a part-to-whole chart
// can render directly.
//
// Two rules drive the design, both from the visualisation guidance:
//
//  * At most FIVE coloured categories plus a neutral "остальное". The
//    categorical palette's documented slot order clears every separation check
//    for five adjacent pairs AND for the ring's wrap-around pair (magenta ->
//    blue). A sixth hue (violet) fails that wrap badly: ΔE 1.9 for protanopia
//    and 9.8 for normal vision, i.e. two touching slices nobody can tell apart.
//
//  * Colour follows the ENTITY, never its rank. Slots are assigned from each
//    category's total across ALL months, so switching the displayed month never
//    repaints a slice — the reader keeps their bearings.
//
// Liabilities are never slices: a share of a whole cannot be negative. Debts are
// returned separately for the caller to show as their own figure.

import { ACCOUNT_TYPES, balSign, roundAmount } from "./model.js";
import { accountsInMonth, convert, monthsOf } from "./calc.js";

export const MAX_SLICES = 5;
export const OTHER_KEY = "__other__";

const typeLabel = (t) => ACCOUNT_TYPES.find((x) => x.id === t)?.label || t;
const typeIcon = (t) => ACCOUNT_TYPES.find((x) => x.id === t)?.icon || "🗂️";

// Sums the asset side of one month, grouped three ways. Debts are excluded from
// every grouping and reported on their own.
const sumsFor = (data, month, toCurrency, table, idx) => {
  const byCurrency = new Map();
  const byType = new Map();
  const byAccount = new Map();
  let assets = 0;
  let liabilities = 0;
  const unconverted = [];

  for (const { acc, snap } of accountsInMonth(data, month, idx)) {
    const v = convert(snap.balance, snap.currency, toCurrency, table);
    if (!Number.isFinite(v)) { unconverted.push(acc); continue; }
    if (balSign(acc) < 0) { liabilities += v; continue; }
    assets += v;

    const cur = byCurrency.get(snap.currency) || { native: 0, value: 0 };
    cur.native = roundAmount(cur.native + snap.balance);
    cur.value += v;
    byCurrency.set(snap.currency, cur);

    byType.set(acc.type, (byType.get(acc.type) || 0) + v);
    byAccount.set(acc.id, (byAccount.get(acc.id) || 0) + v);
  }
  return { byCurrency, byType, byAccount, assets, liabilities, unconverted };
};

// The ranking every month is coloured by: each key's total over the whole
// history, so the mapping is stable while the month filter moves.
const stableOrder = (data, toCurrency, ratesOf, idx, pick) => {
  const totals = new Map();
  for (const m of monthsOf(data)) {
    const s = sumsFor(data, m, toCurrency, ratesOf(m).table, idx);
    for (const [key, value] of pick(s)) totals.set(key, (totals.get(key) || 0) + value);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([key]) => key);
};

// Keeps the top MAX_SLICES by the stable order and folds the tail into one
// neutral slice, so the ring never needs a sixth hue.
const toSlices = (entries, order, label, total) => {
  const rank = new Map(order.map((k, i) => [k, i]));
  const sorted = [...entries].sort(
    (a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9)
  );
  const kept = sorted.filter((e) => (rank.get(e.key) ?? 1e9) < MAX_SLICES);
  const rest = sorted.filter((e) => (rank.get(e.key) ?? 1e9) >= MAX_SLICES);

  const slices = kept.map((e) => ({
    ...e,
    slot: rank.get(e.key),
    label: label(e.key),
    share: total > 0 ? e.value / total : 0,
  }));
  if (rest.length) {
    slices.push({
      key: OTHER_KEY,
      slot: null,
      label: rest.length === 1 ? label(rest[0].key) : `Остальное · ${rest.length}`,
      value: roundAmount(rest.reduce((s, e) => s + e.value, 0)),
      share: total > 0 ? rest.reduce((s, e) => s + e.value, 0) / total : 0,
      members: rest.map((e) => ({ ...e, label: label(e.key), share: total > 0 ? e.value / total : 0 })),
    });
  }
  return slices;
};

export const structureFor = (data, month, toCurrency, ratesOf, idx) => {
  const s = sumsFor(data, month, toCurrency, ratesOf(month).table, idx);
  const nameOf = (id) => data.accounts.find((a) => a.id === id)?.name || id;
  const iconOf = (id) => typeIcon(data.accounts.find((a) => a.id === id)?.type);

  const curOrder = stableOrder(data, toCurrency, ratesOf, idx,
    (x) => [...x.byCurrency.entries()].map(([k, v]) => [k, v.value]));
  const typeOrder = stableOrder(data, toCurrency, ratesOf, idx,
    (x) => [...x.byType.entries()]);
  const accOrder = stableOrder(data, toCurrency, ratesOf, idx,
    (x) => [...x.byAccount.entries()]);

  return {
    month,
    assets: roundAmount(s.assets),
    liabilities: roundAmount(s.liabilities),
    net: roundAmount(s.assets - s.liabilities),
    unconverted: s.unconverted,
    byCurrency: toSlices(
      [...s.byCurrency.entries()].map(([key, v]) => ({ key, value: roundAmount(v.value), native: v.native })),
      curOrder, (k) => k, s.assets
    ),
    byType: toSlices(
      [...s.byType.entries()].map(([key, value]) => ({ key, value: roundAmount(value) })),
      typeOrder, typeLabel, s.assets
    ),
    byAccount: toSlices(
      [...s.byAccount.entries()].map(([key, value]) => ({ key, value: roundAmount(value), icon: iconOf(key) })),
      accOrder, nameOf, s.assets
    ),
  };
};
