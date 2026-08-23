// One test (or group) per confirmed audit finding. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseNum, prevMonth, nextMonth, isMonth, normalize, migrateV1, ensureV2,
  mergeData, detectVersion, purgeTombstones, isOpenAt, emptyData, live, SCHEMA_VERSION, MIGRATION_STAMP,
} from "../src/lib/model.js";
import {
  makeRatesOf, convert, snapshotIndex, monthsOf, effectiveSnapshot, monthTotal,
  costBasis, pnlFor, monthlyChange, percentChange, accountDelta, breakdown,
  accountsForMonth, accountsInMonth, stampedFor, currenciesInMonth,
} from "../src/lib/calc.js";
import { fmtShort, fmtBalance, monthLabel } from "../src/lib/format.js";

const T = "2026-08-01T00:00:00.000Z";

const acc = (id, over = {}) => ({
  id, name: id, type: "savings", currency: "RUB",
  openedMonth: "", closedMonth: "", updatedAt: T, deletedAt: "", ...over,
});
const snap = (id, accountId, month, balance, over = {}) => ({
  id, accountId, month, balance, currency: "RUB",
  contributed: null, contribCurrency: null, updatedAt: T, deletedAt: "", ...over,
});
const build = (accounts, snapshots, rates = []) =>
  normalize({ schemaVersion: SCHEMA_VERSION, revision: 0, accounts, snapshots, rates });

const ratesRow = (month, currency, perUSD) => ({ month, currency, perUSD, fetchedAt: T });

// ── parseNum: FORMATTED_VALUE / ru_RU locale / hand-edited cells ─────────────

test("parseNum survives every representation a Sheets cell can produce", () => {
  // ru_RU FORMATTED_VALUE — bare parseFloat gives 0 and 102 here
  assert.equal(parseNum("0,0125"), 0.0125);
  assert.equal(parseNum("250 000"), 250000);
  assert.equal(parseNum("250 000"), 250000);       // non-breaking space
  assert.equal(parseNum("1 234 567,89"), 1234567.89);
  assert.equal(parseNum("1.234.567"), 1234567);         // dot grouping
  assert.equal(parseNum("1,234,567.89"), 1234567.89);   // en grouping
  // what this app actually writes
  assert.equal(parseNum(250000), 250000);
  assert.equal(parseNum("0.0125"), 0.0125);
  assert.equal(parseNum("-1 000,5"), -1000.5);
  assert.equal(parseNum("530000"), 530000);
  // garbage stays garbage rather than becoming 0
  for (const bad of ["", "  ", "abc", null, undefined, true, "—", {}]) {
    assert.ok(Number.isNaN(parseNum(bad)), `expected NaN for ${JSON.stringify(bad)}`);
  }
});

// ── months ──────────────────────────────────────────────────────────────────

test("month helpers are total functions (v1 threw on an empty month input)", () => {
  assert.equal(prevMonth("2026-01"), "2025-12");
  assert.equal(nextMonth("2026-12"), "2027-01");
  assert.equal(prevMonth(""), null);
  assert.equal(prevMonth("garbage"), null);
  assert.equal(isMonth("2026-13"), false);
  assert.equal(isMonth("2026-00"), false);
  assert.equal(isMonth("2026-07"), true);
  assert.equal(monthLabel("2026-07"), "Июл 2026");
});

// ── HIGH: cumulative invested reset by a skipped month ──────────────────────

test("a skipped month no longer resets the cost basis", () => {
  // Jan: put in 100k. Feb not recorded at all. Mar: put in 10k.
  const data = build(
    [acc("inv", { type: "investment" })],
    [
      snap("s1", "inv", "2026-01", 105000, { contributed: 100000, contribCurrency: "RUB" }),
      snap("s3", "inv", "2026-03", 120000, { contributed: 10000, contribCurrency: "RUB" }),
    ]
  );
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, { rates: { USD: 1, RUB: 80 } });
  const basis = costBasis(data, "inv", "2026-03", idx, ratesOf);
  assert.equal(basis.amount, 110000);                        // v1 stored 10000
  const p = pnlFor(data, data.accounts[0], "2026-03", idx, ratesOf);
  assert.equal(p.pnl, 10000);                                // v1 displayed +110000
});

test("editing an earlier month's contribution changes later P&L by exactly that amount", () => {
  const mk = (janContrib) => {
    const data = build(
      [acc("inv", { type: "investment" })],
      [
        snap("s1", "inv", "2026-01", 100000, { contributed: janContrib, contribCurrency: "RUB" }),
        snap("s2", "inv", "2026-02", 160000, { contributed: 50000, contribCurrency: "RUB" }),
      ]
    );
    const idx = snapshotIndex(data);
    const ratesOf = makeRatesOf(data, { rates: { USD: 1, RUB: 80 } });
    return pnlFor(data, data.accounts[0], "2026-02", idx, ratesOf);
  };
  assert.equal(mk(100000).pnl, 10000);
  // v1 left February's stored cumulative untouched, so this stayed 10000
  assert.equal(mk(120000).pnl, -10000);
});

test("cost basis only counts months up to the one being viewed", () => {
  const data = build(
    [acc("inv", { type: "investment" })],
    [
      snap("s1", "inv", "2026-01", 100, { contributed: 100, contribCurrency: "RUB" }),
      snap("s2", "inv", "2026-02", 300, { contributed: 100, contribCurrency: "RUB" }),
      snap("s3", "inv", "2026-03", 600, { contributed: 100, contribCurrency: "RUB" }),
    ]
  );
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, { rates: { USD: 1, RUB: 80 } });
  assert.equal(costBasis(data, "inv", "2026-01", idx, ratesOf).amount, 100);
  assert.equal(costBasis(data, "inv", "2026-02", idx, ratesOf).amount, 200);
  assert.equal(costBasis(data, "inv", "2026-03", idx, ratesOf).amount, 300);
});

test("a crypto cost basis recorded in coins is reported as not meaningful", () => {
  const data = build(
    [acc("btc", { type: "crypto", currency: "BTC" })],
    [snap("s1", "btc", "2026-03", 0.0125, { currency: "BTC", contributed: 0.0125, contribCurrency: "BTC" })]
  );
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, { rates: { USD: 1, RUB: 80, BTC: 1 / 77228 } });
  const p = pnlFor(data, data.accounts[0], "2026-03", idx, ratesOf);
  assert.equal(p.pnl, 0);
  assert.equal(p.meaningful, false);          // UI must ask for a real basis
});

test("a crypto cost basis recorded in fiat produces a real P&L", () => {
  const data = build(
    [acc("btc", { type: "crypto", currency: "BTC" })],
    [snap("s1", "btc", "2026-03", 1, { currency: "BTC", contributed: 5_000_000, contribCurrency: "RUB" })],
    [ratesRow("2026-03", "RUB", 80), ratesRow("2026-03", "BTC", 1 / 100000)]
  );
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, null);
  const p = pnlFor(data, data.accounts[0], "2026-03", idx, ratesOf);
  assert.equal(p.currency, "RUB");
  assert.equal(p.meaningful, true);
  assert.equal(Math.round(p.value), 8_000_000);      // 1 BTC = 100k USD = 8M RUB
  assert.equal(Math.round(p.pnl), 3_000_000);
});

// ── HIGH: missing snapshot counted as zero ──────────────────────────────────

test("an unrecorded month carries the last known balance instead of counting as 0", () => {
  const data = build(
    [acc("a"), acc("b")],
    [
      snap("s1", "a", "2026-01", 1000), snap("s2", "b", "2026-01", 500),
      snap("s3", "a", "2026-02", 1100),                       // b not recorded
    ]
  );
  const idx = snapshotIndex(data);
  const t = monthTotal(data, "2026-02", "RUB", { USD: 1, RUB: 80 }, idx);
  assert.equal(t.total, 1600);                                // v1 gave 1100
  assert.equal(t.carried.length, 1);
  assert.equal(t.carried[0].id, "b");
});

test("an account is not carried backwards before its first record", () => {
  const data = build([acc("a")], [snap("s1", "a", "2026-05", 1000)]);
  const idx = snapshotIndex(data);
  assert.equal(effectiveSnapshot(idx, "a", "2026-04"), null);
  assert.equal(monthTotal(data, "2026-04", "RUB", { USD: 1, RUB: 80 }, idx).count, 0);
});

// ── HIGH: NaN propagation from a single missing rate ────────────────────────

test("one unconvertible account does not turn the whole total into NaN", () => {
  const data = build(
    [acc("r"), acc("b", { currency: "BTC", type: "crypto" })],
    [snap("s1", "r", "2026-03", 1000), snap("s2", "b", "2026-03", 2, { currency: "BTC" })]
  );
  const idx = snapshotIndex(data);
  const t = monthTotal(data, "2026-03", "RUB", { USD: 1, RUB: 80 }, idx); // no BTC rate
  assert.equal(t.total, 1000);                                // v1 produced NaN
  assert.equal(t.unconverted.length, 1);
  assert.equal(t.unconverted[0].id, "b");
});

// ── HIGH: debt sign ─────────────────────────────────────────────────────────

test("debt subtracts from the total and a growing debt is a negative delta", () => {
  const data = build(
    [acc("cash"), acc("loan", { type: "debt" })],
    [
      snap("s1", "cash", "2026-01", 1000), snap("s2", "loan", "2026-01", 300),
      snap("s3", "cash", "2026-02", 1000), snap("s4", "loan", "2026-02", 500),
    ]
  );
  const idx = snapshotIndex(data);
  const table = { USD: 1, RUB: 80 };
  assert.equal(monthTotal(data, "2026-01", "RUB", table, idx).total, 700);
  assert.equal(monthTotal(data, "2026-02", "RUB", table, idx).total, 500);
  const loan = data.accounts.find((a) => a.id === "loan");
  // v1 showed +200 in green for a debt that grew by 200
  assert.equal(accountDelta(data, loan, "2026-02", "2026-01", idx).delta, -200);
});

// ── HIGH: closed accounts ───────────────────────────────────────────────────

test("a closed account counts in its closing month and never after", () => {
  const data = build(
    [acc("a"), acc("old", { closedMonth: "2026-02" })],
    [
      snap("s1", "a", "2026-01", 100), snap("s2", "old", "2026-01", 50),
      snap("s3", "a", "2026-02", 100), snap("s4", "old", "2026-02", 0),
      snap("s5", "a", "2026-03", 100),
    ]
  );
  const idx = snapshotIndex(data);
  const table = { USD: 1, RUB: 80 };
  assert.equal(monthTotal(data, "2026-01", "RUB", table, idx).total, 150);
  assert.equal(monthTotal(data, "2026-02", "RUB", table, idx).total, 100);
  assert.equal(monthTotal(data, "2026-03", "RUB", table, idx).total, 100);
  // and it must not be carried forward past its closing month
  assert.equal(accountsInMonth(data, "2026-03", idx).length, 1);
});

test("the record form offers exactly the accounts open in the month being recorded", () => {
  const data = build([acc("a"), acc("old", { closedMonth: "2026-02" }), acc("new", { openedMonth: "2026-03" })], []);
  assert.deepEqual(accountsForMonth(data, "2026-01").map((a) => a.id), ["a", "old"]);
  assert.deepEqual(accountsForMonth(data, "2026-02").map((a) => a.id), ["a", "old"]);
  // v1 offered "not closed today", so a closed account could never be zeroed
  // and a past month could not be backfilled
  assert.deepEqual(accountsForMonth(data, "2026-03").map((a) => a.id), ["a", "new"]);
  assert.equal(isOpenAt(data.accounts.find((a) => a.id === "old"), "2026-02"), true);
  assert.equal(isOpenAt(data.accounts.find((a) => a.id === "old"), "2026-03"), false);
});

// ── HIGH: history revalued at today's rate ──────────────────────────────────

test("each month is valued at its own stored rates, not at today's", () => {
  const data = build(
    [acc("usd", { currency: "USD" })],
    [snap("s1", "usd", "2026-01", 1000, { currency: "USD" }), snap("s2", "usd", "2026-02", 1000, { currency: "USD" })],
    [ratesRow("2026-01", "RUB", 90), ratesRow("2026-02", "RUB", 80)]
  );
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, { rates: { USD: 1, RUB: 100 } });   // "today"
  assert.equal(monthTotal(data, "2026-01", "RUB", ratesOf("2026-01").table, idx).total, 90000);
  assert.equal(monthTotal(data, "2026-02", "RUB", ratesOf("2026-02").table, idx).total, 80000);
  assert.equal(ratesOf("2026-01").stamped, true);
});

test("a month with no stored rates falls back to live rates and says so", () => {
  const data = build([acc("usd", { currency: "USD" })], [snap("s1", "usd", "2026-01", 10, { currency: "USD" })]);
  const ratesOf = makeRatesOf(data, { rates: { USD: 1, RUB: 100 } });
  assert.equal(ratesOf("2026-01").stamped, false);
  assert.equal(ratesOf("2026-01").table.RUB, 100);
});

// ── the actual question: what is "доход" ────────────────────────────────────

test("a pure exchange-rate move is reported as FX, not as income", () => {
  const data = build(
    [acc("usd", { currency: "USD" })],
    [snap("s1", "usd", "2026-01", 1000, { currency: "USD" }), snap("s2", "usd", "2026-02", 1000, { currency: "USD" })],
    [ratesRow("2026-01", "RUB", 80), ratesRow("2026-02", "RUB", 90)]
  );
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, null);
  const d = monthlyChange(data, "2026-02", "2026-01", "RUB", ratesOf, idx);
  assert.equal(d.change, 10000);
  assert.equal(d.fx, 10000);
  assert.equal(d.added, 0);
  assert.equal(d.rest, 0);            // v1 called the whole 10000 "За месяц"
});

test("money the user put in is reported as a contribution, not as income", () => {
  const data = build(
    [acc("inv", { type: "investment" })],
    [
      snap("s1", "inv", "2026-01", 1000, { contributed: 1000, contribCurrency: "RUB" }),
      snap("s2", "inv", "2026-02", 3000, { contributed: 2000, contribCurrency: "RUB" }),
    ],
    [ratesRow("2026-01", "RUB", 80), ratesRow("2026-02", "RUB", 80)]
  );
  const idx = snapshotIndex(data);
  const d = monthlyChange(data, "2026-02", "2026-01", "RUB", makeRatesOf(data, null), idx);
  assert.equal(d.change, 2000);
  assert.equal(d.added, 2000);
  assert.equal(d.fx, 0);
  assert.equal(d.rest, 0);
});

test("a market gain lands in 'rest' once FX and contributions are removed", () => {
  const data = build(
    [acc("inv", { type: "investment" })],
    [
      snap("s1", "inv", "2026-01", 1000, { contributed: 1000, contribCurrency: "RUB" }),
      snap("s2", "inv", "2026-02", 3500, { contributed: 2000, contribCurrency: "RUB" }),
    ],
    [ratesRow("2026-01", "RUB", 80), ratesRow("2026-02", "RUB", 80)]
  );
  const idx = snapshotIndex(data);
  const d = monthlyChange(data, "2026-02", "2026-01", "RUB", makeRatesOf(data, null), idx);
  assert.equal(d.change, 2500);
  assert.equal(d.added, 2000);
  assert.equal(d.rest, 500);
});

test("change always decomposes exactly into fx + added + rest", () => {
  const data = build(
    [acc("usd", { currency: "USD" }), acc("inv", { type: "investment" }), acc("loan", { type: "debt" })],
    [
      snap("a1", "usd", "2026-01", 500, { currency: "USD" }),
      snap("b1", "inv", "2026-01", 1000, { contributed: 1000, contribCurrency: "RUB" }),
      snap("c1", "loan", "2026-01", 200),
      snap("a2", "usd", "2026-02", 600, { currency: "USD" }),
      snap("b2", "inv", "2026-02", 1800, { contributed: 500, contribCurrency: "RUB" }),
      snap("c2", "loan", "2026-02", 150),
    ],
    [ratesRow("2026-01", "RUB", 80), ratesRow("2026-02", "RUB", 92)]
  );
  const idx = snapshotIndex(data);
  const d = monthlyChange(data, "2026-02", "2026-01", "RUB", makeRatesOf(data, null), idx);
  assert.ok(Math.abs(d.change - (d.fx + d.added + d.rest)) < 1e-6);
});

// ── percentages ─────────────────────────────────────────────────────────────

test("percent change keeps its sign when the previous total is negative", () => {
  assert.equal(percentChange(50, 200), 25);
  assert.equal(percentChange(-50, 200), -25);
  // v1: (-50 / -200) * 100 = +25%, a loss shown as a gain
  assert.equal(percentChange(-50, -200), -25);
  assert.equal(percentChange(50, -200), 25);
  assert.equal(percentChange(50, 0), null);          // v1 printed "0%"
  assert.equal(percentChange(NaN, 10), null);
});

// ── breakdowns ──────────────────────────────────────────────────────────────

test("breakdown separates assets from liabilities and matches the total", () => {
  const data = build(
    [acc("cash"), acc("usd", { currency: "USD" }), acc("loan", { type: "debt" })],
    [
      snap("s1", "cash", "2026-03", 1000),
      snap("s2", "usd", "2026-03", 100, { currency: "USD" }),
      snap("s3", "loan", "2026-03", 500),
    ]
  );
  const idx = snapshotIndex(data);
  const table = { USD: 1, RUB: 80 };
  const b = breakdown(data, "2026-03", "RUB", table, idx);
  assert.equal(b.assets, 9000);
  assert.equal(b.liabilities, 500);
  assert.equal(b.net, 8500);
  assert.equal(b.net, monthTotal(data, "2026-03", "RUB", table, idx).total);
  // the currency split covers assets only, so its shares add up to 100%
  assert.equal(b.byCurrency.reduce((s, c) => s + c.converted, 0), 9000);
});

// ── normalisation: ghosts, orphans, duplicates ──────────────────────────────

test("ghost rows, orphans and duplicates are dropped on read", () => {
  const data = normalize({
    accounts: [acc("a"), { id: "", name: "" }, acc("a")],
    snapshots: [
      snap("s1", "a", "2026-01", 100),
      snap("s2", "gone", "2026-01", 999),                          // orphan
      snap("s3", "a", "2026-01", 200, { updatedAt: "2026-09-01T00:00:00Z" }), // duplicate, newer
      { id: "", accountId: "a", month: "2026-01", balance: 5 },     // ghost
      snap("s5", "a", "not-a-month", 5),
      snap("s6", "a", "2026-02", "abc"),                            // unparseable
    ],
  });
  assert.equal(data.accounts.length, 1);
  assert.equal(data.snapshots.length, 1);
  assert.equal(data.snapshots[0].balance, 200);        // newer duplicate wins
  const idx = snapshotIndex(data);
  assert.equal(monthTotal(data, "2026-01", "RUB", { USD: 1, RUB: 80 }, idx).total, 200);
});

// ── migration ───────────────────────────────────────────────────────────────

test("v1 cumulative invested migrates to exact monthly contributions", () => {
  // consecutive months: the delta is the difference, exactly as v1 computed it
  const v1 = {
    accounts: [{ id: "inv", name: "Брокер", type: "investment", currency: "RUB" }],
    snapshots: [
      { id: "1", accountId: "inv", month: "2026-03", balance: "40000", invested: "40000" },
      { id: "2", accountId: "inv", month: "2026-04", balance: "60000", invested: "40000" },
      { id: "3", accountId: "inv", month: "2026-05", balance: "80000", invested: "70000" },
    ],
  };
  const { data, repairedGaps } = migrateV1(v1, T);
  assert.deepEqual(data.snapshots.map((s) => s.contributed), [40000, 0, 30000]);
  assert.equal(repairedGaps.length, 0);
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, { rates: { USD: 1, RUB: 80 } });
  assert.equal(costBasis(data, "inv", "2026-05", idx, ratesOf).amount, 70000);
});

test("migration inverts v1's own formula, including when a month had no invested value", () => {
  // v1 used `invested(previous CALENDAR month) ?? 0` as the base, so a month
  // recorded without an invested value also reset the base to 0.
  const v1 = {
    accounts: [{ id: "inv", name: "I", type: "investment", currency: "RUB" }],
    snapshots: [
      { id: "1", accountId: "inv", month: "2026-01", balance: "100", invested: "100000" },
      { id: "2", accountId: "inv", month: "2026-02", balance: "100" },          // no invested
      { id: "3", accountId: "inv", month: "2026-03", balance: "118000", invested: "10000" },
    ],
  };
  const { data, repairedGaps } = migrateV1(v1, T);
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, { rates: { USD: 1, RUB: 80 } });
  assert.equal(costBasis(data, "inv", "2026-03", idx, ratesOf).amount, 110000);
  assert.equal(repairedGaps.length, 1);
});

test("v1 detection and migration of closed flags and orphans", () => {
  const v1 = {
    accounts: [
      { id: "a", name: "A", type: "savings", currency: "RUB", closed: true },
      { id: "b", name: "B", type: "savings", currency: "RUB", closed: true, closedMonth: "2026-02" },
    ],
    snapshots: [
      { id: "1", accountId: "a", month: "2026-01", balance: "10" },
      { id: "2", accountId: "a", month: "2026-04", balance: "10" },
      { id: "3", accountId: "zzz", month: "2026-01", balance: "999" },
    ],
  };
  assert.equal(detectVersion(v1), 1);
  const { data } = migrateV1(v1, T);
  // a closed account with no month closes at its last record, so it stops
  // counting after that instead of counting forever
  assert.equal(data.accounts.find((a) => a.id === "a").closedMonth, "2026-04");
  assert.equal(data.accounts.find((a) => a.id === "b").closedMonth, "2026-02");
  assert.equal(data.snapshots.filter((s) => s.accountId === "zzz").length, 0);
});

test("crypto accounts whose basis is in coins are flagged for review", () => {
  const v1 = {
    accounts: [{ id: "btc", name: "Криптобиржа", type: "crypto", currency: "BTC" }],
    snapshots: [{ id: "1", accountId: "btc", month: "2026-03", balance: "0.0125", invested: "0.0125" }],
  };
  const { needsCostBasisReview } = migrateV1(v1, T);
  assert.deepEqual(needsCostBasisReview, ["btc"]);
});

test("ensureV2 is idempotent on already-migrated data", () => {
  const v2 = build([acc("a")], [snap("s1", "a", "2026-01", 10)]);
  const r1 = ensureV2(v2, T);
  assert.equal(r1.migrated, false);
  const r2 = ensureV2(r1.data, T);
  assert.deepEqual(r2.data, r1.data);
  assert.equal(ensureV2(null, T).data.accounts.length, 0);
});

// ── merge / sync ────────────────────────────────────────────────────────────

test("signing in merges local edits instead of discarding them", () => {
  // recorded on this device before signing in
  const local = build([acc("a")], [snap("s1", "a", "2026-01", 100), snap("s2", "a", "2026-02", 200)]);
  // the sheet only knows about January
  const remote = build([acc("a")], [snap("s1", "a", "2026-01", 100)]);
  const merged = mergeData(local, remote);
  assert.equal(merged.snapshots.length, 2);      // v1 replaced local wholesale
  assert.ok(merged.snapshots.some((s) => s.month === "2026-02" && s.balance === 200));
});

test("the newer edit wins per record", () => {
  const local = build([acc("a")], [snap("s1", "a", "2026-01", 100, { updatedAt: "2026-08-02T00:00:00Z" })]);
  const remote = build([acc("a")], [snap("s1", "a", "2026-01", 999, { updatedAt: "2026-08-01T00:00:00Z" })]);
  assert.equal(mergeData(local, remote).snapshots[0].balance, 100);
  assert.equal(mergeData(remote, local).snapshots[0].balance, 100);
});

test("a deletion propagates and does not resurrect from the other device", () => {
  const local = build([acc("a")], [snap("s1", "a", "2026-01", 100, { deletedAt: "2026-08-05T00:00:00Z", updatedAt: "2026-08-05T00:00:00Z" })]);
  const remote = build([acc("a")], [snap("s1", "a", "2026-01", 100, { updatedAt: "2026-08-01T00:00:00Z" })]);
  const merged = mergeData(local, remote);
  assert.equal(merged.snapshots.filter((s) => !s.deletedAt).length, 0);
  const idx = snapshotIndex(merged);
  assert.equal(monthTotal(merged, "2026-01", "RUB", { USD: 1, RUB: 80 }, idx).count, 0);
});

test("two devices recording the same month collapse to one snapshot", () => {
  const local = build([acc("a")], [snap("x", "a", "2026-01", 100, { updatedAt: "2026-08-01T00:00:00Z" })]);
  const remote = build([acc("a")], [snap("y", "a", "2026-01", 250, { updatedAt: "2026-08-02T00:00:00Z" })]);
  const merged = mergeData(local, remote);
  const alive = merged.snapshots.filter((s) => !s.deletedAt);
  assert.equal(alive.length, 1);
  assert.equal(alive[0].balance, 250);
  const idx = snapshotIndex(merged);
  // the loser is tombstoned, so the month is not counted twice
  assert.equal(monthTotal(merged, "2026-01", "RUB", { USD: 1, RUB: 80 }, idx).total, 250);
});

test("stamped historical rates are immutable across a merge", () => {
  const local = build([acc("a")], [], [ratesRow("2026-01", "RUB", 80)]);
  const remote = build([acc("a")], [], [ratesRow("2026-01", "RUB", 95)]);
  assert.equal(mergeData(local, remote).rates[0].perUSD, 80);
});

test("tombstones are purged only after their TTL", () => {
  const now = new Date("2026-08-01T00:00:00Z");
  const data = build([acc("a")], [
    snap("s1", "a", "2026-01", 1, { deletedAt: "2026-07-01T00:00:00Z" }),
    snap("s2", "a", "2026-02", 1, { deletedAt: "2025-01-01T00:00:00Z" }),
  ]);
  const p = purgeTombstones(data, now, 180);
  assert.equal(p.snapshots.length, 1);
  assert.equal(p.snapshots[0].id, "s1");
});

// ── formatting ──────────────────────────────────────────────────────────────

test("fmtShort never disagrees with its own unit", () => {
  assert.equal(fmtShort(999_500), "1.0M");      // v1 rendered "1000K"
  assert.equal(fmtShort(999_499), "999K");
  assert.equal(fmtShort(999.5), "1K");
  assert.equal(fmtShort(999), "999");
  assert.equal(fmtShort(-999_500), "-1.0M");
  assert.equal(fmtShort(0), "0");
  assert.equal(fmtShort(NaN), "—");
  assert.equal(fmtShort(null), "—");
  assert.equal(fmtBalance(0.0125, "BTC"), "0.0125");
  assert.equal(fmtBalance(1234567, "RUB"), "1.2M");
});

// ── conversion ──────────────────────────────────────────────────────────────

test("convert is exact both ways and refuses missing or zero rates", () => {
  const table = { USD: 1, RUB: 80, EUR: 0.9 };
  assert.equal(convert(100, "USD", "RUB", table), 8000);
  assert.equal(convert(8000, "RUB", "USD", table), 100);
  assert.equal(convert(100, "RUB", "RUB", table), 100);
  assert.ok(Number.isNaN(convert(100, "BTC", "RUB", table)));
  assert.ok(Number.isNaN(convert(100, "USD", "RUB", { USD: 1, RUB: 0 })));
  assert.ok(Number.isNaN(convert(NaN, "USD", "RUB", table)));
});

test("monthsOf ignores deleted snapshots", () => {
  const data = build([acc("a")], [
    snap("s1", "a", "2026-01", 1),
    snap("s2", "a", "2026-02", 1, { deletedAt: T }),
  ]);
  assert.deepEqual(monthsOf(data), ["2026-01"]);
});

// ── determinism ─────────────────────────────────────────────────────────────

test("normalize output does not depend on input order", () => {
  const accounts = [acc("b"), acc("a"), acc("c")];
  const snaps = [
    snap("s3", "c", "2026-02", 3), snap("s1", "a", "2026-01", 1),
    snap("s4", "a", "2026-02", 4), snap("s2", "b", "2026-01", 2),
    snap("s5", "b", "2026-01", 9, { deletedAt: T }),
    snap("s6", "c", "2026-01", 7),
  ];
  const shuffles = [
    snaps,
    [...snaps].reverse(),
    [snaps[2], snaps[5], snaps[0], snaps[4], snaps[1], snaps[3]],
  ];
  const outs = shuffles.map((s) => JSON.stringify(normalize({ accounts, snapshots: s }).snapshots));
  assert.equal(new Set(outs).size, 1, "same data in a different order normalised differently");
});

test("a tombstone survives normalisation alongside a live record for the same month", () => {
  // the old month's record was deleted, then the month was recorded again
  const data = normalize({
    accounts: [acc("a")],
    snapshots: [
      snap("old", "a", "2026-01", 100, { deletedAt: "2026-08-02T00:00:00Z", updatedAt: "2026-08-02T00:00:00Z" }),
      snap("new", "a", "2026-01", 250, { updatedAt: "2026-08-03T00:00:00Z" }),
    ],
  });
  assert.equal(data.snapshots.length, 2, "the tombstone must be kept or the deletion is forgotten");
  assert.equal(live(data.snapshots).length, 1);
  assert.equal(live(data.snapshots)[0].balance, 250);
  const idx = snapshotIndex(data);
  assert.equal(monthTotal(data, "2026-01", "RUB", { USD: 1, RUB: 80 }, idx).total, 250);
  // and the deletion is still honoured when the sheet still has the old record live
  const remote = normalize({ accounts: [acc("a")], snapshots: [snap("old", "a", "2026-01", 100, { updatedAt: "2026-08-01T00:00:00Z" })] });
  assert.equal(live(mergeData(data, remote).snapshots).length, 1);
});

// ── review findings on the rewrite itself ───────────────────────────────────

test("a coin basis plus one fiat contribution does not fabricate a cost basis", () => {
  // exactly the migrated Криптобиржа shape, then the user adds a real RUB purchase
  const data = build(
    [acc("btc", { type: "crypto", currency: "BTC" })],
    [
      snap("s1", "btc", "2026-03", 0.0025, { currency: "BTC", contributed: 0.0025, contribCurrency: "BTC" }),
      snap("s2", "btc", "2026-04", 0.0035, { currency: "BTC", contributed: 80000, contribCurrency: "RUB" }),
    ],
    [ratesRow("2026-04", "RUB", 80), ratesRow("2026-04", "BTC", 1 / 100000)]
  );
  const idx = snapshotIndex(data);
  const p = pnlFor(data, data.accounts[0], "2026-04", idx, makeRatesOf(data, null));
  assert.equal(p.mixed, true);
  assert.equal(p.meaningful, false, "a half-coin half-fiat basis must not be presented as a real P&L");
});

test("a cost basis converted through an unstamped month is not reported as exact", () => {
  const data = build(
    [acc("inv", { type: "investment", currency: "RUB" })],
    [
      snap("s1", "inv", "2026-01", 1000, { contributed: 100, contribCurrency: "USD" }),
      snap("s2", "inv", "2026-02", 2000, { contributed: 5000, contribCurrency: "RUB" }),
    ],
    [ratesRow("2026-02", "RUB", 80)]           // January deliberately unstamped
  );
  const idx = snapshotIndex(data);
  const b = costBasis(data, "inv", "2026-02", idx, makeRatesOf(data, { rates: { USD: 1, RUB: 80 } }));
  assert.equal(b.currency, "RUB");
  assert.equal(b.exact, false, "converting at today's rate must be flagged, not silently trusted");
});

test("a month is only 'stamped' when every currency it uses is stamped", () => {
  const data = build(
    [acc("r"), acc("u", { currency: "USD" })],
    [snap("s1", "r", "2026-01", 10), snap("s2", "u", "2026-01", 10, { currency: "USD" })],
    [ratesRow("2026-01", "EUR", 0.9)]          // stamped, but not the currencies in use
  );
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, { rates: { USD: 1, RUB: 80, EUR: 0.9 } });
  assert.equal(ratesOf("2026-01").stamped, true, "there is a stamp");
  assert.equal(stampedFor(ratesOf, "2026-01", currenciesInMonth(data, "2026-01", idx)), false,
    "but it does not cover the currencies actually held");
});

test("an account that closed is not credited with an FX move it did not make", () => {
  const data = build(
    [acc("stay"), acc("gone", { currency: "USD", closedMonth: "2026-01" })],
    [
      snap("s1", "stay", "2026-01", 1000), snap("s2", "gone", "2026-01", 100, { currency: "USD" }),
      snap("s3", "stay", "2026-02", 1000),
    ],
    [ratesRow("2026-01", "RUB", 80), ratesRow("2026-01", "USD", 1),
     ratesRow("2026-02", "RUB", 90), ratesRow("2026-02", "USD", 1)]
  );
  const idx = snapshotIndex(data);
  const d = monthlyChange(data, "2026-02", "2026-01", "RUB", makeRatesOf(data, null), idx);
  assert.equal(d.fx, 0, "the closed USD account must not contribute a phantom FX gain");
  assert.equal(d.change, -8000);          // the 100 USD (8000 ₽ at 80) left
  assert.ok(Math.abs(d.change - (d.fx + d.added + d.rest)) < 1e-6);
});

// ── second review round: data must never be silently discarded ──────────────

test("a row that cannot be parsed is quarantined, not deleted", () => {
  const data = normalize({
    accounts: [acc("a")],
    snapshots: [
      snap("s1", "a", "2026-01", 100),
      { id: "s2", accountId: "a", month: "2026-02", balance: "около ста тысяч", currency: "RUB" },
      { id: "s3", accountId: "ghost", month: "2026-02", balance: 5, currency: "RUB" },
      { id: "", accountId: "a", month: "2026-03", balance: 7, currency: "RUB" },
      { id: "", accountId: "", month: "", balance: "" },        // truly blank: skipped
    ],
  });
  assert.equal(live(data.snapshots).length, 1);
  assert.equal(data.quarantine.length, 3, "unreadable, orphan and id-less rows must be kept aside");
  assert.ok(data.quarantine.every((q) => q.row && q.reason));
});

test("quarantined rows are written back to the sheet unchanged", async () => {
  const { buildValues } = await import("../src/lib/sheets.js");
  const data = normalize({
    accounts: [acc("a")],
    snapshots: [
      snap("s1", "a", "2026-01", 100),
      { id: "s2", accountId: "a", month: "2026-02", balance: "≈100k", currency: "RUB", updatedAt: "x" },
    ],
  });
  const rows = buildValues(data).snapshots;
  const written = rows.slice(1);
  assert.equal(written.length, 2, "the unreadable row must still be written");
  assert.ok(written.some((r) => r[0] === "s2" && r[3] === "≈100k"), "and byte-for-byte as it was read");
});

test("a v2 payload whose version marker is missing is not re-migrated as v1", () => {
  const v2 = build([acc("inv", { type: "investment" })], [
    snap("s1", "inv", "2026-01", 1000, { contributed: 900, contribCurrency: "RUB" }),
  ]);
  // exactly what a sheet with a deleted Meta tab looks like
  const noVersion = { accounts: v2.accounts, snapshots: v2.snapshots, rates: [] };
  assert.equal(detectVersion(noVersion), 2);
  const r = ensureV2(noVersion, T);
  assert.equal(r.migrated, false);
  assert.equal(r.data.snapshots[0].contributed, 900, "re-migrating would null every contribution");
});

test("a payload from a newer schema is reported instead of silently downgraded", () => {
  const r = ensureV2({ schemaVersion: 99, accounts: [], snapshots: [], rates: [] }, T);
  assert.equal(r.tooNew, true);
});

test("merge gives the same answer whichever side is called local", () => {
  const same = "2026-08-01T00:00:00Z";
  const a1 = build([acc("a")], [snap("s1", "a", "2026-01", 100, { updatedAt: same })]);
  const b1 = build([acc("a")], [snap("s1", "a", "2026-01", 200, { updatedAt: same })]);
  assert.equal(
    JSON.stringify(mergeData(a1, b1, T).snapshots),
    JSON.stringify(mergeData(b1, a1, T).snapshots),
    "an order-dependent merge makes two devices overwrite each other forever"
  );
  const r1 = build([acc("a")], [], [{ month: "2026-01", currency: "RUB", perUSD: 80, fetchedAt: "2026-02-01T00:00:00Z" }]);
  const r2 = build([acc("a")], [], [{ month: "2026-01", currency: "RUB", perUSD: 95, fetchedAt: "2026-01-01T00:00:00Z" }]);
  assert.equal(
    JSON.stringify(mergeData(r1, r2, T).rates),
    JSON.stringify(mergeData(r2, r1, T).rates)
  );
  assert.equal(mergeData(r1, r2, T).rates[0].perUSD, 95, "the earliest stamp wins on both devices");
});

test("a duplicate collapsed during merge is not tombstoned into the past", () => {
  const l = build([acc("a")], [{ ...snap("x", "a", "2026-01", 100), updatedAt: "" }]);
  const r = build([acc("a")], [{ ...snap("y", "a", "2026-01", 250), updatedAt: "" }]);
  const merged = mergeData(l, r, "2026-08-01T00:00:00.000Z");
  const dead = merged.snapshots.filter((s) => s.deletedAt);
  assert.equal(dead.length, 1);
  assert.equal(dead[0].deletedAt, "2026-08-01T00:00:00.000Z");
  // a Unix-epoch tombstone would be purged immediately and the duplicate would return
  assert.equal(purgeTombstones(merged, new Date("2026-08-02T00:00:00Z"), 180).snapshots.filter((s) => s.deletedAt).length, 1);
});

test("migration collapses a duplicated month before converting cumulative to delta", () => {
  const v1 = {
    accounts: [{ id: "inv", name: "I", type: "investment", currency: "RUB" }],
    snapshots: [
      { id: "a", accountId: "inv", month: "2026-01", balance: "100", invested: "100" },
      { id: "b", accountId: "inv", month: "2026-01", balance: "100", invested: "100" },  // duplicate row
      { id: "c", accountId: "inv", month: "2026-02", balance: "300", invested: "250" },
    ],
  };
  const { data } = migrateV1(v1, T);
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, { rates: { USD: 1, RUB: 80 } });
  assert.equal(costBasis(data, "inv", "2026-02", idx, ratesOf).amount, 250,
    "the duplicate must not turn January's contribution into 0");
});

test("an unknown currency is not silently turned into roubles", () => {
  const data = normalize({
    accounts: [acc("a", { currency: "XYZ" })],
    snapshots: [snap("s1", "a", "2026-01", 100, { currency: "XYZ" })],
  });
  assert.equal(data.accounts[0].currency, "XYZ");
  const idx = snapshotIndex(data);
  const t = monthTotal(data, "2026-01", "RUB", { USD: 1, RUB: 80 }, idx);
  assert.equal(t.total, 0);
  assert.equal(t.unconverted.length, 1, "it must fail loudly, not be counted as 100 roubles");
  // and a currency that is merely untidy still works
  assert.equal(normalize({ accounts: [acc("b", { currency: " usd " })], snapshots: [] }).accounts[0].currency, "USD");
});

test("migrateV1 survives a null row", () => {
  const { data } = migrateV1({ accounts: [null, { id: "a", name: "A", type: "cash", currency: "RUB" }], snapshots: [null, { id: "s", accountId: "a", month: "2026-01", balance: "5" }] }, T);
  assert.equal(data.accounts.length, 1);
  assert.equal(live(data.snapshots).length, 1);
});

test("migration repairs the skipped-month reset instead of encoding it as a withdrawal", () => {
  // The exact corruption v1 produced: Jan cumulative 100000, February never
  // recorded, so March's save wrote 0 + 10000 = 10000 as the "cumulative".
  const v1 = {
    accounts: [{ id: "inv", name: "Брокер", type: "investment", currency: "RUB" }],
    snapshots: [
      { id: "1", accountId: "inv", month: "2026-01", balance: "105000", invested: "100000" },
      { id: "3", accountId: "inv", month: "2026-03", balance: "118000", invested: "10000" },
    ],
  };
  const { data, repairedGaps } = migrateV1(v1, T);
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, { rates: { USD: 1, RUB: 80 } });
  assert.equal(costBasis(data, "inv", "2026-03", idx, ratesOf).amount, 110000);
  assert.equal(pnlFor(data, data.accounts[0], "2026-03", idx, ratesOf).pnl, 8000);
  // reading 10000 as a cumulative would have produced contributed = -90000
  assert.equal(data.snapshots.find((s) => s.month === "2026-03").contributed, 10000);
  assert.equal(repairedGaps.length, 1);
  assert.equal(repairedGaps[0].month, "2026-03");
});

test("migrated records lose ties to any later real edit", () => {
  const v1 = { accounts: [{ id: "a", name: "A", type: "cash", currency: "RUB" }],
               snapshots: [{ id: "s", accountId: "a", month: "2026-01", balance: "10" }] };
  const migrated = migrateV1(v1).data;                    // no explicit stamp
  assert.equal(migrated.snapshots[0].updatedAt, "2000-01-01T00:00:00.000Z");
  const edited = build([acc("a")], [snap("s", "a", "2026-01", 999, { updatedAt: "2026-08-01T00:00:00Z" })]);
  assert.equal(mergeData(migrated, edited, T).snapshots[0].balance, 999);
  assert.equal(mergeData(edited, migrated, T).snapshots[0].balance, 999);
});
