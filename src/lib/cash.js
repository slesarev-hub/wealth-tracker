// Cash taken out of a bank is not spending yet: it may have gone into a stash,
// been put into another bank, or carried a deposit. So unmarked withdrawals
// count as spending only to the extent the money did not turn up elsewhere.
//
// Where it turns up: the balances of accounts without operations (stashes,
// wallets, deposits and savings recorded by hand) growing more than the
// transfers recorded into them explain, and cash paid into an account that has
// operations (a deposit at an ATM is an own transfer without a second side).
// Securities and crypto count only through top-ups their own history shows
// (an own transfer in without a second side on such an account): their
// balance alone grows with the market.
//
// Per month:
//   saved = clamp(cash paid in + unexplained growth of those accounts, 0, withdrawn)
// A balance recorded only now after several months without a record (a wallet
// last written in June and next in November) may hold withdrawals from any of
// those months; such growth absorbs, oldest first, the withdrawals still
// counted as spending there.

import { convert } from "./calc.js";
import { dayOf } from "./spending.js";

const MARKET_TYPES = new Set(["investment", "crypto", "debt"]);
const CASH_IN = /наличн|банкомат|atm\b/i;

const previousMonth = (month) => {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

const monthsBetween = (from, to) => {
  const out = [];
  for (let month = to; month > from; month = previousMonth(month)) out.unshift(month);
  return out;
};

// Adjusts spendingByMonth's output in place and returns it: the «cash» group,
// spend and the days shrink by what was saved; each month gets cashWithdrawn,
// cashSaved and cashSources (where the saved part showed up).
export const attributeCash = (months, data, ops, currency, ratesOf) => {
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const value = (op) => convert(op.amount, op.currency, currency, ratesOf(dayOf(op).slice(0, 7)).table);
  const withOps = new Set(ops.map((op) => op.accountId));
  const pool = (data.accounts || []).filter((acc) => !acc.deletedAt && !withOps.has(acc.id) && !MARKET_TYPES.has(acc.type));
  const poolIds = new Set(pool.map((acc) => acc.id));

  const withdrawn = new Map();
  for (const m of months) {
    const cash = m.groups.get("cash");
    if (cash && cash.total > 0) withdrawn.set(m.month, cash.total);
  }
  if (!withdrawn.size) return months;

  // Cash paid into accounts with operations, and top-ups of securities and crypto accounts from no recorded
  // source, by month.
  const types = new Map((data.accounts || []).map((acc) => [acc.id, acc.type]));
  const paidIn = new Map();
  for (const op of ops) {
    if (op.kind !== "own_transfer" || op.amount <= 0 || op.counterAccountId) continue;
    const topUp = MARKET_TYPES.has(types.get(op.accountId)) && types.get(op.accountId) !== "debt";
    if (!topUp && !CASH_IN.test(`${op.category} ${op.description} ${op.merchant} ${op.note}`)) continue;
    const v = value(op);
    if (!Number.isFinite(v)) continue;
    const month = dayOf(op).slice(0, 7);
    paidIn.set(month, (paidIn.get(month) || 0) + v);
  }

  // Transfers recorded into (+) or out of (−) the accounts without operations.
  const recordedFlow = new Map();
  for (const op of ops) {
    if (op.kind !== "own_transfer" || !poolIds.has(op.counterAccountId)) continue;
    const v = value(op);
    if (!Number.isFinite(v)) continue;
    const list = recordedFlow.get(op.counterAccountId) || [];
    list.push({ month: dayOf(op).slice(0, 7), value: -v });
    recordedFlow.set(op.counterAccountId, list);
  }

  // Growth events of those accounts between two recorded balances.
  const firstRecorded = (data.snapshots || []).filter((s) => !s.deletedAt).map((s) => s.month).sort()[0];
  const events = [];
  for (const acc of pool) {
    const snaps = (data.snapshots || []).filter((s) => !s.deletedAt && s.accountId === acc.id).sort((a, b) => (a.month < b.month ? -1 : 1));
    snaps.forEach((snap, i) => {
      const prev = snaps[i - 1];
      if (!prev && snap.month === firstRecorded) return;
      const table = ratesOf(snap.month).table;
      const after = convert(snap.balance, snap.currency, currency, table);
      const before = prev ? convert(prev.balance, prev.currency, currency, table) : 0;
      if (!Number.isFinite(after) || !Number.isFinite(before)) return;
      const from = prev ? prev.month : previousMonth(snap.month);
      const flow = (recordedFlow.get(acc.id) || []).filter((f) => f.month > from && f.month <= snap.month).reduce((sum, f) => sum + f.value, 0);
      const growth = after - before - flow;
      if (Math.abs(growth) >= 0.5) events.push({ acc, from, to: snap.month, growth });
    });
  }

  const saved = new Map();
  const sources = new Map();
  const note = (month, label, amount) => {
    const list = sources.get(month) || [];
    list.push({ label, amount });
    sources.set(month, list);
  };
  // 1. Within the month: cash paid in plus growth recorded month to month (negative growth — a stash spent
  //    or emptied into a bank — offsets it).
  for (const [month, out] of withdrawn) {
    const single = events.filter((e) => e.to === month && e.from === previousMonth(month));
    const found = (paidIn.get(month) || 0) + single.reduce((sum, e) => sum + e.growth, 0);
    const take = Math.min(Math.max(found, 0), out);
    if (take <= 0) continue;
    saved.set(month, take);
    if (paidIn.get(month)) note(month, "внесено наличными на счета и пополнения бумаг/крипты", paidIn.get(month));
    for (const e of single) note(month, e.acc.name, e.growth);
  }
  // 2. Growth recorded after months without a record absorbs what is left of the withdrawals in those months.
  for (const e of events.filter((item) => item.growth > 0 && item.from !== previousMonth(item.to)).sort((a, b) => (a.to < b.to ? -1 : 1))) {
    let left = e.growth;
    for (const month of monthsBetween(e.from, e.to)) {
      if (left <= 0) break;
      const rest = (withdrawn.get(month) || 0) - (saved.get(month) || 0);
      if (rest <= 0) continue;
      const take = Math.min(rest, left);
      saved.set(month, (saved.get(month) || 0) + take);
      note(month, `${e.acc.name} (остаток записан за ${e.to})`, take);
      left -= take;
    }
  }

  for (const [month, out] of withdrawn) {
    const m = byMonth.get(month);
    const s = saved.get(month) || 0;
    m.cashWithdrawn = out;
    m.cashSaved = s;
    m.cashSources = sources.get(month) || [];
    if (s <= 0) continue;
    const cash = m.groups.get("cash");
    const keep = (out - s) / out;
    cash.total -= s;
    m.spend -= s;
    const entry = m.groupList.find((g) => g.id === "cash");
    if (entry) entry.total = cash.total;
    m.groupList.sort((a, b) => b.total - a.total);
    for (const d of m.days.values()) {
      for (const item of d.ops) {
        if (item.group !== "cash") continue;
        d.spend -= item.value * (1 - keep);
        item.value *= keep;
      }
    }
  }
  return months;
};
