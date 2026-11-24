// Do the operations add up to what the capital did?
//
// For every month that has balances and whose previous month has them too:
//   by operations — income + money from people − spending − what own moves cost
//   capital       — how much the sum of all balances changed
// Both months are priced at the later month's rates, so a rouble that merely
// got cheaper is not mistaken for money spent or earned.
//
// The two agree when every rouble that left is recorded where it went. The gap
// says how much is not: cash withdrawn and counted as spending that went into a
// stash, salary from an account outside the record, a stash whose balance is
// old, securities that grew. The accounts without operations whose balance
// moved are where such money shows up, so they are listed with the gap.

import { accountsInMonth, convert, monthsOf } from "./calc.js";
import { balSign } from "./model.js";

const previousMonth = (month) => {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

// `months` is spendingByMonth's output in `currency`; `withOps` is the set of
// account ids that have any operation at all.
export const reconcileMonths = (data, months, currency, ratesOf, idx, withOps) => {
  const recorded = new Set(monthsOf(data));
  const out = [];
  for (const m of months) {
    const prev = previousMonth(m.month);
    if (!recorded.has(m.month) || !recorded.has(prev)) continue;
    const table = ratesOf(m.month).table;
    const balances = (month) => {
      const map = new Map();
      for (const { acc, snap, carried } of accountsInMonth(data, month, idx)) {
        const value = convert(snap.balance, snap.currency, currency, table);
        if (Number.isFinite(value)) map.set(acc.id, { acc, value: value * balSign(acc), carried });
      }
      return map;
    };
    const before = balances(prev);
    const after = balances(m.month);
    let delta = 0, deltaWithOps = 0, deltaWithoutOps = 0;
    const moved = [];
    const carried = [];
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const change = (after.get(id)?.value || 0) - (before.get(id)?.value || 0);
      const acc = (after.get(id) || before.get(id)).acc;
      delta += change;
      if (withOps.has(id)) deltaWithOps += change;
      else {
        deltaWithoutOps += change;
        if (Math.abs(change) >= 0.5) moved.push({ acc, change });
      }
      if (after.get(id)?.carried && !withOps.has(id)) carried.push(acc);
    }
    const byOps = m.income + m.received - m.spend - m.moveCost;
    out.push({
      month: m.month, byOps, delta, gap: delta - byOps, deltaWithOps, deltaWithoutOps,
      moved: moved.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)), carried,
    });
  }
  return out;
};
