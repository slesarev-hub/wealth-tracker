// Composition of the portfolio for one month, in a shape a part-to-whole chart
// can render directly.
//
// Two rules drive the design, both from the visualisation guidance:
//
//  * At most THREE coloured categories plus a neutral "остальное". A ring
//    cannot promise which hues end up touching: a category missing from the
//    displayed month closes the gap, so ANY two slots can become neighbours.
//    That makes the all-pairs check the binding one, and it fails from four
//    hues up (orange vs yellow, ΔE 10.6 for normal vision; magenta vs green,
//    ΔE 1.6 for deuteranopia). Three hues plus the neutral pass it: worst pair
//    ΔE 9.4 under deuteranopia, 16.0 for normal vision, on surface #111320.
//    The ranked list below each ring carries every category by name, so nothing
//    is lost by folding the tail — only the glance is simplified.
//
//  * Colour follows the ENTITY, never its rank. Slots are assigned from each
//    category's total across ALL months, so switching the displayed month never
//    repaints a slice — the reader keeps their bearings.
//
// Liabilities are never slices: a share of a whole cannot be negative. Debts are
// returned separately for the caller to show as their own figure.

import { ACCOUNT_TYPES, balSign, roundAmount } from "./model.js";
import { accountsInMonth, convert, monthsOf } from "./calc.js";

export const MAX_SLICES = 3;
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
    // A negative balance on an asset account is a liability in everything but
    // its label. Counting it as a slice would produce a negative share and push
    // the others above 100%.
    if (balSign(acc) < 0 || v < 0) { liabilities += Math.abs(v); continue; }
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
  if (rest.length === 1) {
    // One leftover keeps its own identity — and its own fields, so a currency
    // folded out of the ring still shows how much of it there is.
    const only = rest[0];
    slices.push({
      ...only, key: OTHER_KEY, ofKey: only.key, slot: null,
      label: label(only.key),
      share: total > 0 ? only.value / total : 0,
    });
  } else if (rest.length > 1) {
    const sum = rest.reduce((s, e) => s + e.value, 0);
    slices.push({
      key: OTHER_KEY, slot: null,
      label: `Остальное · ${rest.length}`,
      value: roundAmount(sum),
      share: total > 0 ? sum / total : 0,
      members: rest
        .map((e) => ({ ...e, label: label(e.key), share: total > 0 ? e.value / total : 0 }))
        .sort((a, b) => b.value - a.value),
    });
  }
  return slices;
};

export const structureFor = (data, month, toCurrency, ratesOf, idx) => {
  const s = sumsFor(data, month, toCurrency, ratesOf(month).table, idx);
  // 20 accounts share 13 names here, so a bare name would put "Газпромбанк"
  // both in the ring and inside "Остальное", each showing a different amount.
  const counts = new Map();
  for (const a of data.accounts) counts.set(a.name, (counts.get(a.name) || 0) + 1);
  const nameOf = (id) => {
    const a = data.accounts.find((x) => x.id === id);
    if (!a) return id;
    if ((counts.get(a.name) || 0) < 2) return a.name;
    const t = ACCOUNT_TYPES.find((x) => x.id === a.type)?.label || a.type;
    return `${a.name} · ${t}${a.currency === toCurrency ? "" : " " + a.currency}`;
  };
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
    // Ungrouped and ranked. Twenty accounts is not a part-to-whole-at-a-glance
    // set — a ring capped at three hues would be 58% "остальное" — so this is
    // rendered as ranked bars, where the count carries no colour constraint.
    accountRows: [...s.byAccount.entries()]
      .map(([key, value]) => ({
        key, value: roundAmount(value), icon: iconOf(key), label: nameOf(key),
        share: s.assets > 0 ? value / s.assets : 0,
      }))
      .sort((a, b) => b.value - a.value),
  };
};
