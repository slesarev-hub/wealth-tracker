// Return series and deposit benchmark. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalize, SCHEMA_VERSION } from "../src/lib/model.js";
import { makeRatesOf, snapshotIndex, monthsOf } from "../src/lib/calc.js";
import {
  monthlyRate, buildSeries, summarize, instrumentsOf, instrumentSeries, portfolioSeries,
} from "../src/lib/returns.js";

const T = "2026-08-01T00:00:00.000Z";
const acc = (id, over = {}) => ({
  id, name: id, type: "investment", currency: "RUB",
  openedMonth: "", closedMonth: "", updatedAt: T, deletedAt: "", ...over,
});
const snap = (id, accountId, month, balance, over = {}) => ({
  id, accountId, month, balance, currency: "RUB",
  contributed: null, contribCurrency: null, updatedAt: T, deletedAt: "", ...over,
});
const build = (accounts, snapshots, rates = []) =>
  normalize({ schemaVersion: SCHEMA_VERSION, revision: 0, accounts, snapshots, rates });
const ratesRow = (month, currency, perUSD) => ({ month, currency, perUSD, fetchedAt: T });
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

const M = ["2026-03", "2026-04", "2026-05"];
const series = (values, flows = {}, pct = 12) => {
  const v = Object.fromEntries(M.map((m, i) => [m, values[i]]));
  return buildSeries(M, { valueAt: (m) => v[m], flowAt: (m) => flows[m] || 0, basisAt: null }, pct);
};

test("monthlyRate: nominal annual / 12, garbage → 0", () => {
  close(monthlyRate(12), 0.01);
  assert.equal(monthlyRate(NaN), 0);
  assert.equal(monthlyRate(undefined), 0);
});

test("buildSeries: no flows → plain growth chain, deposit compounds monthly", () => {
  const p = series([100, 110, 121]);
  assert.equal(p.length, 3);
  assert.equal(p[0].r, null);
  close(p[1].r, 0.1);
  close(p[2].r, 0.1);
  close(p[2].index, 1.21);
  close(p[1].deposit, 101);
  close(p[2].deposit, 102.01);
  close(p[2].benchIndex, 1.0201);
});

test("buildSeries: a contribution is not a return (Modified Dietz, mid-month)", () => {
  const p = series([100, 205, 205], { "2026-04": 100 });
  close(p[1].r, 5 / 150);
  assert.equal(p[1].flow, 100);
  // the deposit gets the same contribution, half a month of interest on it
  close(p[1].deposit, 100 * 1.01 + 100 * 1.005);
  close(p[2].r, 0);
});

test("buildSeries: starts at the first recorded month, never treats a gap as 0", () => {
  const p = series([null, 50, 55]);
  assert.equal(p.length, 2);
  assert.equal(p[0].month, "2026-04");
  assert.equal(p[0].index, 1);
  assert.equal(p[0].deposit, 50);
  close(p[1].r, 0.1);
});

test("buildSeries: non-positive denominator yields no return and leaves the index alone", () => {
  const p = series([0, 100, 110], { "2026-04": 0 });
  assert.equal(p[1].r, null);
  assert.equal(p[1].index, 1);
  close(p[2].r, 0.1);
});

test("summarize: total, annualised, P&L, gap to the deposit", () => {
  const M2 = ["2026-03", "2026-04", "2026-05"];
  const p = buildSeries(M2, {
    valueAt: (m) => ({ "2026-03": 100, "2026-04": 110, "2026-05": 121 })[m],
    flowAt: () => 0,
    basisAt: () => 100,
  }, 12);
  const s = summarize(p);
  assert.equal(s.months, 2);
  close(s.total, 0.21);
  close(s.annualized, Math.pow(1.21, 6) - 1);
  close(s.pnl, 21);
  close(s.vsDeposit, 121 - 102.01);
  close(s.benchTotal, 0.0201);
  assert.equal(summarize([]), null);
});

test("instrumentSeries: value, flow and basis from snapshots; carried month has zero flow", () => {
  const data = build([acc("inv")], [
    snap("s1", "inv", "2026-03", 1000, { contributed: 1000 }),
    snap("s2", "inv", "2026-04", 1100, { contributed: 0 }),
    snap("s3", "inv", "2026-06", 1210, { contributed: 0 }),
  ]);
  const idx = snapshotIndex(data);
  const months = ["2026-03", "2026-04", "2026-05", "2026-06"];
  const p = instrumentSeries(data, data.accounts[0], "RUB", months, idx, makeRatesOf(data, null), 12);
  assert.deepEqual(p.map((x) => x.month), months);
  assert.equal(p[0].flow, 1000);
  assert.equal(p[0].basis, 1000);
  close(p[1].r, 0.1);
  assert.equal(p[2].value, 1100);      // carried forward
  assert.equal(p[2].flow, 0);
  close(p[2].r, 0);
  close(p[3].r, 0.1);
  close(summarize(p).pnl, 210);
  assert.ok(p.every((x) => x.stamped)); // RUB-only: no conversion, nothing to stamp
});

test("instrumentSeries: crypto valued in its fiat basis at each month's stamped rate", () => {
  const data = build(
    [acc("btc", { type: "crypto", currency: "BTC" })],
    [
      snap("s1", "btc", "2026-03", 0.01, { currency: "BTC", contributed: 40000, contribCurrency: "RUB" }),
      snap("s2", "btc", "2026-04", 0.01, { currency: "BTC", contributed: 0, contribCurrency: "RUB" }),
    ],
    [
      ratesRow("2026-03", "RUB", 80), ratesRow("2026-03", "BTC", 0.00002),   // 1 BTC = 50 000 $
      ratesRow("2026-04", "RUB", 80), ratesRow("2026-04", "BTC", 0.00001),   // 1 BTC = 100 000 $
    ]
  );
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, null);
  const { instruments, excluded } = instrumentsOf(data, monthsOf(data), idx, ratesOf);
  assert.equal(excluded.length, 0);
  assert.equal(instruments[0].currency, "RUB");
  const p = instrumentSeries(data, data.accounts[0], "RUB", monthsOf(data), idx, ratesOf, 0);
  close(p[0].value, 40000);
  close(p[1].value, 80000);
  close(p[1].r, 1);
  assert.ok(p.every((x) => x.stamped));
  // unstamped month → flagged, value still computed from live rates
  const data2 = build(data.accounts, data.snapshots, data.rates.filter((r) => r.month !== "2026-04"));
  const p2 = instrumentSeries(data2, data2.accounts[0], "RUB", monthsOf(data2), snapshotIndex(data2),
    makeRatesOf(data2, { RUB: 80, BTC: 0.00001 }), 0);
  assert.equal(p2[0].stamped, true);
  assert.equal(p2[1].stamped, false);
});

test("instrumentsOf: coin-denominated basis is excluded, not charted as a fiat return", () => {
  const data = build(
    [acc("btc", { type: "crypto", currency: "BTC" }), acc("inv"), acc("cash", { type: "cash" })],
    [
      snap("s1", "btc", "2026-03", 0.5, { currency: "BTC", contributed: 0.5, contribCurrency: "BTC" }),
      snap("s2", "inv", "2026-03", 100, { contributed: 100 }),
      snap("s3", "cash", "2026-03", 100),
    ]
  );
  const idx = snapshotIndex(data);
  const { instruments, excluded } = instrumentsOf(data, monthsOf(data), idx, makeRatesOf(data, null));
  assert.deepEqual(instruments.map((i) => i.acc.id), ["inv"]);
  assert.deepEqual(excluded.map((e) => [e.acc.id, e.reason]), [["btc", "coins"]]);
});

test("portfolioSeries: sums instruments in the base currency; a closed account drops out", () => {
  const data = build(
    [acc("a"), acc("b", { closedMonth: "2026-04" })],
    [
      snap("a1", "a", "2026-03", 100, { contributed: 100 }),
      snap("a2", "a", "2026-04", 110, { contributed: 0 }),
      snap("a3", "a", "2026-05", 121, { contributed: 0 }),
      snap("b1", "b", "2026-03", 200, { contributed: 200 }),
      snap("b2", "b", "2026-04", 200, { contributed: 50 }),
    ]
  );
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, null);
  const { instruments } = instrumentsOf(data, monthsOf(data), idx, ratesOf);
  const p = portfolioSeries(data, instruments, monthsOf(data), idx, ratesOf, 12);
  assert.equal(p[0].value, 300);
  assert.equal(p[0].basis, 300);
  assert.equal(p[1].value, 310);
  assert.equal(p[1].flow, 50);
  close(p[1].r, (310 - 300 - 50) / (300 + 25));
  assert.equal(p[2].value, 121);        // b closed after 2026-04
  assert.equal(p[2].basis, 100);
});
