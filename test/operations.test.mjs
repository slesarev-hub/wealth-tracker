import { test } from "node:test";
import assert from "node:assert/strict";

import { planImport, normalizeOperation, hashKey, fingerprintKey, OPERATION_HEADER, operationToRow } from "../src/lib/operations.js";

const op = (fields) => ({ accountId: "acc-1", currency: "UZS", kind: "purchase", description: "", ...fields });

test("an operation with a bank reference is imported once across overlapping statements", () => {
  const october = [op({ ref: "031943689054", amount: -865570, date: "2026-10-08T17:09:41" })];
  const first = planImport([], october);
  assert.equal(first.added.length, 1);
  const again = planImport(first.added, [...october, op({ ref: "031945221027", amount: -137000, date: "2026-11-18" })]);
  assert.equal(again.added.length, 1);
  assert.equal(again.duplicates, 1);
  assert.equal(again.added[0].ref, "031945221027");
});

test("a reversal with the same reference but the opposite amount is kept", () => {
  const purchase = op({ ref: "R1", amount: -5000, date: "2026-11-01" });
  const reversal = op({ ref: "R1", amount: 5000, date: "2026-11-02" });
  assert.equal(planImport([], [purchase, reversal]).added.length, 2);
});

test("identical operations without a reference on one day stay separate", () => {
  const coffee = op({ amount: -25000, date: "2026-11-05", description: "Списание COFFEE" });
  const first = planImport([], [coffee, coffee]);
  assert.equal(first.added.length, 2);
  assert.notEqual(first.added[0].id, first.added[1].id);
});

test("a later statement adds only the occurrences the earlier one did not have", () => {
  const coffee = op({ amount: -25000, date: "2026-11-05", description: "Списание COFFEE" });
  const first = planImport([], [coffee]);
  const second = planImport(first.added, [coffee, coffee, coffee]);
  assert.equal(second.added.length, 2);
  assert.equal(second.duplicates, 1);
});

test("the fingerprint ignores the card mask and punctuation", () => {
  const a = op({ amount: -1, date: "2026-11-05", description: "IPS: 111514 ... 561468******4491" });
  const b = op({ amount: -1, date: "2026-11-05T15:23:18", description: "IPS 111514" });
  assert.equal(fingerprintKey(a), fingerprintKey(b));
});

test("a deleted operation is not brought back by a re-import", () => {
  const purchase = op({ ref: "R9", amount: -100, date: "2026-11-01" });
  const [stored] = planImport([], [purchase]).added;
  const deleted = { ...stored, deletedAt: "2026-11-20T00:00:00Z" };
  assert.equal(planImport([deleted], [purchase]).added.length, 0);
});

test("ids are stable and 16 hex characters", () => {
  assert.equal(hashKey("x"), hashKey("x"));
  assert.match(hashKey("ref|acc|1|100"), /^[0-9a-f]{16}$/);
});

test("rows round-trip through the sheet shape", () => {
  const [stored] = planImport([], [op({ ref: "R2", amount: -12.5, date: "2026-11-01", currency: "USD", counterAccountId: "cash-1" })]).added;
  const row = operationToRow(stored);
  assert.equal(row.length, OPERATION_HEADER.length);
  const back = normalizeOperation(Object.fromEntries(OPERATION_HEADER.map((name, i) => [name, row[i]])));
  assert.equal(back.amount, -12.5);
  assert.equal(back.counterAccountId, "cash-1");
  assert.equal(back.kind, "purchase");
});

test("a row without an id or amount is rejected and an unknown kind becomes other", () => {
  assert.equal(normalizeOperation({ accountId: "a", amount: 1 }), null);
  assert.equal(normalizeOperation({ id: "x", accountId: "a", amount: "abc" }), null);
  assert.equal(normalizeOperation({ id: "x", accountId: "a", amount: "5", kind: "weird" }).kind, "other");
});
