// Data model, parsing, migration and merge for the wealth tracker.
//
// Storage schema v2. Differences from v1 that matter:
//   * snapshots store `contributed` — the MONTHLY amount added, not a running
//     cumulative. v1 stored the cumulative, which meant that editing or
//     skipping a month silently corrupted every later month's cost basis.
//   * snapshots carry their own `currency`, so changing an account's currency
//     no longer reinterprets history.
//   * `contribCurrency` records what the contribution was denominated in, so a
//     crypto account can have a fiat cost basis instead of a coin count.
//   * every record has `updatedAt` and an optional `deletedAt` tombstone, so
//     two devices can be merged instead of one silently overwriting the other.
//   * per-month FX rates are stored, so history is not revalued at today's rate.

export const SCHEMA_VERSION = 2;
export const BASE_CURRENCY = "RUB";

export const FIAT_CURRENCIES = ["RUB", "USD", "EUR", "GBP", "AED"];
export const CRYPTO_CURRENCIES = ["BTC", "ETH", "USDT", "SOL", "TON"];
export const CURRENCIES = [...FIAT_CURRENCIES, ...CRYPTO_CURRENCIES];
export const CRYPTO_IDS = {
  BTC: "bitcoin", ETH: "ethereum", USDT: "tether", SOL: "solana", TON: "the-open-network",
};
export const isCrypto = (c) => CRYPTO_CURRENCIES.includes(c);

export const ACCOUNT_TYPES = [
  { id: "checking", label: "Расчётный счёт", icon: "💳" },
  { id: "savings", label: "Накопительный", icon: "🏦" },
  { id: "deposit", label: "Вклад", icon: "📈" },
  { id: "cash", label: "Наличные", icon: "💵" },
  { id: "investment", label: "Инвестиции", icon: "📊" },
  { id: "crypto", label: "Крипто", icon: "🪙" },
  { id: "debt", label: "Долг", icon: "🔻" },
  { id: "other", label: "Другое", icon: "🗂️" },
];
// Types whose cost basis is tracked and for which P&L is displayed.
export const HAS_PNL = new Set(["investment", "crypto"]);
// A debt account's balance is a liability: it subtracts from net worth.
export const balSign = (acc) => (acc && acc.type === "debt" ? -1 : 1);

export const TOMBSTONE_TTL_DAYS = 180;
// Migrated records get a fixed, deliberately old timestamp. Using "now" would
// mean whichever device migrated LAST wins every tie on the first sync, which
// silently discards the other device's edits.
export const MIGRATION_STAMP = "2000-01-01T00:00:00.000Z";

// ── numbers ──────────────────────────────────────────────────────────────────

// Robust across every representation a Google Sheets cell can produce:
// a real number, the RAW text this app writes ("250000", "0.0125"), and a
// value a human typed into a ru_RU sheet ("1 234,56", "1.234.567").
// A bare `parseFloat` turns "0,0125" into 0 and "250 000" into 102.
export const parseNum = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (v === null || v === undefined) return NaN;
  if (typeof v === "boolean") return NaN;
  let s = String(v).trim();
  if (!s) return NaN;
  // Currency symbols, percent and every flavour of grouping space.
  s = s.replace(/[\s\u00a0\u202f\u2009\u2007\u00b4'`\u20bd$\u20ac\u00a3\u20bf\u039e\u20ae\u25ce]/g, "");
  if (!s || !/\d/.test(s)) return NaN;
  const commas = (s.match(/,/g) || []).length;
  const dots = (s.match(/\./g) || []).length;
  if (commas && dots) {
    // Whichever comes last is the decimal separator; the other groups digits.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (commas > 1) {
    s = s.replace(/,/g, "");            // 1,234,567 — grouping
  } else if (commas === 1) {
    s = s.replace(",", ".");            // ru decimal comma
  } else if (dots > 1) {
    s = s.replace(/\./g, "");           // 1.234.567 — grouping
  }
  if (!/^[+-]?\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

// Kills accumulated float noise (0.1 + 0.2) without truncating crypto amounts.
export const roundAmount = (n) => {
  if (!Number.isFinite(n)) return n;
  return Number(n.toPrecision(12));
};

// ── months ───────────────────────────────────────────────────────────────────

export const isMonth = (m) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

export const prevMonth = (m) => {
  if (!isMonth(m)) return null;
  let [y, mo] = m.split("-").map(Number);
  mo -= 1;
  if (mo === 0) { mo = 12; y -= 1; }
  return `${y}-${String(mo).padStart(2, "0")}`;
};

// Shifts a month by n (negative goes back). Used for the assumed purchase date.
export const addMonths = (m, n) => {
  if (!isMonth(m) || !Number.isInteger(n)) return null;
  const [y, mo] = m.split("-").map(Number);
  const t = (y * 12 + (mo - 1)) + n;
  if (t < 0) return null;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};

export const nextMonth = (m) => {
  if (!isMonth(m)) return null;
  let [y, mo] = m.split("-").map(Number);
  mo += 1;
  if (mo === 13) { mo = 1; y += 1; }
  return `${y}-${String(mo).padStart(2, "0")}`;
};

export const currentMonth = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

// ── record helpers ───────────────────────────────────────────────────────────

export const live = (rows) => rows.filter((r) => !r.deletedAt);

export const isOpenAt = (acc, month) => {
  if (!acc || acc.deletedAt) return false;
  if (!isMonth(month)) return false;
  if (acc.openedMonth && month < acc.openedMonth) return false;
  if (acc.closedMonth && month > acc.closedMonth) return false;
  return true;
};

export const emptyData = () => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  accounts: [],
  snapshots: [],
  rates: [],
});

// ── normalisation ────────────────────────────────────────────────────────────

const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

// Currency and type are NOT coerced to a known value. Coercing an unknown
// currency to RUB would silently re-denominate a balance, and this function's
// output is what gets written back over the spreadsheet. An unrecognised
// currency simply fails to convert, which every aggregate already reports.
const normCurrency = (v, fallback) => {
  const c = String(v ?? "").trim().toUpperCase();
  return c || fallback;
};
const isBlankRow = (o) =>
  !o || typeof o !== "object"
  || Object.values(o).every((v) => v === undefined || v === null || String(v).trim() === "");

// Everything read from Sheets or localStorage goes through this. Rows it cannot
// understand are QUARANTINED, never dropped: normalize's output is written back
// over the spreadsheet, so silently discarding a row the user hand-edited would
// delete their data on the next save.
export const normalize = (raw) => {
  const data = {
    schemaVersion: SCHEMA_VERSION,
    revision: Number.isFinite(raw?.revision) ? raw.revision : 0,
    accounts: [],
    snapshots: [],
    rates: [],
    quarantine: [],
  };

  const seenAccId = new Set();
  for (const a of raw?.accounts || []) {
    if (isBlankRow(a)) continue;                          // genuinely empty row
    const id = String(a?.id ?? "").trim();
    if (!id) { data.quarantine.push({ kind: "account", reason: "нет id", row: a }); continue; }
    if (seenAccId.has(id)) { data.quarantine.push({ kind: "account", reason: "дубликат id", row: a }); continue; }
    seenAccId.add(id);
    const rawType = String(a?.type ?? "").trim();
    data.accounts.push({
      id,
      name: String(a.name ?? "").trim() || "(без названия)",
      type: ACCOUNT_TYPES.some((t) => t.id === rawType) ? rawType : (rawType || "other"),
      currency: normCurrency(a.currency, BASE_CURRENCY),
      openedMonth: isMonth(a.openedMonth) ? a.openedMonth : "",
      closedMonth: isMonth(a.closedMonth) ? a.closedMonth : "",
      updatedAt: a.updatedAt || "",
      deletedAt: a.deletedAt || "",
    });
  }

  const accById = new Map(data.accounts.map((a) => [a.id, a]));
  const byKey = new Map();
  const tombstones = [];
  const seenSnapId = new Set();
  for (const s of raw?.snapshots || []) {
    if (isBlankRow(s)) continue;
    const id = String(s?.id ?? "").trim();
    const accountId = String(s?.accountId ?? "").trim();
    const month = String(s?.month ?? "").trim();
    const deletedAt = s?.deletedAt || "";

    // A tombstone carries no payload worth validating: keep it on identity
    // alone, before any parse can reject it, or the deletion is forgotten and
    // the record returns from the other device.
    if (deletedAt) {
      if (id && accountId && isMonth(month) && !seenSnapId.has(id)) {
        seenSnapId.add(id);
        tombstones.push({
          id, accountId, month,
          balance: Number.isFinite(parseNum(s.balance)) ? roundAmount(parseNum(s.balance)) : 0,
          currency: normCurrency(s.currency, accById.get(accountId)?.currency || BASE_CURRENCY),
          contributed: null, contribCurrency: null, contribEstimated: false,
          updatedAt: s.updatedAt || "", deletedAt,
        });
      }
      continue;
    }

    const bad = !id ? "нет id"
      : !accountId ? "нет счёта"
      : !isMonth(month) ? `непонятный месяц "${month}"`
      : !accById.has(accountId) ? "счёт не найден"
      : seenSnapId.has(id) ? "дубликат id"
      : !Number.isFinite(parseNum(s.balance)) ? `непонятная сумма "${s.balance}"`
      : null;
    if (bad) { data.quarantine.push({ kind: "snapshot", reason: bad, row: s }); continue; }

    seenSnapId.add(id);
    const acc = accById.get(accountId);
    const contributed = parseNum(s.contributed);
    const rec = {
      id, accountId, month,
      balance: roundAmount(parseNum(s.balance)),
      currency: normCurrency(s.currency, acc.currency),
      contributed: Number.isFinite(contributed) ? roundAmount(contributed) : null,
      contribCurrency: null,
      // Set when the contribution is not a figure the user entered but one the
      // app derived from a historical price, so the UI can show it as "≈".
      contribEstimated: String(s.contribEstimated ?? "").toLowerCase() === "true",
      updatedAt: s.updatedAt || "",
      deletedAt: "",
    };
    if (rec.contributed !== null) rec.contribCurrency = normCurrency(s.contribCurrency, rec.currency);
    else rec.contribEstimated = false;

    // Duplicate (account, month): the most recently updated one wins, so a
    // stale row left over from an older write cannot double-count.
    const key = `${accountId}|${month}`;
    const prior = byKey.get(key);
    if (!prior) byKey.set(key, rec);
    else if (cmp(rec.updatedAt || "", prior.updatedAt || "") > 0
      || (rec.updatedAt === prior.updatedAt && cmp(rec.id, prior.id) > 0)) byKey.set(key, rec);
  }
  // A total order: month, then account, then id. Anything less than total makes
  // the sorted result depend on the input order, so the same dataset read from
  // the sheet and from localStorage would not compare equal.
  data.snapshots = [...byKey.values(), ...tombstones].sort(
    (a, b) => cmp(a.month, b.month) || cmp(a.accountId, b.accountId) || cmp(a.id, b.id)
  );

  const rateKey = new Set();
  for (const r of raw?.rates || []) {
    if (isBlankRow(r)) continue;
    const month = String(r?.month ?? "").trim();
    const currency = normCurrency(r?.currency, "");
    const perUSD = parseNum(r?.perUSD);
    if (!isMonth(month) || !currency) continue;
    if (!Number.isFinite(perUSD) || perUSD <= 0) continue;
    const key = `${month}|${currency}`;
    if (rateKey.has(key)) continue;
    rateKey.add(key);
    data.rates.push({ month, currency, perUSD, fetchedAt: r.fetchedAt || "" });
  }
  data.rates.sort((a, b) => cmp(a.month, b.month) || cmp(a.currency, b.currency));

  // Anything the previous shape carried that we could not interpret rides along
  // untouched so the writer can put it back exactly as it was found. Deduped by
  // content: these rows are written back to the sheet and read again, so a
  // plain append would double them on every single save.
  for (const q of raw?.quarantine || []) data.quarantine.push(q);
  const qseen = new Set();
  data.quarantine = data.quarantine.filter((q) => {
    const k = `${q.kind}|${JSON.stringify(q.row)}`;
    if (qseen.has(k)) return false;
    qseen.add(k);
    return true;
  });

  return data;
};

// ── migration ────────────────────────────────────────────────────────────────

// v1 -> v2. The only lossy part is the cumulative->delta conversion, and it is
// exact whenever the cumulative series is well formed: contributed(m) is the
// difference against the previous RECORDED month of the same account, so
// months the user skipped no longer reset the basis.
//
// v1 stored a crypto account's `invested` in coins, which can never express a
// cost basis. Those are migrated verbatim (contribCurrency = the coin) and
// flagged by `needsCostBasisReview` rather than silently reinterpreted as fiat.
export const migrateV1 = (v1, nowIso) => {
  const stamp = nowIso || MIGRATION_STAMP;
  const accounts = (v1?.accounts || []).filter((a) => a && typeof a === "object").map((a) => ({
    id: String(a.id ?? "").trim(),
    name: a.name,
    type: a.type,
    currency: a.currency,
    openedMonth: "",
    // v1 kept a boolean `closed` plus `closedMonth`; an account marked closed
    // without a month excluded nothing, so it becomes closed at its last record.
    closedMonth: isMonth(a.closedMonth) ? a.closedMonth : "",
    closedFlagWithoutMonth: !!a.closed && !isMonth(a.closedMonth),
    updatedAt: stamp,
    deletedAt: "",
  }));
  const accById = new Map(accounts.map((a) => [a.id, a]));

  // Rows the migration cannot read are quarantined, never dropped: this output
  // is written straight back over the spreadsheet.
  const quarantine = [];
  const v1snaps = [];
  for (const raw of v1?.snapshots || []) {
    if (isBlankRow(raw)) continue;
    const s = {
      id: String(raw?.id ?? "").trim(),
      accountId: String(raw?.accountId ?? "").trim(),
      month: String(raw?.month ?? "").trim(),
      balance: parseNum(raw?.balance),
      invested: raw?.invested === "" || raw?.invested === undefined || raw?.invested === null
        ? null : parseNum(raw.invested),
    };
    const bad = !s.id ? "нет id"
      : !s.accountId ? "нет счёта"
      : !isMonth(s.month) ? `непонятный месяц "${s.month}"`
      : !Number.isFinite(s.balance) ? `непонятная сумма "${raw?.balance}"`
      : !accById.has(s.accountId) ? "счёт не найден"
      : null;
    if (bad) {
      quarantine.push({ kind: "snapshot", reason: bad, row: {
        id: raw?.id, accountId: raw?.accountId, month: raw?.month, balance: raw?.balance,
        currency: accById.get(s.accountId)?.currency ?? "",
        contributed: raw?.invested, contribCurrency: "", updatedAt: "", deletedAt: "",
      } });
      continue;
    }
    v1snaps.push(s);
  }

  // Collapse duplicates first. Converting cumulative->delta over a duplicated
  // (account, month) pair would compute a second delta of 0 and lose the month.
  const dedup = new Map();
  for (const s of v1snaps) {
    const k = `${s.accountId}|${s.month}`;
    if (!dedup.has(k) || s.id > dedup.get(k).id) dedup.set(k, s);
  }

  const byAccount = new Map();
  for (const s of dedup.values()) {
    if (!byAccount.has(s.accountId)) byAccount.set(s.accountId, []);
    byAccount.get(s.accountId).push(s);
  }

  const needsCostBasisReview = [];
  const repairedGaps = [];
  const snapshots = [];
  for (const [accountId, list] of byAccount) {
    const acc = accById.get(accountId);
    if (!acc) continue;                                  // orphan: dropped
    list.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

    // Recover the delta the user actually typed by inverting v1's own formula
    // exactly: it stored `invested(previous CALENDAR month) + delta`, falling
    // back to 0 whenever that month had no snapshot or no invested value. So
    // the delta is the stored value minus that same base — which repairs the
    // skipped-month reset instead of re-encoding it as a huge withdrawal.
    const investedAt = new Map();
    for (const s of list) if (s.invested !== null && Number.isFinite(s.invested)) investedAt.set(s.month, s.invested);

    let sawEarlier = false;
    for (const s of list) {
      let contributed = null;
      if (s.invested !== null && Number.isFinite(s.invested)) {
        const base = investedAt.get(prevMonth(s.month));
        contributed = roundAmount(s.invested - (base ?? 0));
        if (base === undefined && sawEarlier) repairedGaps.push({ accountId, month: s.month, name: acc.name });
        sawEarlier = true;
      }
      snapshots.push({
        id: s.id,
        accountId,
        month: s.month,
        balance: roundAmount(s.balance),
        currency: acc.currency,
        contributed,
        contribCurrency: contributed === null ? null : acc.currency,
        contribEstimated: false,
        updatedAt: stamp,
        deletedAt: "",
      });
    }
    if (acc.type === "crypto" && list.some((s) => s.invested !== null)) {
      needsCostBasisReview.push(accountId);
    }
    if (acc.closedFlagWithoutMonth && list.length) {
      acc.closedMonth = list[list.length - 1].month;
    }
  }
  for (const a of accounts) delete a.closedFlagWithoutMonth;

  const migrated = normalize({ schemaVersion: SCHEMA_VERSION, revision: 0, accounts, snapshots, rates: [], quarantine });
  return { data: migrated, needsCostBasisReview, repairedGaps };
};

// Detects which schema a decoded payload is in.
export const detectVersion = (raw) => {
  if (!raw || typeof raw !== "object") return 0;
  const snaps = raw.snapshots || [];
  const accs = raw.accounts || [];
  // Shape first: a claimed version can be missing (Meta tab deleted) or wrong,
  // and acting on the wrong one destroys data.
  if (snaps.some((s) => s && ("contributed" in s || "contribCurrency" in s))) return 2;
  if (accs.some((a) => a && ("openedMonth" in a || "deletedAt" in a))) return 2;
  if (snaps.some((s) => s && "invested" in s)) return 1;
  if (accs.some((a) => a && "closed" in a)) return 1;
  if (Number.isFinite(raw.schemaVersion) && raw.schemaVersion > 0) return raw.schemaVersion;
  return snaps.length || accs.length ? 1 : 0;
};

export const ensureV2 = (raw, nowIso) => {
  const v = detectVersion(raw);
  // A payload written by a NEWER build understands fields this one would drop.
  // Report it so the caller can refuse to write rather than downgrade it.
  if (v > SCHEMA_VERSION) return { data: normalize(raw), migrated: false, tooNew: true, needsCostBasisReview: [], repairedGaps: [] };
  if (v >= 2) return { data: normalize(raw), migrated: false, needsCostBasisReview: [], repairedGaps: [] };
  if (v === 0) return { data: emptyData(), migrated: false, needsCostBasisReview: [], repairedGaps: [] };
  const { data, needsCostBasisReview, repairedGaps } = migrateV1(raw, nowIso);
  return { data, migrated: true, needsCostBasisReview, repairedGaps };
};

// ── merge ────────────────────────────────────────────────────────────────────

// Must depend only on the two records, never on which side they came from:
// if merge(local, remote) and merge(remote, local) disagree, two devices flip
// each other's value forever and neither ever converges.
const pickNewer = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const ta = a.updatedAt || "";
  const tb = b.updatedAt || "";
  if (ta !== tb) return ta > tb ? a : b;
  // Same timestamp: a delete beats a concurrent edit, then fall back to a
  // content comparison so both devices reach the same answer.
  if (!!a.deletedAt !== !!b.deletedAt) return a.deletedAt ? a : b;
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
};

// Last-writer-wins per record, with tombstones. Replaces v1's "remote wins for
// the whole dataset", which discarded every edit made before signing in.
export const mergeData = (local, remote, nowIso) => {
  const stamp = nowIso || new Date().toISOString();
  const l = normalize(local || emptyData());
  const r = normalize(remote || emptyData());

  const accounts = new Map();
  for (const a of l.accounts) accounts.set(a.id, a);
  for (const a of r.accounts) accounts.set(a.id, pickNewer(accounts.get(a.id), a));

  const snaps = new Map();
  for (const s of l.snapshots) snaps.set(s.id, s);
  for (const s of r.snapshots) snaps.set(s.id, pickNewer(snaps.get(s.id), s));

  // Two devices can create different ids for the same (account, month). Keep
  // the newer and tombstone the loser so the duplicate does not come back.
  // Iterate over a snapshot of the values: the loop writes back into `snaps`.
  const byKey = new Map();
  for (const s of [...snaps.values()]) {
    if (s.deletedAt) continue;
    const key = `${s.accountId}|${s.month}`;
    const prior = byKey.get(key);
    if (!prior) { byKey.set(key, s); continue; }
    const win = pickNewer(prior, s);
    const lose = win === prior ? s : prior;
    byKey.set(key, win);
    // The tombstone must not be born already expired: an epoch timestamp would
    // be purged on the next write and the duplicate would come straight back.
    snaps.set(lose.id, {
      ...lose,
      deletedAt: win.updatedAt || lose.updatedAt || stamp,
      updatedAt: win.updatedAt || lose.updatedAt || stamp,
    });
  }

  // A stamped rate is immutable, but "first writer wins" depends on argument
  // order and so never converges across devices. Resolve it on the data: the
  // earliest stamp wins, ties broken on the value itself.
  const rates = new Map();
  for (const x of [...l.rates, ...r.rates]) {
    const key = `${x.month}|${x.currency}`;
    const prior = rates.get(key);
    if (!prior) { rates.set(key, x); continue; }
    const ka = `${prior.fetchedAt || ""}|${prior.perUSD}`;
    const kb = `${x.fetchedAt || ""}|${x.perUSD}`;
    if (kb < ka) rates.set(key, x);
  }

  return normalize({
    schemaVersion: SCHEMA_VERSION,
    revision: Math.max(l.revision, r.revision),
    accounts: [...accounts.values()],
    snapshots: [...snaps.values()],
    rates: [...rates.values()],
    quarantine: [...(l.quarantine || []), ...(r.quarantine || [])],
  });
};

// Turns a cost basis that was recorded as a COIN QUANTITY into roubles.
//
// A coin amount is not a purchase price: converting it at any single rate makes
// P&L come out as exactly zero, because the same rate cancels on both sides of
// value - basis. The only way to get a number is to price the coins at the
// moment they were bought — which v1 never recorded. `assumedMonth` is that
// missing fact, supplied by the user, and every value derived from it is marked
// `contribEstimated` so it is never mistaken for something they typed.
//
// The first coin contribution of an account is priced at `assumedMonth`; any
// later one is priced at the month it was recorded in, since a later addition
// did happen then.
// The (month, currency) pairs an estimate needs priced, so the caller can fetch
// exactly those and nothing more. A contribution of zero needs no price — zero
// coins are zero roubles at any rate — which keeps the request count at one per
// coin instead of one per month, well under CoinGecko's free-tier limit.
export const coinBasisPricePairs = (data, assumedMonth) => {
  const out = new Map();
  for (const [, list] of coinBasisAccounts(data)) {
    list.forEach((s, i) => {
      if (s.contributed === 0) return;
      const month = i === 0 ? assumedMonth : s.month;
      out.set(`${month}|${s.contribCurrency}`, { month, currency: s.contribCurrency });
    });
  }
  return [...out.values()];
};

const coinBasisAccounts = (data) => {
  const byAccount = new Map();
  for (const s of live(data.snapshots)) {
    if (s.contributed === null || !isCrypto(s.contribCurrency)) continue;
    if (!byAccount.has(s.accountId)) byAccount.set(s.accountId, []);
    byAccount.get(s.accountId).push(s);
  }
  for (const list of byAccount.values()) list.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  return byAccount;
};

// Turns a cost basis that was recorded as a COIN QUANTITY into roubles.
//
// A coin amount is not a purchase price: converting it at any single rate makes
// P&L come out as exactly zero, because the same rate cancels on both sides of
// value - basis. The only way to get a number is to price the coins at the
// moment they were bought — which v1 never recorded. `assumedMonth` is that
// missing fact, supplied by the user, and every value derived from it is marked
// `contribEstimated` so it is never mistaken for something they typed.
//
// The first coin contribution of an account is priced at `assumedMonth`; any
// later one is priced at the month it was recorded in, since a later addition
// did happen then.
//
// All or nothing PER ACCOUNT: converting only some of an account's months would
// leave a basis half in coins and half in roubles, which is worse than leaving
// it alone — costBasis rightly refuses to trust a mixed series.
export const estimateCoinBasis = (data, { assumedMonth, priceRub, nowIso }) => {
  const stamp = nowIso || new Date().toISOString();
  const changed = [];
  const missing = [];
  const priced = new Map();

  for (const [accountId, list] of coinBasisAccounts(data)) {
    const acc = data.accounts.find((a) => a.id === accountId);
    const forAccount = [];
    let ok = true;
    list.forEach((s, i) => {
      if (!ok) return;
      const month = i === 0 ? assumedMonth : s.month;
      if (s.contributed === 0) { forAccount.push([s.id, { rub: 0, month }]); return; }
      const rate = priceRub(month, s.contribCurrency);
      if (!Number.isFinite(rate) || rate <= 0) {
        missing.push({ accountId, name: acc?.name, month, currency: s.contribCurrency });
        ok = false;
        return;
      }
      forAccount.push([s.id, { rub: roundAmount(s.contributed * rate), month, rate, coins: s.contributed, currency: s.contribCurrency }]);
    });
    if (!ok) continue;
    for (const [id, p] of forAccount) {
      priced.set(id, p);
      if (p.coins) changed.push({ accountId, name: acc?.name, month: p.month, coins: p.coins, currency: p.currency, rub: p.rub });
    }
  }
  if (!priced.size) return { data, changed, missing };

  return {
    data: normalize({
      ...data,
      snapshots: data.snapshots.map((s) => {
        const p = priced.get(s.id);
        if (!p) return s;
        return { ...s, contributed: p.rub, contribCurrency: BASE_CURRENCY, contribEstimated: true, updatedAt: stamp };
      }),
    }),
    changed,
    missing,
  };
};

export const purgeTombstones = (data, now = new Date(), days = TOMBSTONE_TTL_DAYS) => {
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString();
  const keep = (r) => !r.deletedAt || r.deletedAt > cutoff;
  return {
    ...data,
    accounts: data.accounts.filter(keep),
    snapshots: data.snapshots.filter(keep),
  };
};
