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
  assert.equal(other.members.length, 9 - MAX_SLICES);
  assert.ok(Math.abs(other.value - other.members.reduce((x, m) => x + m.value, 0)) < 1e-9);
  assert.ok(s.byAccount.slice(0, MAX_SLICES).every((x, i) => x.slot === i), "slots are the documented order");
  assert.equal(other.slot, null, "the tail is not a hue");
});

test("a single leftover keeps its own name and its own fields", () => {
  const n = MAX_SLICES + 1;
  const accounts = Array.from({ length: n }, (_, i) => acc("a" + i, { name: "Счёт " + i }));
  const data = build(accounts, accounts.map((a, i) => snap("s" + i, a.id, "2026-01", 100 - i)));
  const s = structureFor(data, "2026-01", "RUB", makeRatesOf(data, R), snapshotIndex(data));
  const last = s.byAccount[MAX_SLICES];
  assert.ok(last.label.startsWith("Счёт " + (n - 1)), last.label);
  assert.equal(last.members, undefined, "one leftover is not a group");
  assert.ok(last.icon, "and it keeps the fields a normal slice has");
});

test("a currency folded out of the ring keeps its native amount", () => {
  const cur = ["RUB", "USD", "EUR", "GBP", "AED", "BTC", "ETH"].slice(0, MAX_SLICES + 1);
  const accounts = cur.map((c, i) => acc("a" + i, { currency: c }));
  const data = build(accounts, accounts.map((a, i) => snap("s" + i, a.id, "2026-01", 1000 - i * 100, { currency: cur[i] })));
  const s = structureFor(data, "2026-01", "RUB", makeRatesOf(data, { rates: { USD: 1, RUB: 80, EUR: 0.9, GBP: 0.8, AED: 3.67, BTC: 1e-5, ETH: 1e-4 } }), snapshotIndex(data));
  const folded = s.byCurrency[MAX_SLICES];
  assert.equal(folded.members, undefined);
  assert.equal(typeof folded.native, "number", "the sixth currency must still show how much of it there is");
});

test("accounts that share a name are told apart", () => {
  const data = build(
    [acc("a", { name: "Газпромбанк", type: "deposit" }), acc("b", { name: "Газпромбанк", type: "investment" }), acc("c", { name: "Тбанк" })],
    [snap("s1", "a", "2026-01", 300), snap("s2", "b", "2026-01", 200), snap("s3", "c", "2026-01", 100)]
  );
  const s = structureFor(data, "2026-01", "RUB", makeRatesOf(data, R), snapshotIndex(data));
  const labels = s.byAccount.map((x) => x.label);
  assert.equal(new Set(labels).size, labels.length, "two rows reading «Газпромбанк» with different amounts is unreadable");
  assert.ok(labels.some((l) => l.includes("Вклад")));
  assert.equal(labels.filter((l) => l.startsWith("Тбанк")).length, 1);
  assert.ok(labels.every((l) => l.includes(" · ")), "every row says what kind of account it is");
});

test("a negative balance on an asset account does not create a share above 100%", () => {
  const data = build(
    [acc("ok"), acc("neg")],
    [snap("s1", "ok", "2026-01", 1000), snap("s2", "neg", "2026-01", -400)]
  );
  const s = structureFor(data, "2026-01", "RUB", makeRatesOf(data, R), snapshotIndex(data));
  assert.equal(s.assets, 1000);
  assert.equal(s.liabilities, 400);
  assert.equal(s.net, 600);
  assert.ok(s.byAccount.every((x) => x.share > 0 && x.share <= 1));
  assert.ok(Math.abs(s.byAccount.reduce((x, c) => x + c.share, 0) - 1) < 1e-9);
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

test("a non-rouble account carries its own currency and amount", () => {
  const data = build(
    [acc("eur", { name: "тумба у окна", type: "cash", currency: "EUR" }), acc("rub", { name: "под столом", type: "cash" })],
    [snap("s1", "eur", "2026-01", 2400, { currency: "EUR" }), snap("s2", "rub", "2026-01", 5000)]
  );
  const s = structureFor(data, "2026-01", "RUB", makeRatesOf(data, { rates: { USD: 1, RUB: 80, EUR: 0.9 } }), snapshotIndex(data));
  const eur = s.accountRows.find((x) => x.key === "eur");
  assert.equal(eur.currency, "EUR");
  assert.equal(eur.native, 2400, "a rouble figure alone says nothing about the account being in euro");
  // Every row states its instrument, so no row is left looking unlabelled
  // next to one that carries a suffix only because its name is duplicated.
  assert.equal(eur.label, "тумба у окна · Наличные");
  assert.ok(!eur.label.includes("EUR"), "the currency lives in the amount column, not the name");
});

test("the currency is only appended when the type does not tell two accounts apart", () => {
  const data = build(
    [
      acc("a", { name: "У родителей", type: "cash", currency: "EUR" }),
      acc("b", { name: "У родителей", type: "cash", currency: "USD" }),
      acc("c", { name: "Газпромбанк", type: "deposit" }),
      acc("d", { name: "Газпромбанк", type: "investment" }),
    ],
    [snap("s1", "a", "2026-01", 100, { currency: "EUR" }), snap("s2", "b", "2026-01", 100, { currency: "USD" }),
     snap("s3", "c", "2026-01", 300), snap("s4", "d", "2026-01", 400)]
  );
  const s = structureFor(data, "2026-01", "RUB", makeRatesOf(data, { rates: { USD: 1, RUB: 80, EUR: 0.9 } }), snapshotIndex(data));
  const by = Object.fromEntries(s.accountRows.map((x) => [x.key, x.label]));
  assert.equal(by.c, "Газпромбанк · Вклад", "the type already distinguishes these");
  assert.equal(by.d, "Газпромбанк · Инвестиции");
  assert.equal(by.a, "У родителей · Наличные EUR", "same name AND same type needs the currency too");
  assert.equal(by.b, "У родителей · Наличные USD");
  const labels = s.accountRows.map((x) => x.label);
  assert.equal(new Set(labels).size, labels.length);
});

test("a slice knows which accounts it is made of", () => {
  const data = build(
    [
      acc("c1", { name: "под столом", type: "cash" }),
      acc("c2", { name: "тумба", type: "cash", currency: "EUR" }),
      acc("d1", { name: "вклад", type: "deposit" }),
    ],
    [
      snap("s1", "c1", "2026-01", 5000), snap("s2", "c2", "2026-01", 100, { currency: "EUR" }),
      snap("s3", "d1", "2026-01", 3000),
    ]
  );
  const s = structureFor(data, "2026-01", "RUB", makeRatesOf(data, R), snapshotIndex(data));
  const cash = s.byType.find((x) => x.label.startsWith("Наличные"));
  assert.equal(cash.parts.length, 2);
  // 100 € converts to ~8 889 ₽, which beats 5 000 ₽ — the order is by the
  // rouble value, not by the raw number typed in.
  assert.deepEqual(cash.parts.map((p) => p.accountId), ["c2", "c1"], "biggest first, in roubles");
  assert.equal(cash.parts[0].native, 100);
  assert.equal(cash.parts[0].currency, "EUR");
  assert.ok(Math.abs(cash.parts.reduce((x, p) => x + p.value, 0) - cash.value) < 1e-6,
    "the parts must add up to the slice they belong to");

  const eur = s.byCurrency.find((x) => (x.ofKey || x.key) === "EUR");
  assert.equal(eur.parts.length, 1);
  assert.equal(eur.parts[0].accountId, "c2");
});

test("a folded slice lists the accounts of everything inside it", () => {
  const cur = ["RUB", "USD", "EUR", "GBP", "AED", "BTC", "ETH"];
  const accounts = cur.map((c, i) => acc("a" + i, { currency: c, name: "acc" + i }));
  const data = build(accounts, accounts.map((a, i) => snap("s" + i, a.id, "2026-01", 1000 - i * 100, { currency: cur[i] })));
  const s = structureFor(data, "2026-01", "RUB",
    makeRatesOf(data, { rates: { USD: 1, RUB: 80, EUR: 0.9, GBP: 0.8, AED: 3.67, BTC: 1e-5, ETH: 1e-4 } }), snapshotIndex(data));
  const other = s.byCurrency[s.byCurrency.length - 1];
  assert.ok(other.parts.length >= 1);
  assert.ok(Math.abs(other.parts.reduce((x, p) => x + p.value, 0) - other.value) < 1e-6);
});
