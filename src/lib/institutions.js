// Which bank or organisation holds an account, and what each one holds.
//
// An account may name its institution explicitly (the optional `institution`
// column). Most accounts never did — they were created before the column
// existed — so the name is read instead: a known bank anywhere in the name
// wins ("Мама — вклад (Yandex Pay)" is a Yandex account), cash is grouped by
// where it lies, and anything else is its own organisation under its own name.

import { convert, effectiveSnapshot } from "./calc.js";
import { live, balSign, ACCOUNT_TYPES } from "./model.js";

const KNOWN = [
  [/газпромбанк|\bгпб\b/i, "Газпромбанк"],
  [/т-?банк|тинькофф/i, "Т-Банк"],
  [/капиталбанк|kapital/i, "Капиталбанк"],
  [/yandex|яндекс/i, "Яндекс"],
  [/альфа|alfa/i, "Альфа-Банк"],
  [/\bбкс\b|\bbcs\b/i, "БКС"],
  [/bakai|бакай/i, "Bakai Bank"],
  [/\bвтб\b|\bvtb\b/i, "ВТБ"],
  [/\bсбер|\bsber/i, "Сбербанк"],
  [/озон|\bozon\b/i, "Озон Банк"],
  [/\bотп\b|\botp\b/i, "ОТП Банк"],
  [/unired/i, "Unired"],
  [/uzum/i, "Uzum Bank"],
  [/bitpapa/i, "bitpapa"],
];

export const CASH_WITH_ME = "Наличные с собой";
export const CASH_STASHED = "Наличные в заначках";
export const OTHER_INSTITUTION = "Прочее";

export const institutionOf = (acc) => {
  const explicit = String(acc?.institution ?? "").trim();
  if (explicit) return explicit;
  const name = String(acc?.name ?? "");
  for (const [re, label] of KNOWN) if (re.test(name)) return label;
  if (acc?.type === "cash") return /кошел[её]к/i.test(name) ? CASH_WITH_ME : CASH_STASHED;
  if (acc?.type === "other") return OTHER_INSTITUTION;
  return name.split(/\s+[—–-]\s+|\s+/)[0] || OTHER_INSTITUTION;
};

// The account's name without the institution in front of it: inside the
// «Газпромбанк» tile, «Газпромбанк» alone says nothing, so the type is shown.
export const shortName = (acc, institution) => {
  const name = String(acc?.name ?? "").trim();
  const head = name.toLowerCase();
  const inst = institution.toLowerCase();
  const variants = [inst, inst.replace(/-/g, ""), inst.split(/[\s-]/)[0]];
  for (const v of variants) {
    if (v && head.startsWith(v)) {
      const rest = name.slice(v.length).replace(/^[\s—–:-]+/, "").trim();
      return rest;
    }
  }
  return name;
};

// One tile per institution: every open account with the balance in effect for
// `month` (carried forward from its last record if that month has none),
// converted with that month's rates. Debts subtract. Tiles are ordered by
// what they hold, biggest first.
export const institutionsFor = (data, month, toCurrency, table, idx) => {
  const groups = new Map();
  for (const acc of live(data.accounts || [])) {
    if (acc.closedMonth && acc.closedMonth < month) continue;
    const institution = institutionOf(acc);
    if (!groups.has(institution)) groups.set(institution, { institution, total: 0, accounts: [], unconverted: 0, latest: "" });
    const g = groups.get(institution);
    const eff = effectiveSnapshot(idx, acc.id, month);
    const balance = eff ? eff.snap.balance : null;
    const currency = eff ? eff.snap.currency : acc.currency;
    const value = balance === null ? null : convert(balance, currency, toCurrency, table) * balSign(acc);
    if (balance !== null && !Number.isFinite(value)) g.unconverted += 1;
    if (Number.isFinite(value)) g.total += value;
    if (eff && eff.snap.month > g.latest) g.latest = eff.snap.month;
    g.accounts.push({ acc, balance, currency, value: Number.isFinite(value) ? value : null, asOf: eff ? eff.snap.month : null });
  }
  const list = [...groups.values()];
  for (const g of list) g.accounts.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  list.sort((a, b) => b.total - a.total);
  const gross = list.reduce((s, g) => s + Math.max(g.total, 0), 0);
  for (const g of list) g.share = gross > 0 ? Math.max(g.total, 0) / gross : 0;
  return list;
};

// How an account is named outside its tile: «Газпромбанк · вклад»,
// «Капиталбанк · Uzcard *4491», or the account's own name when the
// institution is not part of it («Yandex Pay Card», «Кошелёк USD»).
export const accountLabel = (acc) => {
  if (!acc) return "?";
  const inst = institutionOf(acc);
  const rest = shortName(acc, inst);
  if (rest === "") return `${inst} · ${(ACCOUNT_TYPES.find((t) => t.id === acc.type)?.label || acc.type).toLowerCase()}`;
  if (rest === acc.name) return acc.name;
  return `${inst} · ${rest}`;
};
