// Composition of one month, and the rules the ring depends on. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalize, SCHEMA_VERSION } from "../src/lib/model.js";
import { makeRatesOf, snapshotIndex } from "../src/lib/calc.js";
import { structureFor, MAX_SLICES, OTHER_KEY } from "../src/lib/structure.js";

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
const R = { rates: { USD: 1, RUB: 80, EUR: 0.9, BTC: 1 / 100000 } };

test("shares are of the assets and add up to one", () => {
  const data = build(
    [acc("r"), acc("u", { currency: "USD" })],
    [snap("s1", "r", "2026-01", 8000), snap("s2", "u", "2026-01", 100, { currency: "USD" })]
  );
  const s = structureFor(data, "2026-01", "RUB", makeRatesOf(data, R), snapshotIndex(data));
  assert.equal(s.assets, 16000);
  assert.equal(s.byCurrency.length, 2);
  assert.ok(Math.abs(s.byCurrency.reduce((x, c) => x + c.share, 0) - 1) < 1e-9);
  assert.deepEqual(s.byCurrency.map((c) => c.key), ["RUB", "USD"]);
  assert.equal(s.byCurrency[0].native, 8000);
});

test("a debt is never a slice — a share of a whole cannot be negative", () => {
  const data = build(
    [acc("cash"), acc("loan", { type: "debt" })],
    [snap("s1", "cash", "2026-01", 1000), snap("s2", "loan", "2026-01", 400)]
  );
  const s = structureFor(data, "2026-01", "RUB", makeRatesOf(data, R), snapshotIndex(data));
  assert.equal(s.assets, 1000);
  assert.equal(s.liabilities, 400);
  assert.equal(s.net, 600);
  assert.ok(s.byType.every((x) => x.value > 0));
  assert.ok(!s.byType.some((x) => x.key === "debt"));
  assert.ok(Math.abs(s.byType.reduce((x, c) => x + c.share, 0) - 1) < 1e-9);
});

test("the ring never needs a sixth hue: the tail folds into one neutral slice", () => {
  const accounts = Array.from({ length: 9 }, (_, i) => acc("a" + i));
  const snaps = accounts.map((a, i) => snap("s" + i, a.id, "2026-01", 1000 - i * 50));
  const data = build(accounts, snaps);
  const s = structureFor(data, "2026-01", "RUB", makeRatesOf(data, R), snapshotIndex(data));
  assert.equal(s.byAccount.length, MAX_SLICES + 1);
  const other = s.byAccount[s.byAccount.length - 1];
  assert.equal(other.key, OTHER_KEY);
  assert.equal(other.members.length, 4);
  assert.ok(Math.abs(other.value - other.members.reduce((x, m) => x + m.value, 0)) < 1e-9);
  assert.ok(s.byAccount.slice(0, MAX_SLICES).every((x, i) => x.slot === i), "slots are the documented order");
  assert.equal(other.slot, null, "the tail is not a hue");
});

test("a single leftover keeps its own name instead of becoming 'Остальное'", () => {
  const accounts = Array.from({ length: 6 }, (_, i) => acc("a" + i, { name: "Счёт " + i }));
  const data = build(accounts, accounts.map((a, i) => snap("s" + i, a.id, "2026-01", 100 - i)));
  const s = structureFor(data, "2026-01", "RUB", makeRatesOf(data, R), snapshotIndex(data));
  assert.equal(s.byAccount[MAX_SLICES].label, "Счёт 5");
});

test("changing the month never repaints a slice", () => {
  // In February the smaller account overtakes the larger one. Colour follows the
  // entity, so both months must give each account the same slot.
  const data = build(
    [acc("big"), acc("small")],
    [
      snap("b1", "big", "2026-01", 1000), snap("s1", "small", "2026-01", 100),
      snap("b2", "big", "2026-02", 100), snap("s2", "small", "2026-02", 5000),
    ]
  );
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, R);
  const jan = structureFor(data, "2026-01", "RUB", ratesOf, idx);
  const feb = structureFor(data, "2026-02", "RUB", ratesOf, idx);
  const slotOf = (s, key) => s.byAccount.find((x) => x.key === key).slot;
  assert.equal(slotOf(jan, "big"), slotOf(feb, "big"));
  assert.equal(slotOf(jan, "small"), slotOf(feb, "small"));
  assert.notEqual(slotOf(jan, "big"), slotOf(jan, "small"));
});

test("an account with no rate is excluded and named, not counted as zero", () => {
  const data = build(
    [acc("r"), acc("b", { currency: "TON", type: "crypto", name: "тон" })],
    [snap("s1", "r", "2026-01", 1000), snap("s2", "b", "2026-01", 5, { currency: "TON" })]
  );
  const s = structureFor(data, "2026-01", "RUB", makeRatesOf(data, R), snapshotIndex(data));
  assert.equal(s.assets, 1000);
  assert.equal(s.unconverted.length, 1);
  assert.equal(s.unconverted[0].name, "тон");
  assert.ok(!s.byCurrency.some((c) => c.key === "TON"));
});

test("each month is composed at its own stored rates", () => {
  const data = build(
    [acc("r"), acc("u", { currency: "USD" })],
    [
      snap("r1", "r", "2026-01", 8000), snap("u1", "u", "2026-01", 100, { currency: "USD" }),
      snap("r2", "r", "2026-02", 8000), snap("u2", "u", "2026-02", 100, { currency: "USD" }),
    ],
    [{ month: "2026-01", currency: "RUB", perUSD: 80, fetchedAt: T },
     { month: "2026-02", currency: "RUB", perUSD: 100, fetchedAt: T }]
  );
  const idx = snapshotIndex(data);
  const ratesOf = makeRatesOf(data, null);
  assert.equal(structureFor(data, "2026-01", "RUB", ratesOf, idx).assets, 16000);
  assert.equal(structureFor(data, "2026-02", "RUB", ratesOf, idx).assets, 18000);
});
