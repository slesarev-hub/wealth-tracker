// Return series for an instrument (an account with a cost basis) or for the
// whole investment portfolio, plus a "what if the same money went into a bank
// deposit" benchmark. Pure, no React, tested in test/returns.test.mjs.
//
// Rules:
//   * the monthly return is Modified Dietz with the month's contribution
//     weighted at mid-month: r = (V - V_prev - F) / (V_prev + F/2). It is a
//     time-weighted figure, so it can be compared with a deposit rate, unlike
//     the raw P&L which depends on when the money arrived;
//   * the series starts at the instrument's first recorded month (index = 1);
//     the first month has no return because there is no earlier value to
//     measure it from — treating the missing value as 0 is the v1 mistake
//     calc.js documents;
//   * the deposit benchmark starts from the same opening value, receives the
//     same contributions (also mid-month) and compounds monthly at a nominal
//     annual rate, the way Russian deposits quote "X% годовых, ежемесячная
//     капитализация";
//   * every conversion uses that month's rates through `ratesOf`, and each
//     point says whether those rates were stamped, same as the net-worth chart.

import { BASE_CURRENCY, HAS_PNL, isOpenAt, live } from "./model.js";
import { convert, costBasis, effectiveSnapshot, getSnapshot, stampedFor } from "./calc.js";

export const DEFAULT_BENCH_PCT = 16;

export const monthlyRate = (annualPct) =>
  Number.isFinite(annualPct) && annualPct > -100 ? annualPct / 100 / 12 : 0;

// Chains monthly points from `valueAt`, `flowAt`, `basisAt` callbacks.
// `valueAt(m)` returns null for months before the series exists.
export const buildSeries = (months, { valueAt, flowAt, basisAt, stampedAt }, benchAnnualPct) => {
  const i = monthlyRate(benchAnnualPct);
  const points = [];
  let prev = null;
  for (const m of months) {
    const value = valueAt(m);
    if (!Number.isFinite(value)) continue;
    const flow = Number.isFinite(flowAt(m)) ? flowAt(m) : 0;
    const basis = basisAt ? basisAt(m) : null;
    const stamped = stampedAt ? stampedAt(m) : true;
    let point;
    if (!prev) {
      point = { month: m, value, flow, basis, r: null, index: 1, deposit: value, benchIndex: 1, stamped };
    } else {
      const denom = prev.value + flow / 2;
      const r = denom > 0 ? (value - prev.value - flow) / denom : null;
      point = {
        month: m, value, flow, basis, r,
        index: r === null ? prev.index : prev.index * (1 + r),
        deposit: prev.deposit * (1 + i) + flow * (1 + i / 2),
        benchIndex: prev.benchIndex * (1 + i),
        stamped,
      };
    }
    points.push(point);
    prev = point;
  }
  return points;
};

// Headline numbers for a series: total and annualised time-weighted return,
// P&L against the cost basis, and the gap to the deposit benchmark.
export const summarize = (points) => {
  if (!points.length) return null;
  const last = points[points.length - 1];
  const n = points.length - 1;                       // number of measured months
  const total = last.index - 1;
  const bench = last.benchIndex - 1;
  return {
    months: n,
    total,
    annualized: n > 0 ? Math.pow(last.index, 12 / n) - 1 : null,
    benchTotal: bench,
    benchAnnualized: n > 0 ? Math.pow(last.benchIndex, 12 / n) - 1 : null,
    pnl: Number.isFinite(last.basis) ? last.value - last.basis : null,
    vsDeposit: last.value - last.deposit,
    value: last.value,
    deposit: last.deposit,
    basis: Number.isFinite(last.basis) ? last.basis : null,
    unstamped: points.filter((p) => !p.stamped).length,
  };
};

const stampedWith = (ratesOf, month, currencies) => {
  const list = [...currencies];
  return list.length <= 1 ? true : stampedFor(ratesOf, month, list);
};

// Accounts whose return can be charted: cost-basis types with a fiat basis.
// A coin-denominated or mixed basis has no fiat meaning (see pnlFor) and is
// reported in `excluded` so the UI can ask for a real cost basis.
export const instrumentsOf = (data, months, idx, ratesOf) => {
  const lastM = months[months.length - 1];
  const instruments = [];
  const excluded = [];
  for (const acc of live(data.accounts)) {
    if (!HAS_PNL.has(acc.type)) continue;
    if (!lastM || !(idx.get(acc.id) || []).length) continue;
    const basis = costBasis(data, acc.id, lastM, idx, ratesOf);
    if (basis && (basis.basisIsCoins || basis.mixed)) {
      excluded.push({ acc, reason: basis.mixed ? "mixed" : "coins" });
      continue;
    }
    instruments.push({ acc, currency: basis ? basis.currency : acc.currency });
  }
  return { instruments, excluded };
};

export const instrumentSeries = (data, acc, currency, months, idx, ratesOf, benchAnnualPct) => {
  const used = (m) => {
    const set = new Set([currency]);
    const eff = effectiveSnapshot(idx, acc.id, m);
    if (eff) set.add(eff.snap.currency);
    const s = getSnapshot(idx, acc.id, m);
    if (s && s.contributed !== null) set.add(s.contribCurrency || s.currency);
    return set;
  };
  return buildSeries(months, {
    valueAt: (m) => {
      if (!isOpenAt(acc, m)) return null;
      const eff = effectiveSnapshot(idx, acc.id, m);
      if (!eff) return null;
      return convert(eff.snap.balance, eff.snap.currency, currency, ratesOf(m).table);
    },
    flowAt: (m) => {
      const s = getSnapshot(idx, acc.id, m);
      if (!s || s.contributed === null) return 0;
      return convert(s.contributed, s.contribCurrency || s.currency, currency, ratesOf(m).table);
    },
    basisAt: (m) => {
      const b = costBasis(data, acc.id, m, idx, ratesOf);
      if (!b) return null;
      return convert(b.amount, b.currency, currency, ratesOf(m).table);
    },
    stampedAt: (m) => stampedWith(ratesOf, m, used(m)),
  }, benchAnnualPct);
};

// The whole portfolio in the base currency: sums of the instruments' values,
// flows and bases, each converted at the month's rates.
export const portfolioSeries = (data, instruments, months, idx, ratesOf, benchAnnualPct, currency = BASE_CURRENCY) => {
  const sumOver = (m, pick) => {
    let total = 0;
    let any = false;
    for (const { acc } of instruments) {
      if (!isOpenAt(acc, m)) continue;
      const v = pick(acc, m);
      if (v === null) continue;
      any = true;
      if (Number.isFinite(v)) total += v;
    }
    return any ? total : null;
  };
  const used = (m) => {
    const set = new Set([currency]);
    for (const { acc } of instruments) {
      const eff = effectiveSnapshot(idx, acc.id, m);
      if (eff) set.add(eff.snap.currency);
      const s = getSnapshot(idx, acc.id, m);
      if (s && s.contributed !== null) set.add(s.contribCurrency || s.currency);
    }
    return set;
  };
  return buildSeries(months, {
    valueAt: (m) => sumOver(m, (acc, mm) => {
      const eff = effectiveSnapshot(idx, acc.id, mm);
      return eff ? convert(eff.snap.balance, eff.snap.currency, currency, ratesOf(mm).table) : null;
    }),
    flowAt: (m) => sumOver(m, (acc, mm) => {
      const s = getSnapshot(idx, acc.id, mm);
      if (!s || s.contributed === null) return null;
      return convert(s.contributed, s.contribCurrency || s.currency, currency, ratesOf(mm).table);
    }) ?? 0,
    basisAt: (m) => sumOver(m, (acc, mm) => {
      const b = costBasis(data, acc.id, mm, idx, ratesOf);
      return b ? convert(b.amount, b.currency, currency, ratesOf(mm).table) : null;
    }),
    stampedAt: (m) => stampedWith(ratesOf, m, used(m)),
  }, benchAnnualPct);
};
