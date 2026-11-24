import { test } from "node:test";
import assert from "node:assert/strict";

import { institutionOf, shortName, accountLabel, institutionsFor } from "../src/lib/institutions.js";
import { groupOf, flowOf, dayOf, pairOwnTransfers, spendingByMonth, mergeMonths, opTitle, dailySeries, dailyCap } from "../src/lib/spending.js";
import { snapshotIndex } from "../src/lib/calc.js";
import { reconcileMonths } from "../src/lib/reconcile.js";
import { attributeCash } from "../src/lib/cash.js";

const acc = (fields) => ({ id: fields.name, type: "checking", currency: "RUB", openedMonth: "", closedMonth: "", institution: "", deletedAt: "", ...fields });
const op = (fields) => ({
  id: String(Math.random()), accountId: "a", date: "2026-11-10", amount: -100, currency: "RUB", kind: "purchase",
  category: "", merchant: "", description: "", note: "", counterAccountId: "", ...fields,
});
const flatRates = () => ({ table: { USD: 1, RUB: 80, UZS: 12000 } });

test("the institution is read from the name when the account does not name one", () => {
  assert.equal(institutionOf(acc({ name: "Газпромбанк" })), "Газпромбанк");
  assert.equal(institutionOf(acc({ name: "Тбанк Платинум" })), "Т-Банк");
  assert.equal(institutionOf(acc({ name: "Мама — вклад (Yandex Pay)" })), "Яндекс");
  assert.equal(institutionOf(acc({ name: "Кошелёк USD", type: "cash" })), "Наличные с собой");
  assert.equal(institutionOf(acc({ name: "под столом", type: "cash" })), "Наличные в заначках");
  assert.equal(institutionOf(acc({ name: "Залог за квартиру", type: "other" })), "Прочее");
  assert.equal(institutionOf(acc({ name: "Тбанк", institution: "Т-Банк (старый)" })), "Т-Банк (старый)");
});

test("inside its tile an account drops the institution from its name", () => {
  assert.equal(shortName(acc({ name: "Тбанк Платинум" }), "Т-Банк"), "Платинум");
  assert.equal(shortName(acc({ name: "Капиталбанк Uzcard *4491" }), "Капиталбанк"), "Uzcard *4491");
  assert.equal(shortName(acc({ name: "Газпромбанк" }), "Газпромбанк"), "");
  assert.equal(accountLabel(acc({ name: "Газпромбанк", type: "deposit" })), "Газпромбанк · вклад");
  assert.equal(accountLabel(acc({ name: "Yandex Pay Card" })), "Yandex Pay Card");
});

test("a tile sums its accounts at the month's rates, debts subtracting, stale balances carried", () => {
  const data = {
    accounts: [acc({ name: "Тбанк" }), acc({ name: "Тбанк Платинум", type: "debt" }), acc({ name: "Газпромбанк", currency: "USD" })],
    snapshots: [
      { id: "1", accountId: "Тбанк", month: "2026-11", balance: 1000, currency: "RUB", deletedAt: "" },
      { id: "2", accountId: "Тбанк Платинум", month: "2026-11", balance: 300, currency: "RUB", deletedAt: "" },
      { id: "3", accountId: "Газпромбанк", month: "2026-08", balance: 10, currency: "USD", deletedAt: "" },
    ],
  };
  const tiles = institutionsFor(data, "2026-11", "RUB", { USD: 1, RUB: 80 }, snapshotIndex(data));
  assert.deepEqual(tiles.map((t) => [t.institution, t.total]), [["Газпромбанк", 800], ["Т-Банк", 700]]);
  assert.equal(tiles[0].accounts[0].asOf, "2026-08");
});

test("bank categories fold into one list; a fee is a fee and unmarked cash is cash", () => {
  assert.equal(groupOf(op({ category: "Супермаркеты" })), "food");
  assert.equal(groupOf(op({ category: "Связь" })), "telecom");
  assert.equal(groupOf(op({ kind: "fee", category: "Подписка Газпром Бонус Премиум" })), "fees");
  assert.equal(groupOf(op({ kind: "cash", category: "Снятие наличных" })), "cash");
  assert.equal(groupOf(op({ kind: "transfer_out", category: "" })), "people");
  assert.equal(groupOf(op({ merchant: "SPORTMASTER SHOP 3" })), "shopping");
  assert.equal(groupOf(op({ description: "IPS: 92300383 Эмитент взаиморасчёты по безналичным операциям" })), "other");
  assert.equal(flowOf(op({ kind: "own_transfer" })), "own");
  assert.equal(flowOf(op({ kind: "transfer_in", amount: 5 })), "income");
});

test("money from other people is not income; a reimbursement cancels its purchase", () => {
  const ops = [
    op({ date: "2026-11-05", amount: 100000, kind: "income", category: "Зачисление зарплаты" }),
    op({ date: "2026-11-07", amount: 5000, kind: "transfer_in", category: "Переводы", merchant: "Друг" }),
    op({ date: "2026-11-11", amount: -90000, kind: "purchase", category: "За других" }),
    op({ date: "2026-11-11", amount: 90000, kind: "refund", category: "За других" }),
  ];
  const [november] = spendingByMonth(ops, "RUB", () => ({ table: { RUB: 1 } }));
  assert.equal(november.income, 100000);
  assert.equal(november.received, 5000);
  assert.equal(november.spend, 0);
  assert.equal(mergeMonths([november]).received, 5000);
});

test("a transfer the bank calls a transfer goes to its own group once it has a category", () => {
  assert.equal(groupOf(op({ kind: "transfer_out", category: "Финансовые операции", merchant: "А. К." })), "people");
  assert.equal(groupOf(op({ kind: "transfer_out", category: "Психолог", merchant: "А. К." })), "therapy");
});

test("a purchase made for others and its reimbursement cancel out in their own group", () => {
  const ops = [
    op({ id: "laptop", accountId: "visa", currency: "USD", amount: -1228.77, category: "За других", date: "2026-11-11" }),
    op({ id: "back", accountId: "gpb", kind: "refund", amount: 102000, category: "За других", date: "2026-11-11T11:14:00+03:00" }),
  ];
  const [m] = spendingByMonth(ops, "RUB", () => ({ table: { USD: 1, RUB: 82.5 } }));
  const group = m.groupList.find((g) => g.id === "forOthers");
  assert.ok(Math.abs(group.total - (1228.77 * 82.5 - 102000)) < 0.01);
  assert.equal(m.income, 0);
});

test("a bare date stays the bank's day; a UTC timestamp moves to the local day", () => {
  assert.equal(dayOf(op({ date: "2026-07-21T22:43:34+03:00" })), "2026-07-21");
  assert.equal(dayOf(op({ date: "2026-10-08T15:56:35" })), "2026-10-08");
  const utc = "2026-07-25T13:17:27.000Z";
  const d = new Date(utc);
  assert.equal(dayOf(op({ date: utc })), `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
});

test("an exchange pairs with the arrival of similar value, not merely the nearest one", () => {
  const out = op({ id: "out", accountId: "uzcard", currency: "UZS", amount: -360000, kind: "own_transfer", counterAccountId: "visa", date: "2026-11-12T10:00:00" });
  const wrong = op({ id: "wrong", accountId: "visa", currency: "USD", amount: 100, kind: "own_transfer", counterAccountId: "uzcard", date: "2026-11-12" });
  const right = op({ id: "right", accountId: "visa", currency: "USD", amount: 30, kind: "own_transfer", counterAccountId: "uzcard", date: "2026-11-13" });
  const valueOf = (o) => (o.currency === "USD" ? o.amount : o.amount / 12000);
  assert.equal(pairOwnTransfers([out, wrong, right], valueOf).get("out").id, "right");
});

test("spending leaves own transfers out and prices what the move cost", () => {
  const ops = [
    op({ id: "food", category: "Супермаркеты", amount: -800 }),
    op({ id: "refund", kind: "refund", category: "Супермаркеты", amount: 80 }),
    op({ id: "salary", kind: "income", amount: 8000 }),
    op({ id: "out", accountId: "rub", kind: "own_transfer", amount: -8400, counterAccountId: "usd", date: "2026-11-11T10:00:00" }),
    op({ id: "in", accountId: "usd", currency: "USD", kind: "own_transfer", amount: 100, counterAccountId: "rub", date: "2026-11-11" }),
  ];
  const [m] = spendingByMonth(ops, "RUB", flatRates);
  assert.equal(m.spend, 720);
  assert.equal(m.income, 8000);
  assert.equal(m.moved, 8400);
  assert.equal(m.moveCost, 400);
  assert.equal(m.movesPaired, 1);
  assert.deepEqual(m.groupList.map((g) => [g.id, g.total]), [["food", 720]]);
  const all = mergeMonths([m, m]);
  assert.equal(all.spend, 1440);
});

test("a Капиталбанк processing record reads as the kind of payment and its terminal", () => {
  assert.equal(opTitle(op({ description: "IPS: 92300383 Эмитент взаиморасчёты по безналичным операциям с применением ПК … 8200.1.spisanie" })), "Терминал 92300383");
  assert.equal(opTitle(op({ description: "UzCard: Перевод с UZCARD КB на UZCARD OB через МП ТЕR.ID 91105496; за ;" })), "Перевод с UZCARD КB на UZCARD OB");
  assert.equal(opTitle(op({ merchant: "TD REAL 76", description: "Супермаркеты" })), "TD REAL 76");
});

test("merchants without a bank category land in a group by name", () => {
  assert.equal(groupOf(op({ merchant: "ANTHROPIC* CLAUDE SUB" })), "software");
  assert.equal(groupOf(op({ merchant: "OPENAI *CHATGPT SUBSCR" })), "software");
  assert.equal(groupOf(op({ merchant: "UCELL MIRZO ULUGBEK" })), "telecom");
  assert.equal(groupOf(op({ merchant: "MIGROS-5M ANTALYA" })), "food");
  assert.equal(groupOf(op({ merchant: "LOCALRENT.COM" })), "travel");
  assert.equal(groupOf(op({ merchant: "SEYFI ARIKAN SAHA PETROL" })), "car");
  assert.equal(groupOf(op({ merchant: "CHECHIL PUB BAR" })), "cafe");
  assert.equal(groupOf(op({ merchant: "BEAUTYMANIA SHOP" })), "shopping");
  assert.equal(groupOf(op({ merchant: "Barbershop" })), "other");
  assert.equal(groupOf(op({ merchant: "WENDY S", description: "Списание по операциям покупке WENDY S SLIP No 131932" })), "cafe");
  assert.equal(groupOf(op({ merchant: "BAHANDI FAST FOOD" })), "cafe");
  assert.equal(groupOf(op({ merchant: "Netflix.com" })), "services");
  assert.equal(groupOf(op({ merchant: "ALATAU 1 STATION" })), "transport");
  assert.equal(groupOf(op({ merchant: "Маркет", amount: 2882, kind: "refund" })), "other", "a Yandex Market refund is not a grocery");
  assert.equal(groupOf(op({ merchant: "EPGU GAZPROMPAY", category: "Прочие расходы" })), "docs");
  // The bank's own category still wins over the name.
  assert.equal(groupOf(op({ merchant: "ANTHROPIC", category: "Супермаркеты" })), "food");
});

test("spending by day keeps quiet days as zeros and spans month edges", () => {
  const ops = [
    op({ date: "2026-10-31", amount: -300, merchant: "Пятёрочка" }),
    op({ date: "2026-11-02", amount: -100, merchant: "Пятёрочка" }),
    op({ date: "2026-11-02", amount: -50, category: "Кафе" }),
    op({ date: "2026-11-02", amount: 20, kind: "refund", category: "Кафе" }),
    op({ date: "2026-11-03", amount: 5000, kind: "income" }),
  ];
  const months = spendingByMonth(ops, "RUB", () => ({ table: { RUB: 1 } }));
  const november = months.find((m) => m.month === "2026-11");
  const series = dailySeries(november.days, "2026-11-01", "2026-11-04");
  assert.deepEqual(series.map((d) => d.spend), [0, 130, 0, 0]);
  assert.equal(series[1].ops[0].value, 100, "the biggest purchase of the day comes first");
  const all = mergeMonths(months);
  assert.deepEqual(dailySeries(all.days, "2026-10-30", "2026-11-02").map((d) => d.spend), [0, 300, 0, 130]);
});

test("one huge day cuts the daily axis; an even month does not", () => {
  const usual = [100, 120, 90, 80, 150, 110, 95, 130, 105, 115];
  assert.equal(dailyCap(usual), null);
  const cap = dailyCap([...usual, 800000]);
  assert.ok(cap > 150 && cap < 1000, `cap ${cap}`);
  assert.equal(dailyCap([0, 0, 500000]), null, "too few spending days to call anything an outlier");
});

test("the gap between operations and capital shows money that went past the operations", () => {
  const account = (id, type = "checking") => ({ id, name: id, type, currency: "RUB", openedMonth: "", closedMonth: "", institution: "", deletedAt: "" });
  const snap = (accountId, month, balance) => ({ id: `${accountId}-${month}`, accountId, month, balance, currency: "RUB", deletedAt: "" });
  const data = {
    accounts: [account("card"), account("stash", "cash"), account("loan", "debt")],
    snapshots: [snap("card", "2026-10", 1000), snap("card", "2026-11", 1500), snap("stash", "2026-10", 200), snap("stash", "2026-11", 500),
      snap("loan", "2026-10", 100), snap("loan", "2026-11", 100)],
  };
  const ops = [
    op({ accountId: "card", date: "2026-11-05", amount: 1000, kind: "income" }),
    op({ accountId: "card", date: "2026-11-06", amount: -500, kind: "cash" }),
  ];
  const rates = () => ({ table: { RUB: 1 } });
  const months = spendingByMonth(ops, "RUB", rates);
  const [november] = reconcileMonths(data, months, "RUB", rates, snapshotIndex(data), new Set(["card"]));
  assert.equal(november.month, "2026-11");
  assert.equal(november.byOps, 500);
  assert.equal(november.delta, 800);
  assert.equal(november.gap, 300, "the cash went into the stash, not into spending");
  assert.deepEqual(november.moved.map((x) => [x.acc.id, x.change]), [["stash", 300]]);
});

test("withdrawn cash is spending only beyond what turned up in stashes or was paid in", () => {
  const account = (id, type = "checking") => ({ id, name: id, type, currency: "RUB", openedMonth: "", closedMonth: "", institution: "", deletedAt: "" });
  const snap = (accountId, month, balance) => ({ id: `${accountId}-${month}`, accountId, month, balance, currency: "RUB", deletedAt: "" });
  const data = {
    accounts: [account("card"), account("stash", "cash"), account("wallet", "cash"), account("broker", "investment")],
    snapshots: [
      snap("card", "2026-06", 0), snap("stash", "2026-06", 100), snap("wallet", "2026-06", 0), snap("broker", "2026-06", 0),
      snap("stash", "2026-07", 140), snap("stash", "2026-08", 140), snap("broker", "2026-08", 500), snap("wallet", "2026-09", 70),
    ],
  };
  const ops = [
    op({ accountId: "card", date: "2026-07-05", amount: -100, kind: "cash" }),
    op({ accountId: "card", date: "2026-08-05", amount: -100, kind: "cash" }),
    op({ accountId: "card", date: "2026-08-20", amount: 30, kind: "own_transfer", category: "Внесение наличных" }),
    op({ accountId: "card", date: "2026-08-21", amount: -20, kind: "purchase", category: "Супермаркеты" }),
  ];
  const rates = () => ({ table: { RUB: 1 } });
  const months = attributeCash(spendingByMonth(ops, "RUB", rates), data, ops, "RUB", rates);
  const [july, august] = months;
  // July: the stash grew by 40 that month. August: 30 paid back into the card; the broker's growth is the
  // market, not cash. The wallet, recorded in September after nothing since June, holds 70 more: it takes,
  // oldest first, the 60 July still counts as spent and 10 of August's.
  assert.equal(july.cashSaved, 40 + 60);
  assert.equal(july.spend, 0);
  assert.equal(july.groups.get("cash").total, 0);
  assert.equal(august.cashSaved, 30 + 10);
  assert.equal(august.spend, 20 + 60);
  assert.deepEqual(july.cashSources.map((x) => [x.label, x.amount]), [["stash", 40], ["wallet (остаток записан за 2026-09)", 60]]);

  // A broker top-up its own history shows, with no source among the banks, is where cash may have gone too.
  const brokerOps = [...ops, op({ accountId: "broker", date: "2026-08-25", amount: 50, kind: "own_transfer", description: "Пополнение" })];
  const withTopUp = attributeCash(spendingByMonth(brokerOps, "RUB", rates), { ...data, snapshots: data.snapshots.filter((x) => x.accountId !== "wallet") }, brokerOps, "RUB", rates);
  assert.equal(withTopUp[1].cashSaved, 30 + 50);
});
