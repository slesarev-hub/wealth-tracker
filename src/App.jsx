import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

import {
  ACCOUNT_TYPES, CURRENCIES, CRYPTO_IDS, BASE_CURRENCY, HAS_PNL, SCHEMA_VERSION,
  isCrypto, parseNum, roundAmount, prevMonth, currentMonth, isMonth, live,
  ensureV2, mergeData, purgeTombstones, emptyData, balSign,
} from "./lib/model.js";
import {
  makeRatesOf, convert, snapshotIndex, monthsOf, getSnapshot, effectiveSnapshot,
  monthTotal, breakdown, monthlyChange, percentChange, accountDelta, pnlFor,
  accountsForMonth, accountsInMonth,
} from "./lib/calc.js";
import { CURRENCY_SYMBOLS, fmtShort, fmtBalance, fmtSigned, monthLabel } from "./lib/format.js";
import ReturnsTab from "./ReturnsTab.jsx";
import { readFromSheets, writeToSheets, createSpreadsheet, SheetsError } from "./lib/sheets.js";

const LS_KEY = "money-tracker-v2";
const LS_KEY_V1 = "money-tracker-v1";
const LS_GSHEET = "money-tracker-gsheet";
const LS_CLIENT = "money-tracker-client-id";
const LS_RATES = "money-tracker-rates-v2";
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const DISPLAY_CURRENCIES = ["RUB", "USD", "EUR"];
const RATES_STALE_MS = 36 * 3600 * 1000;

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const nowIso = () => new Date().toISOString();
const typeIcon = (type) => ACCOUNT_TYPES.find((t) => t.id === type)?.icon || "🗂️";
const typeLabel = (type) => ACCOUNT_TYPES.find((t) => t.id === type)?.label || type;

const loadLocal = () => {
  try {
    const rawV2 = localStorage.getItem(LS_KEY);
    if (rawV2) return ensureV2(JSON.parse(rawV2)).data;
  } catch {}
  try {
    const rawV1 = localStorage.getItem(LS_KEY_V1);
    if (rawV1) return ensureV2(JSON.parse(rawV1)).data;
  } catch {}
  return emptyData();
};

export default function App() {
  const [data, setData] = useState(emptyData);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  // The active tab lives in the URL hash so a tab can be bookmarked / reloaded.
  const TAB_IDS = ["dashboard", "returns", "accounts", "history"];
  const [tab, setTabState] = useState(() => {
    const h = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
    return TAB_IDS.includes(h) ? h : "dashboard";
  });
  const setTab = (id) => {
    setTabState(id);
    try { history.replaceState(null, "", id === "dashboard" ? window.location.pathname + window.location.search : "#" + id); } catch {}
  };
  const [modal, setModal] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [newAccount, setNewAccount] = useState({ name: "", type: "savings", currency: BASE_CURRENCY });
  const [editAccount, setEditAccount] = useState(null);
  const [recordMonth, setRecordMonth] = useState(currentMonth());
  const [form, setForm] = useState({});
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [notice, setNotice] = useState(null);

  // ── rates ──────────────────────────────────────────────────────────────────
  const [rates, setRates] = useState(() => {
    try {
      const c = JSON.parse(localStorage.getItem(LS_RATES));
      if (c?.rates?.USD) return c;
    } catch {}
    return null;
  });
  const [ratesErrors, setRatesErrors] = useState([]);
  const ratesRef = useRef(rates);
  useEffect(() => { ratesRef.current = rates; }, [rates]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const errors = [];
      const fiat = await fetch("https://open.er-api.com/v6/latest/USD")
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      // v1 treated any JSON body as success, so a CoinGecko 429 (routine on the
      // free API) silently dropped every crypto rate and poisoned the cache.
      const crypto_ = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(CRYPTO_IDS).join(",")}&vs_currencies=usd`
      ).then((r) => (r.ok ? r.json() : null)).catch(() => null);

      if (!fiat || fiat.result !== "success" || !fiat.rates?.USD) errors.push("open.er-api.com (фиат)");
      const cryptoOk = crypto_ && Object.values(CRYPTO_IDS).every((id) => Number.isFinite(crypto_[id]?.usd) && crypto_[id].usd > 0);
      if (!cryptoOk) errors.push("CoinGecko (крипто)");

      if (cancelled) return;
      if (!fiat || fiat.result !== "success") { setRatesErrors(errors); return; }

      const table = { ...fiat.rates, USD: 1 };
      if (cryptoOk) {
        for (const [sym, id] of Object.entries(CRYPTO_IDS)) table[sym] = 1 / crypto_[id].usd;
      } else {
        // keep whatever crypto rates the cache already had rather than losing them
        for (const sym of Object.keys(CRYPTO_IDS)) {
          const cached = ratesRef.current?.rates?.[sym];
          if (Number.isFinite(cached)) table[sym] = cached;
        }
      }
      const next = { rates: table, fetchedAt: nowIso(), partial: !cryptoOk };
      setRates(next);
      setRatesErrors(errors);
      try { localStorage.setItem(LS_RATES, JSON.stringify(next)); } catch {}
    };
    run();
    return () => { cancelled = true; };
  }, []);

  const ratesStale = rates?.fetchedAt ? Date.now() - Date.parse(rates.fetchedAt) > RATES_STALE_MS : !!rates;

  // ── sync ───────────────────────────────────────────────────────────────────
  const [clientId, setClientId] = useState(() => localStorage.getItem(LS_CLIENT) || "");
  const [clientIdDraft, setClientIdDraft] = useState("");
  const [sheetIdDraft, setSheetIdDraft] = useState("");
  const [token, setToken] = useState(null);
  const [sheetId, setSheetId] = useState(() => localStorage.getItem(LS_GSHEET) || "");
  const [syncStatus, setSyncStatus] = useState("idle");
  const syncStatusRef = useRef("idle");
  const [syncMsg, setSyncMsg] = useState("");
  const tokenClientRef = useRef(null);
  const sheetIdRef = useRef(sheetId);
  const tokenRef = useRef(token);
  const revisionRef = useRef(null);
  const extentRef = useRef(null);
  // Every write to the sheet goes through this chain, so two quick saves (or a
  // save landing while a pull is in flight) cannot interleave their requests
  // and race on the revision counter.
  const queueRef = useRef(Promise.resolve());
  useEffect(() => { sheetIdRef.current = sheetId; }, [sheetId]);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { syncStatusRef.current = syncStatus; }, [syncStatus]);

  useEffect(() => { setData(loadLocal()); }, []);

  const persistLocal = useCallback((next) => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
  }, []);

  const handleSheetsError = useCallback((e) => {
    if (e instanceof SheetsError && e.needsAuth) {
      // v1 never noticed the ~1h token expiry, so every later edit was written
      // to nothing and lost on the next reload.
      setToken(null);
      setSyncStatus("error");
      setSyncMsg("Сессия Google истекла — войдите снова");
    } else {
      setSyncStatus("error");
      setSyncMsg("Ошибка: " + (e?.message || String(e)));
    }
  }, []);

  const push = useCallback(async (next, tk, sid, backup) => {
    // Writing with an unknown base would skip the conflict check entirely and
    // overwrite the sheet with whatever this device happens to hold — exactly
    // the v1 failure. If the first sync never completed, read before writing.
    if (revisionRef.current === null) {
      const first = await readFromSheets(tk, sid);
      const remoteFirst = ensureV2(first.payload).data;
      revisionRef.current = first.payload.revision;
      extentRef.current = first.extent;
      next = mergeData(next, remoteFirst);
      setData(next); dataRef.current = next; persistLocal(next);
    }
    let base = revisionRef.current;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await writeToSheets(tk, sid, purgeTombstones(next), {
        base, extent: extentRef.current, writer: `wealth-tracker v${SCHEMA_VERSION}`, backup,
      });
      if (!res.conflict) {
        revisionRef.current = res.revision;
        extentRef.current = res.extent;
        return next;
      }
      // Someone else wrote in the meantime: merge their version in and retry
      // once instead of overwriting it.
      const remoteRes = await readFromSheets(tk, sid);
      const remote = ensureV2(remoteRes.payload).data;
      next = mergeData(next, remote);
      base = remoteRes.payload.revision;
      extentRef.current = remoteRes.extent;
      setData(next);
      dataRef.current = next;
      persistLocal(next);
      setSyncMsg("Объединено с изменениями из таблицы");
    }
    throw new Error("Не удалось записать: таблицу меняет кто-то ещё");
  }, [persistLocal]);

  const enqueue = useCallback((fn) => {
    // queueRef always holds a promise that never rejects, so one failed write
    // cannot stall or poison the ones behind it.
    const run = queueRef.current.then(fn);
    queueRef.current = run.then(() => {}, () => {});
    return run;
  }, []);

  const syncNow = useCallback((tk, sid) => enqueue(async () => {
    if (!tk) return;
    setSyncStatus("syncing"); setSyncMsg("Синхронизация…");
    try {
      let id = sid;
      if (!id) {
        id = await createSpreadsheet(tk);
        setSheetId(id); sheetIdRef.current = id;
        localStorage.setItem(LS_GSHEET, id);
      }
      const res = await readFromSheets(tk, id);
      const { data: remote, migrated, needsCostBasisReview, repairedGaps, tooNew } = ensureV2(res.payload);
      if (tooNew) {
        // Another device wrote a schema this build does not understand. Writing
        // would silently drop whatever it added.
        setSyncStatus("error");
        setSyncMsg("Таблица новее этой версии приложения — обновите страницу");
        return;
      }
      revisionRef.current = res.payload.revision;
      extentRef.current = res.extent;

      // v1 replaced local data wholesale whenever the sheet was non-empty,
      // which discarded everything recorded before signing in.
      const merged = mergeData(dataRef.current, remote);
      setData(merged); dataRef.current = merged; persistLocal(merged);

      const remoteOutdated = migrated || res.version < SCHEMA_VERSION
        || JSON.stringify(merged) !== JSON.stringify(remote);
      // On the very first v2 write, copy the untouched v1 rows into backup tabs
      // inside the same spreadsheet before overwriting them.
      if (remoteOutdated) await push(merged, tk, id, migrated ? res.rawRows : undefined);

      setSyncStatus("ok");
      setSyncMsg(migrated ? "Схема обновлена ✓" : "Синхронизировано ✓");
      const notes = [];
      if (repairedGaps?.length) {
        notes.push(
          `Исправлено ${repairedGaps.length} мес. с обнулённой базой вложений (`
          + [...new Set(repairedGaps.map((g) => `${g.name} ${monthLabel(g.month)}`))].join(", ")
          + `): раньше пропуск месяца сбрасывал сумму вложений и завышал P&L. Проверьте эти месяцы.`
        );
      }
      if (needsCostBasisReview.length) {
        notes.push("У крипто-счетов «внесено» записано в монетах, поэтому доходность не считается. Укажите сумму вложений в рублях.");
      }
      if (notes.length) setNotice({ kind: "cost-basis", text: notes.join(" ") });
    } catch (e) { handleSheetsError(e); }
  }), [enqueue, handleSheetsError, persistLocal, push]);

  useEffect(() => {
    if (!clientId) return;
    const load = () => {
      if (!window.google) return;
      tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES,
        callback: async (resp) => {
          if (resp.error) { setSyncStatus("error"); setSyncMsg("Ошибка авторизации"); return; }
          setToken(resp.access_token);
          tokenRef.current = resp.access_token;
          // v1 read sheetId from the closure captured when the client was
          // created, so a sheet pasted afterwards was ignored and a duplicate
          // spreadsheet got created.
          await syncNow(resp.access_token, sheetIdRef.current);
        },
      });
    };
    if (window.google) { load(); return; }
    let el = document.getElementById("gsi-script");
    if (!el) {
      el = document.createElement("script");
      el.id = "gsi-script"; el.src = "https://accounts.google.com/gsi/client"; el.async = true;
      document.head.appendChild(el);
    }
    el.addEventListener("load", load);
    return () => el.removeEventListener("load", load);
  }, [clientId, syncNow]);

  const requestToken = () => tokenClientRef.current?.requestAccessToken();

  const save = useCallback((next) => {
    setData(next); dataRef.current = next; persistLocal(next);
    const tk = tokenRef.current, sid = sheetIdRef.current;
    if (!tk || !sid) {
      // Do not paint over "session expired": the edit really is unsynced.
      setSyncStatus(syncStatusRef.current === "error" ? "error" : "idle");
      setSyncMsg(syncStatusRef.current === "error" ? "Сохранено локально — не синхронизировано" : "Сохранено локально");
      return;
    }
    setSyncStatus("syncing"); setSyncMsg("Сохранение…");
    enqueue(() => push(next, tk, sid))
      .then(() => { setSyncStatus("ok"); setSyncMsg("Сохранено ✓"); })
      .catch(handleSheetsError);
  }, [enqueue, handleSheetsError, persistLocal, push]);

  // ── derived ────────────────────────────────────────────────────────────────
  const idx = useMemo(() => snapshotIndex(data), [data]);
  const months = useMemo(() => monthsOf(data), [data]);
  const ratesOf = useMemo(() => makeRatesOf(data, rates), [data, rates]);
  const lastM = months[months.length - 1] || null;
  const prevRecorded = months.length > 1 ? months[months.length - 2] : null;

  const totals = useMemo(() => {
    if (!lastM) return null;
    const table = ratesOf(lastM).table;
    return Object.fromEntries(DISPLAY_CURRENCIES.map((c) => [c, monthTotal(data, lastM, c, table, idx)]));
  }, [data, idx, lastM, ratesOf]);

  const change = useMemo(
    () => (lastM && prevRecorded ? monthlyChange(data, lastM, prevRecorded, BASE_CURRENCY, ratesOf, idx) : null),
    [data, idx, lastM, prevRecorded, ratesOf]
  );

  const chart = useMemo(
    () => months.map((m) => ({
      month: m, label: monthLabel(m),
      total: monthTotal(data, m, BASE_CURRENCY, ratesOf(m).table, idx).total,
      stamped: ratesOf(m).stamped,
    })),
    [data, idx, months, ratesOf]
  );
  const unstampedMonths = chart.filter((p) => !p.stamped).length;

  const bd = useMemo(
    () => (lastM ? breakdown(data, lastM, BASE_CURRENCY, ratesOf(lastM).table, idx) : null),
    [data, idx, lastM, ratesOf]
  );

  const accountsNow = useMemo(() => (lastM ? accountsInMonth(data, lastM, idx) : []), [data, idx, lastM]);
  const formAccounts = useMemo(
    () => (isMonth(recordMonth) ? accountsForMonth(data, recordMonth) : []),
    [data, recordMonth]
  );

  // ── record form ────────────────────────────────────────────────────────────
  const buildForm = useCallback((mn) => {
    const next = {};
    if (!isMonth(mn)) return next;
    for (const a of accountsForMonth(data, mn)) {
      const cur = getSnapshot(idx, a.id, mn);
      const carried = cur ? null : effectiveSnapshot(idx, a.id, prevMonth(mn) || "");
      const src = cur || carried?.snap || null;
      next[a.id] = {
        balance: src ? String(src.balance) : "",
        contributed: cur && cur.contributed !== null ? String(cur.contributed) : "",
        contribCurrency: (cur?.contribCurrency) || (isCrypto(a.currency) ? BASE_CURRENCY : a.currency),
      };
    }
    return next;
  }, [data, idx]);

  const openRecord = (m) => {
    const mn = isMonth(m) ? m : (isMonth(recordMonth) ? recordMonth : currentMonth());
    setRecordMonth(mn);
    setForm(buildForm(mn));
    setModal("record");
  };

  const stampRates = (base, month) => {
    if (!rates?.rates) return base;
    // Today's rate is only an honest stamp for the month being lived through or
    // the one just ended. Backfilling March in September must NOT freeze
    // September's rate onto March — an unstamped month is flagged in the UI,
    // which is truthful, while a wrong stamp would be permanent.
    const cm = currentMonth();
    if (month !== cm && month !== prevMonth(cm)) return base;
    // Stamp every currency, not just the ones in use: an account added later
    // would otherwise leave the month permanently half-stamped.
    const already = new Set(base.rates.filter((r) => r.month === month).map((r) => r.currency));
    const rows = [];
    for (const c of CURRENCIES) {
      if (already.has(c)) continue;             // stamped rates are immutable
      const v = rates.rates[c];
      if (Number.isFinite(v) && v > 0) rows.push({ month, currency: c, perUSD: v, fetchedAt: rates.fetchedAt || nowIso() });
    }
    if (!rows.length) return base;
    return { ...base, rates: [...base.rates, ...rows] };
  };

  // A value the user typed that cannot be read as a number must never be
  // silently dropped (v1 dropped it and so did the first cut of this rewrite).
  const formErrors = (() => {
    const errs = {};
    for (const acc of formAccounts) {
      const f = form[acc.id];
      if (!f) continue;
      const b = String(f.balance ?? "").trim();
      if (b !== "" && !Number.isFinite(parseNum(b))) errs[acc.id] = "Не похоже на число";
      const c = String(f.contributed ?? "").trim();
      if (!errs[acc.id] && c !== "" && !Number.isFinite(parseNum(c))) errs[acc.id] = "Взнос не похож на число";
    }
    return errs;
  })();

  const saveRecord = () => {
    if (!isMonth(recordMonth)) { setSyncMsg("Укажите месяц"); return; }
    if (Object.keys(formErrors).length) return;      // the form shows why
    const base = dataRef.current;
    const stamp = nowIso();
    let next = { ...base, snapshots: [...base.snapshots] };
    for (const acc of accountsForMonth(base, recordMonth)) {
      const f = form[acc.id];
      if (!f) continue;
      const raw = String(f.balance ?? "").trim();
      if (raw === "") continue;                       // left blank: leave as it was
      const balance = parseNum(raw);
      if (!Number.isFinite(balance)) continue;        // already rejected above
      const rawContrib = String(f.contributed ?? "").trim();
      const parsedContrib = rawContrib === "" ? null : parseNum(rawContrib);
      const contributed = parsedContrib === null || !Number.isFinite(parsedContrib) ? null : roundAmount(parsedContrib);
      const contribCurrency = contributed === null ? null
        : (CURRENCIES.includes(f.contribCurrency) ? f.contribCurrency : acc.currency);

      const i = next.snapshots.findIndex((s) => s.accountId === acc.id && s.month === recordMonth && !s.deletedAt);
      const rec = {
        accountId: acc.id, month: recordMonth,
        balance: roundAmount(balance),
        // An existing month keeps the currency it was recorded in. Changing the
        // account's currency must not re-denominate history.
        currency: i >= 0 ? next.snapshots[i].currency : acc.currency,
        contributed, contribCurrency, updatedAt: stamp, deletedAt: "",
      };
      if (i >= 0) next.snapshots[i] = { ...next.snapshots[i], ...rec };
      else next.snapshots.push({ id: uid(), ...rec });
    }
    next = stampRates(next, recordMonth);
    save(ensureV2(next).data);
    setModal(null);
  };

  // ── account actions ────────────────────────────────────────────────────────
  const addAccount = () => {
    const name = newAccount.name.trim();
    if (!name) return;
    save(ensureV2({
      ...dataRef.current,
      accounts: [...dataRef.current.accounts, {
        id: uid(), name, type: newAccount.type, currency: newAccount.currency,
        openedMonth: "", closedMonth: "", updatedAt: nowIso(), deletedAt: "",
      }],
    }).data);
    setNewAccount({ name: "", type: "savings", currency: BASE_CURRENCY });
    setModal(null);
  };

  const patchAccount = (id, patch) => save(ensureV2({
    ...dataRef.current,
    accounts: dataRef.current.accounts.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: nowIso() } : a)),
  }).data);

  const updateAccount = () => {
    const orig = dataRef.current.accounts.find((a) => a.id === editAccount.id);
    if (!orig) { setModal(null); setEditAccount(null); return; }
    const currencyChanged = orig.currency !== editAccount.currency;
    const typeChanged = orig.type !== editAccount.type;
    const wasDebt = orig.type === "debt";
    const willBeDebt = editAccount.type === "debt";
    const apply = () => {
      patchAccount(editAccount.id, {
        name: editAccount.name.trim() || orig.name,
        type: editAccount.type,
        currency: editAccount.currency,
      });
      setModal(null); setEditAccount(null);
    };
    const notes = [];
    // Historical snapshots keep the currency they were recorded in, so changing
    // it affects only future records — v1 silently reinterpreted all history.
    if (currencyChanged) notes.push(`Записи за прошлые месяцы останутся в ${orig.currency}; новые будут в ${editAccount.currency}.`);
    // Type is not stored per snapshot, so it applies to the whole history — and
    // switching to or from «Долг» flips the sign of every past month.
    if (typeChanged && wasDebt !== willBeDebt)
      notes.push(`Тип меняется на «${typeLabel(editAccount.type)}» для всей истории: знак этого счёта в итогах за все месяцы ${willBeDebt ? "станет отрицательным" : "станет положительным"}.`);
    else if (typeChanged) notes.push(`Тип меняется на «${typeLabel(editAccount.type)}» для всей истории счёта.`);
    if (notes.length) {
      setConfirm({
        title: "Применить изменения?",
        body: notes.join(" "),
        confirmLabel: "Применить",
        onConfirm: () => { setConfirm(null); apply(); },
      });
    } else apply();
  };

  const closeAccount = (acc) => setConfirm({
    title: `Закрыть «${acc.name}»?`,
    body: "Счёт перестанет учитываться со следующего месяца. История сохранится, счёт можно открыть заново.",
    confirmLabel: "Закрыть счёт",
    onConfirm: () => {
      setConfirm(null);
      patchAccount(acc.id, { closedMonth: lastM && lastM > currentMonth() ? lastM : currentMonth() });
      setModal(null); setEditAccount(null);
    },
  });

  const reopenAccount = (acc) => {
    patchAccount(acc.id, { closedMonth: "" });
    setModal(null); setEditAccount(null);
  };

  const deleteAccount = (acc) => setConfirm({
    title: `Удалить «${acc.name}»?`,
    body: `Будут удалены счёт и все его записи (${live(data.snapshots).filter((s) => s.accountId === acc.id).length} шт.). Это нельзя отменить. Обычно достаточно закрыть счёт — тогда история сохранится.`,
    confirmLabel: "Удалить навсегда",
    danger: true,
    onConfirm: () => {
      setConfirm(null);
      const stamp = nowIso();
      const cur = dataRef.current;
      save(ensureV2({
        ...cur,
        accounts: cur.accounts.map((a) => (a.id === acc.id ? { ...a, deletedAt: stamp, updatedAt: stamp } : a)),
        snapshots: cur.snapshots.map((s) => (s.accountId === acc.id ? { ...s, deletedAt: stamp, updatedAt: stamp } : s)),
      }).data);
      setModal(null); setEditAccount(null);
    },
  });

  const deleteMonth = (m) => setConfirm({
    title: `Удалить ${monthLabel(m)}?`,
    body: `Будут удалены все записи за этот месяц (${live(data.snapshots).filter((s) => s.month === m).length} шт.). Это нельзя отменить.`,
    confirmLabel: "Удалить",
    danger: true,
    onConfirm: () => {
      setConfirm(null);
      const stamp = nowIso();
      const cur = dataRef.current;
      save(ensureV2({
        ...cur,
        snapshots: cur.snapshots.map((s) => (s.month === m ? { ...s, deletedAt: stamp, updatedAt: stamp } : s)),
      }).data);
      setSelectedMonth(null);
    },
  });

  const saveClientId = () => {
    localStorage.setItem(LS_CLIENT, clientIdDraft.trim());
    setClientId(clientIdDraft.trim());
    const t = sheetIdDraft.trim();
    if (t) {
      const m = t.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      const id = m ? m[1] : t;
      if (id !== sheetIdRef.current) {
        // The tracked revision and extent describe the previous spreadsheet.
        // Carrying them over would let the first save overwrite the new one
        // without ever reading it.
        revisionRef.current = null;
        extentRef.current = null;
      }
      setSheetId(id); sheetIdRef.current = id;
      localStorage.setItem(LS_GSHEET, id);
    }
    setModal(null);
  };

  const disconnect = () => {
    setToken(null); setSheetId(""); setClientId("");
    localStorage.removeItem(LS_GSHEET); localStorage.removeItem(LS_CLIENT);
    revisionRef.current = null; extentRef.current = null;
    setSyncStatus("idle"); setSyncMsg("");
  };

  const isConnected = !!token && !!sheetId;
  // Not being signed in is the one state that silently loses data: every edit
  // stays in this browser only. It must never read as neutral grey.
  const signedOut = !isConnected;
  const syncColor = signedOut
    ? "#f87171"
    : { idle: "#4b5563", syncing: "#fcd34d", ok: "#6ee7b7", error: "#f87171" }[syncStatus];
  const signedOutText = clientId ? "Вход не выполнен" : "Sheets не настроен";
  // Same inclusion rule as monthTotal: a field left blank keeps the balance the
  // month would actually be saved with, instead of silently counting as zero.
  const formTotal = formAccounts.reduce((sum, acc) => {
    const typed = String(form[acc.id]?.balance ?? "").trim();
    let v = typed === "" ? NaN : parseNum(typed);
    let cur = acc.currency;
    if (!Number.isFinite(v)) {
      const eff = isMonth(recordMonth) ? effectiveSnapshot(idx, acc.id, recordMonth) : null;
      if (!eff) return sum;
      v = eff.snap.balance; cur = eff.snap.currency;
    }
    const conv = convert(v, cur, BASE_CURRENCY, ratesOf(isMonth(recordMonth) ? recordMonth : currentMonth()).table);
    if (!Number.isFinite(conv)) return sum;
    return sum + conv * balSign(acc);
  }, 0);

  const warn = (text, color = "#fcd34d") => (
    <div style={{ background: "#1a1a12", border: `1px solid ${color}44`, color, borderRadius: 10, padding: "10px 14px", fontSize: 12, marginBottom: 14, lineHeight: 1.6 }}>{text}</div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#0d0f14", color: "#e8eaf0", fontFamily: "'DM Mono', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap');
        * { box-sizing: border-box; margin: 0; }
        input, select { outline: none; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #2a2d38; border-radius: 4px; }
        .tab-btn { background: none; border: none; cursor: pointer; font-family: inherit; }
        .acc-row:hover { background: #1a1d26 !important; }
        .icon-btn { background: none; border: none; cursor: pointer; padding: 4px 8px; font-size: 14px; opacity: 0.55; transition: opacity 0.15s; }
        .icon-btn:hover, .acc-row:hover .icon-btn { opacity: 1; }
        .month-row:hover { background: #1a1d26 !important; cursor: pointer; }
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center; z-index: 100; backdrop-filter: blur(4px); padding: 16px; }
        .btn-primary { background: #6ee7b7; color: #0d0f14; border: none; padding: 10px 22px; border-radius: 8px; font-family: inherit; font-weight: 500; cursor: pointer; font-size: 13px; transition: opacity 0.15s; }
        .btn-primary:hover { opacity: 0.85; }
        .btn-primary:disabled { opacity: 0.4; cursor: default; }
        .btn-danger { background: #f87171; color: #0d0f14; border: none; padding: 10px 22px; border-radius: 8px; font-family: inherit; font-weight: 500; cursor: pointer; font-size: 13px; }
        .btn-ghost { background: none; border: 1px solid #2a2d38; color: #9ca3af; padding: 10px 18px; border-radius: 8px; font-family: inherit; cursor: pointer; font-size: 13px; transition: all 0.15s; }
        .btn-ghost:hover { border-color: #4b5563; color: #e8eaf0; }
        .inp { background: #1a1d26; border: 1px solid #2a2d38; color: #e8eaf0; padding: 10px 14px; border-radius: 8px; font-family: inherit; font-size: 13px; width: 100%; transition: border-color 0.15s; }
        .inp:focus { border-color: #6ee7b7; }
        .sel { background: #1a1d26; border: 1px solid #2a2d38; color: #e8eaf0; padding: 10px 14px; border-radius: 8px; font-family: inherit; font-size: 13px; width: 100%; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; display: inline-block; }
        @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
        .fade-in { animation: fadeIn 0.2s ease; }
        .sync-pill { display:flex; align-items:center; gap:6px; cursor:pointer; font-size:11px; padding:4px 10px; background:#111320; border-radius:6px; transition: opacity 0.15s; }
        .sync-pill:hover { opacity: 0.8; }
        @keyframes alarm { 0%,100% { box-shadow: 0 0 0 0 rgba(248,113,113,0.45); } 50% { box-shadow: 0 0 0 4px rgba(248,113,113,0); } }
        .sync-alarm { animation: alarm 2s ease-out infinite; }
        .card { background:#111320; border:1px solid #1e2030; border-radius:12px; }
        .lbl { font-size:11px; color:#6b7280; letter-spacing:0.08em; text-transform:uppercase; }
      `}</style>

      <div style={{ borderBottom: "1px solid #1e2030" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 24px", display: "flex", alignItems: "center", height: 60, gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em", flex: 1 }}>
            <span style={{ color: "#6ee7b7" }}>₽</span> wealth tracker
          </div>

          <div className={"sync-pill" + (signedOut ? " sync-alarm" : "")}
            style={signedOut
              ? { border: "1px solid #f87171", background: "#2b1416", color: "#fca5a5", fontWeight: 500 }
              : { border: `1px solid ${syncColor}33`, color: syncColor }}
            title={signedOut ? "Данные сохраняются только в этом браузере" : undefined}
            onClick={() => {
              if (!clientId) { setClientIdDraft(""); setSheetIdDraft(""); setModal("setup"); }
              else if (!token) requestToken();
              else syncNow(token, sheetId);
            }}>
            {syncStatus === "syncing"
              ? <span className="spin">↻</span>
              : <span style={{ fontSize: 14 }}>{signedOut ? "⚠" : "⬡"}</span>}
            <span>{syncStatus === "syncing" ? (syncMsg || "Синхронизация…") : signedOut ? signedOutText : (syncMsg || "Sheets")}</span>
          </div>

          {clientId && (
            <div className="sync-pill" style={{ border: "1px solid #2a2d38", color: "#6b7280", padding: "4px 6px" }}
              onClick={() => { setClientIdDraft(clientId); setSheetIdDraft(sheetId); setModal("setup"); }} title="Настройки Sheets">
              <span style={{ fontSize: 13 }}>⚙</span>
            </div>
          )}

          <div style={{ display: "flex", gap: 2 }}>
            {[["dashboard", "Обзор"], ["returns", "Доходность"], ["accounts", "Счета"], ["history", "История"]].map(([id, label]) => (
              <button key={id} className="tab-btn" onClick={() => setTab(id)}
                style={{ padding: "6px 12px", borderRadius: 6, fontSize: 12, fontFamily: "inherit", color: tab === id ? "#6ee7b7" : "#6b7280", background: tab === id ? "#1a2820" : "none" }}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 24px" }}>

        {signedOut && (live(data.accounts).length > 0 || months.length > 0) && (
          <div style={{ background: "#2b1416", border: "1px solid #f8717166", borderRadius: 10, padding: "12px 16px", marginBottom: 14, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 16 }}>⚠</span>
            <div style={{ flex: 1, minWidth: 220, fontSize: 12, color: "#fca5a5", lineHeight: 1.6 }}>
              <b style={{ color: "#f87171" }}>{signedOutText}.</b>{" "}
              Записи сохраняются только в этом браузере и не попадают в Google Sheets. Если очистить данные сайта — они пропадут.
            </div>
            <button className="btn-primary" style={{ background: "#f87171", fontSize: 12, padding: "7px 14px" }}
              onClick={() => (clientId ? requestToken() : (setClientIdDraft(""), setSheetIdDraft(""), setModal("setup")))}>
              {clientId ? "Войти в Google" : "Настроить"}
            </button>
          </div>
        )}
        {ratesErrors.length > 0 && warn(`Курс не загружен: ${ratesErrors.join(", ")}. Показаны последние известные курсы${rates?.fetchedAt ? ` от ${new Date(rates.fetchedAt).toLocaleString("ru-RU")}` : ""}.`, "#f87171")}
        {ratesErrors.length === 0 && ratesStale && warn(`Курсы не обновлялись с ${new Date(rates.fetchedAt).toLocaleString("ru-RU")}.`)}
        {data.quarantine?.length > 0 && warn(
          `${data.quarantine.length} строк(и) в таблице не удалось прочитать (${[...new Set(data.quarantine.map((q) => q.reason))].join("; ")}). Они не участвуют в расчётах, но сохранены в таблице без изменений.`
        )}
        {notice?.kind === "cost-basis" && (
          <div style={{ background: "#1a1a12", border: "1px solid #fcd34d44", color: "#fcd34d", borderRadius: 10, padding: "10px 14px", fontSize: 12, marginBottom: 14, lineHeight: 1.6, display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ flex: 1 }}>{notice.text}</span>
            <button className="icon-btn" style={{ color: "#fcd34d" }} onClick={() => setNotice(null)}>✕</button>
          </div>
        )}

        {/* ── DASHBOARD ── */}
        {tab === "dashboard" && (
          <div className="fade-in">
            <div className="card" style={{ padding: "20px 22px", marginBottom: 14 }}>
              <div className="lbl" style={{ marginBottom: 12 }}>Итого сейчас</div>
              <div style={{ display: "flex", gap: 20, alignItems: "baseline", flexWrap: "wrap" }}>
                {DISPLAY_CURRENCIES.map((c, i) => (
                  <div key={c}>
                    <span style={{ fontFamily: "'Syne',sans-serif", fontSize: i === 0 ? 36 : 22, fontWeight: i === 0 ? 800 : 700, letterSpacing: "-0.03em", color: i === 0 ? "#e8eaf0" : "#9ca3af" }}>
                      {fmtShort(totals?.[c]?.total)}
                    </span>
                    <span style={{ fontSize: i === 0 ? 16 : 12, color: "#6b7280", marginLeft: 4 }}>{CURRENCY_SYMBOLS[c]}</span>
                  </div>
                ))}
              </div>
              {lastM && (
                <div style={{ fontSize: 12, color: "#4b5563", marginTop: 8 }}>
                  {monthLabel(lastM)}
                  {totals?.RUB?.unconverted?.length > 0 && ` · без ${totals.RUB.unconverted.length} счёт(ов) — нет курса`}
                  {totals?.RUB?.carried?.length > 0 && ` · ${totals.RUB.carried.length} счёт(ов) перенесены с прошлого месяца`}
                </div>
              )}
            </div>

            {/* The month decomposed: v1 showed only the first number. */}
            <div className="card" style={{ padding: "16px 20px", marginBottom: 24 }}>
              <div className="lbl" style={{ marginBottom: 12 }}>
                За месяц {prevRecorded ? `· ${monthLabel(prevRecorded)} → ${monthLabel(lastM)}` : ""}
              </div>
              {change ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 14 }}>
                    {[
                      ["Изменение капитала", change.change, true],
                      ["из них курс", change.fx, false],
                      ["довнесено", change.added, false],
                      ["прочее", change.rest, false],
                    ].map(([label, v, big]) => (
                      <div key={label}>
                        <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>{label}</div>
                        <div style={{ fontFamily: "'Syne',sans-serif", fontSize: big ? 22 : 16, fontWeight: 700, color: v >= 0 ? "#6ee7b7" : "#f87171" }}>
                          {fmtSigned(v)} <span style={{ fontSize: 11, color: "#4b5563" }}>₽</span>
                        </div>
                        {big && (() => {
                          const p = percentChange(change.change, totals ? totals.RUB.total - change.change : null);
                          return <div style={{ fontSize: 11, color: change.change >= 0 ? "#6ee7b7" : "#f87171", marginTop: 2 }}>{p === null ? "—" : `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`}</div>;
                        })()}
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: "#4b5563", marginTop: 12, lineHeight: 1.6 }}>
                    «Изменение» — это не доход. «Курс» — переоценка валютных остатков, «довнесено» — ваши пополнения инвестиционных счетов, «прочее» — всё остальное: доходность, зарплата, траты.
                    {!change.ratesStamped && " Для этих месяцев курс не зафиксирован — используется сегодняшний."}
                  </div>
                </>
              ) : <div style={{ fontSize: 13, color: "#4b5563" }}>Нужно минимум два записанных месяца</div>}
            </div>

            {chart.length > 1 ? (
              <div className="card" style={{ padding: "20px 22px", marginBottom: 24 }}>
                <div className="lbl" style={{ marginBottom: 16 }}>Динамика капитала</div>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={chart} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis dataKey="label" tick={{ fill: "#4b5563", fontSize: 11, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "#4b5563", fontSize: 10, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} tickFormatter={fmtShort} />
                    <Tooltip contentStyle={{ background: "#1a1d26", border: "1px solid #2a2d38", borderRadius: 8, fontFamily: "DM Mono", fontSize: 12 }}
                      labelStyle={{ color: "#9ca3af" }} formatter={(v) => [fmtShort(v) + " ₽", "Итого"]} />
                    <Line type="monotone" dataKey="total" stroke="#6ee7b7" strokeWidth={2} dot={{ fill: "#6ee7b7", r: 3 }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
                {unstampedMonths > 0 && (
                  <div style={{ fontSize: 11, color: "#4b5563", marginTop: 10 }}>
                    Для {unstampedMonths} мес. курс не зафиксирован — они пересчитаны по сегодняшнему курсу и будут меняться вместе с ним. Новые записи фиксируют курс месяца.
                  </div>
                )}
              </div>
            ) : (
              <div className="card" style={{ padding: "36px 22px", marginBottom: 24, textAlign: "center", color: "#4b5563", fontSize: 13 }}>
                Запишите хотя бы 2 месяца чтобы увидеть динамику
              </div>
            )}

            {bd && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14, marginBottom: 24 }}>
                <div className="card" style={{ padding: "16px 20px" }}>
                  <div className="lbl" style={{ marginBottom: 12 }}>По валютам · активы</div>
                  {bd.byCurrency.map(({ currency, native, converted }) => (
                    <div key={currency} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #141620" }}>
                      <div>
                        <span style={{ fontSize: 13 }}>{CURRENCY_SYMBOLS[currency] || currency} {fmtBalance(native, currency)}</span>
                        <span style={{ fontSize: 11, color: "#4b5563", marginLeft: 4 }}>{currency}</span>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 12, color: "#9ca3af" }}>{fmtShort(converted)} ₽</div>
                        {bd.assets > 0 && <div style={{ fontSize: 10, color: "#4b5563" }}>{(converted / bd.assets * 100).toFixed(0)}%</div>}
                      </div>
                    </div>
                  ))}
                  {bd.liabilities > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0 0", fontSize: 11, color: "#f87171" }}>
                      <span>минус долги</span><span>−{fmtShort(bd.liabilities)} ₽</span>
                    </div>
                  )}
                </div>
                <div className="card" style={{ padding: "16px 20px" }}>
                  <div className="lbl" style={{ marginBottom: 12 }}>По инструментам</div>
                  {bd.byType.map(({ type, converted }) => (
                    <div key={type} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #141620" }}>
                      <div style={{ fontSize: 13 }}>{typeIcon(type)} {typeLabel(type)}</div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 12, color: converted < 0 ? "#f87171" : "#9ca3af" }}>{fmtShort(converted)} ₽</div>
                        {bd.assets > 0 && <div style={{ fontSize: 10, color: "#4b5563" }}>{(Math.abs(converted) / bd.assets * 100).toFixed(0)}%</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {accountsNow.length > 0 && (
              <div className="card" style={{ overflow: "hidden", marginBottom: 24 }}>
                <div className="lbl" style={{ padding: "13px 22px", borderBottom: "1px solid #1e2030" }}>Счета · {monthLabel(lastM)}</div>
                {accountsNow.map(({ acc, snap, carried }, i) => {
                  const d = accountDelta(data, acc, lastM, prevRecorded, idx);
                  const p = pnlFor(data, acc, lastM, idx, ratesOf);
                  return (
                    <div key={acc.id} className="acc-row" style={{ display: "flex", alignItems: "center", padding: "13px 22px", borderBottom: i < accountsNow.length - 1 ? "1px solid #141620" : "none" }}>
                      <span style={{ marginRight: 12, fontSize: 16 }}>{typeIcon(acc.type)}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13 }}>{acc.name}</div>
                        <div style={{ fontSize: 11, color: "#4b5563", marginTop: 2 }}>
                          {snap.currency}
                          {carried && <span style={{ color: "#fcd34d", marginLeft: 6 }}>перенесено с {monthLabel(snap.month)}</span>}
                          {p && p.meaningful && (
                            <span style={{ color: p.pnl >= 0 ? "#6ee7b7" : "#f87171", marginLeft: 6 }}>
                              P&L {fmtSigned(p.pnl)} {CURRENCY_SYMBOLS[p.currency] || p.currency}
                              {!p.exact && <span style={{ color: "#fcd34d" }} title="Часть взносов пересчитана по сегодняшнему курсу"> ≈</span>}
                            </span>
                          )}
                          {p && p.basisIsCoins && (
                            <span style={{ color: "#fcd34d", marginLeft: 6 }}>
                              {p.pnl !== 0 ? `${fmtSigned(p.pnl)} ${p.currency} к вложенному · ` : ""}укажите вложения в рублях для доходности
                            </span>
                          )}
                          {p && p.mixed && <span style={{ color: "#fcd34d", marginLeft: 6 }}>взносы в монетах и в валюте вперемешку — доходность не считается</span>}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 14, color: acc.type === "debt" ? "#f87171" : undefined }}>
                          {(acc.type === "debt" ? "−" : "") + fmtBalance(snap.balance, snap.currency) + " " + snap.currency}
                        </div>
                        {d && <div style={{ fontSize: 11, color: d.delta >= 0 ? "#6ee7b7" : "#f87171", marginTop: 2 }}>{fmtSigned(d.delta)}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <button className="btn-primary" onClick={() => openRecord()} disabled={live(data.accounts).length === 0}
              style={{ width: "100%", padding: 14, borderRadius: 10, fontSize: 13 }}>
              + Записать {monthLabel(isMonth(recordMonth) ? recordMonth : currentMonth())}
            </button>
            {live(data.accounts).length === 0 && <div style={{ textAlign: "center", fontSize: 12, color: "#4b5563", marginTop: 10 }}>Сначала добавьте счета во вкладке «Счета»</div>}
          </div>
        )}

        {/* ── ACCOUNTS ── */}
        {tab === "returns" && <ReturnsTab data={data} months={months} idx={idx} ratesOf={ratesOf} />}

        {tab === "accounts" && (
          <div className="fade-in">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700 }}>Счета и вклады</div>
              <button className="btn-primary" onClick={() => setModal("add-account")}>+ Добавить</button>
            </div>
            {live(data.accounts).length === 0 ? (
              <div className="card" style={{ border: "1px dashed #2a2d38", padding: "48px 24px", textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>🏦</div>
                <div style={{ fontSize: 14, color: "#6b7280" }}>Нет счетов. Добавьте первый.</div>
              </div>
            ) : (
              <div className="card" style={{ overflow: "hidden" }}>
                {live(data.accounts).map((acc, i, arr) => {
                  const snaps = live(data.snapshots).filter((s) => s.accountId === acc.id);
                  return (
                    <div key={acc.id} className="acc-row" style={{ display: "flex", alignItems: "center", padding: "14px 22px", borderBottom: i < arr.length - 1 ? "1px solid #141620" : "none", opacity: acc.closedMonth ? 0.5 : 1 }}>
                      <span style={{ marginRight: 12, fontSize: 18 }}>{typeIcon(acc.type)}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14 }}>
                          {acc.name}
                          {acc.closedMonth && <span style={{ fontSize: 11, color: "#f87171", marginLeft: 8 }}>закрыт {monthLabel(acc.closedMonth)}</span>}
                        </div>
                        <div style={{ fontSize: 11, color: "#4b5563", marginTop: 3 }}>{typeLabel(acc.type)} · {acc.currency} · {snaps.length} записей</div>
                      </div>
                      <button className="icon-btn" style={{ color: "#9ca3af" }} title="Редактировать"
                        onClick={() => { setEditAccount({ ...acc }); setModal("edit-account"); }}>✏️</button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="card" style={{ marginTop: 24, padding: "16px 20px" }}>
              <div className="lbl" style={{ marginBottom: 12 }}>Google Sheets</div>
              {isConnected ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 13, color: "#6ee7b7" }}>✓ Подключено · схема v{SCHEMA_VERSION}{revisionRef.current !== null ? ` · ревизия ${revisionRef.current}` : ""}</div>
                    <a href={`https://docs.google.com/spreadsheets/d/${sheetId}`} target="_blank" rel="noreferrer"
                      style={{ fontSize: 11, color: "#6b7280", textDecoration: "underline", marginTop: 4, display: "block" }}>Открыть таблицу ↗</a>
                  </div>
                  <button className="btn-ghost" style={{ fontSize: 12, padding: "6px 12px" }} onClick={disconnect}>Отключить</button>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 13, color: "#f87171" }}>⚠ {clientId ? "Вход не выполнен — данные только в этом браузере" : "Не настроено — данные только в этом браузере"}</div>
                  <button className="btn-primary" style={{ background: "#f87171", fontSize: 12, padding: "7px 14px" }}
                    onClick={() => (clientId ? requestToken() : (setClientIdDraft(""), setSheetIdDraft(""), setModal("setup")))}>
                    {clientId ? "Войти" : "Настроить"}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── HISTORY ── */}
        {tab === "history" && (
          <div className="fade-in">
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700, marginBottom: 20 }}>История</div>
            {months.length === 0 ? (
              <div className="card" style={{ border: "1px dashed #2a2d38", padding: "48px 24px", textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📅</div>
                <div style={{ fontSize: 14, color: "#6b7280" }}>Записей нет.</div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[...months].reverse().map((m, i, rev) => {
                  const pm = rev[i + 1] || null;
                  const total = monthTotal(data, m, BASE_CURRENCY, ratesOf(m).table, idx).total;
                  const ch = pm ? monthlyChange(data, m, pm, BASE_CURRENCY, ratesOf, idx) : null;
                  const isOpen = selectedMonth === m;
                  const rows = accountsInMonth(data, m, idx);
                  return (
                    <div key={m} className="card" style={{ borderColor: isOpen ? "#2a4a3a" : "#1e2030", overflow: "hidden" }}>
                      <div className="month-row" onClick={() => setSelectedMonth(isOpen ? null : m)} style={{ display: "flex", alignItems: "center", padding: "16px 22px" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 15, fontWeight: 700 }}>{monthLabel(m)}</div>
                          <div style={{ fontSize: 11, color: "#4b5563", marginTop: 2 }}>
                            {rows.length} счетов{rows.some((r) => r.carried) ? ` · ${rows.filter((r) => r.carried).length} перенесено` : ""}
                            {!ratesOf(m).stamped && " · курс не зафиксирован"}
                          </div>
                        </div>
                        <div style={{ textAlign: "right", marginRight: 16 }}>
                          <div style={{ fontSize: 16, fontWeight: 600 }}>{fmtShort(total)} ₽</div>
                          {ch && (
                            <div style={{ fontSize: 11, color: ch.change >= 0 ? "#6ee7b7" : "#f87171" }}>
                              {fmtSigned(ch.change)}
                              {ch.fx !== 0 && <span style={{ color: "#4b5563" }}> (курс {fmtSigned(ch.fx)})</span>}
                            </div>
                          )}
                        </div>
                        <span style={{ color: "#4b5563", fontSize: 12 }}>{isOpen ? "▲" : "▼"}</span>
                      </div>
                      {isOpen && (
                        <div style={{ borderTop: "1px solid #1e2030" }}>
                          {rows.map(({ acc, snap, carried }) => {
                            const p = pnlFor(data, acc, m, idx, ratesOf);
                            return (
                              <div key={acc.id} style={{ display: "flex", alignItems: "center", padding: "10px 22px", borderBottom: "1px solid #141620" }}>
                                <span style={{ marginRight: 10, fontSize: 14 }}>{typeIcon(acc.type)}</span>
                                <div style={{ flex: 1, fontSize: 13, color: "#9ca3af" }}>
                                  {acc.name}
                                  {carried && <span style={{ fontSize: 10, color: "#fcd34d", marginLeft: 6 }}>перенесено</span>}
                                </div>
                                <div style={{ textAlign: "right" }}>
                                  <div style={{ fontSize: 13 }}>{fmtBalance(snap.balance, snap.currency)} {snap.currency}</div>
                                  {p && p.meaningful && (
                                    <div style={{ fontSize: 10, color: p.pnl >= 0 ? "#6ee7b7" : "#f87171", marginTop: 2 }}>
                                      вложено {fmtShort(p.basis)} {CURRENCY_SYMBOLS[p.currency] || p.currency} · P&L {fmtSigned(p.pnl)}
                                    </div>
                                  )}
                                  {snap.contributed ? (
                                    <div style={{ fontSize: 10, color: "#4b5563", marginTop: 2 }}>
                                      внесено за месяц {fmtBalance(snap.contributed, snap.contribCurrency)} {snap.contribCurrency}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                          <div style={{ padding: "12px 22px", display: "flex", gap: 10 }}>
                            <button className="btn-ghost" style={{ fontSize: 12, padding: "7px 14px" }} onClick={() => openRecord(m)}>Редактировать</button>
                            <button onClick={() => deleteMonth(m)} style={{ background: "none", border: "1px solid #3a1e1e", color: "#f87171", padding: "7px 14px", borderRadius: 8, fontFamily: "inherit", fontSize: 12, cursor: "pointer" }}>Удалить месяц</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── MODAL: Setup ── */}
      {modal === "setup" && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="fade-in card" style={{ background: "#13151f", borderColor: "#2a2d38", borderRadius: 16, padding: 28, width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto" }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Подключить Google Sheets</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 20, lineHeight: 1.7 }}>
              Данные хранятся в твоей таблице — доступны с любого устройства. Нужен Google Cloud Client ID (бесплатно).
            </div>
            <div style={{ background: "#0d0f14", borderRadius: 10, padding: "16px 18px", marginBottom: 20, fontSize: 12, color: "#9ca3af", lineHeight: 1.8 }}>
              <div style={{ color: "#e8eaf0", fontWeight: 500, marginBottom: 10, fontSize: 13 }}>Как получить Client ID</div>
              <ol style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
                <li>Открой <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer" style={{ color: "#6ee7b7" }}>Google Cloud Console</a> → создай проект</li>
                <li>APIs &amp; Services → Library → включи <b style={{ color: "#e8eaf0" }}>Google Sheets API</b></li>
                <li>OAuth consent screen → External → заполни название</li>
                <li>Credentials → Create Credentials → <b style={{ color: "#e8eaf0" }}>OAuth 2.0 Client ID</b></li>
                <li>Тип приложения: <b style={{ color: "#e8eaf0" }}>Web application</b></li>
                <li>Authorized JavaScript origins — добавь:</li>
              </ol>
              <div style={{ background: "#141620", borderRadius: 6, padding: "8px 12px", marginTop: 8, fontSize: 11, color: "#6ee7b7", wordBreak: "break-all" }}>
                {typeof window !== "undefined" ? window.location.origin : ""}
              </div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>CLIENT ID</div>
              <input className="inp" placeholder="xxxxxxx.apps.googleusercontent.com" value={clientIdDraft} onChange={(e) => setClientIdDraft(e.target.value)} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>GOOGLE SHEET <span style={{ opacity: 0.6 }}>(необязательно)</span></div>
              <input className="inp" placeholder="Ссылка на таблицу или ID — оставь пустым для новой" value={sheetIdDraft} onChange={(e) => setSheetIdDraft(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setModal(null)}>Отмена</button>
              <button className="btn-primary" style={{ flex: 2 }} onClick={saveClientId} disabled={!clientIdDraft.trim()}>Сохранить и войти →</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: Add account ── */}
      {modal === "add-account" && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="fade-in card" style={{ background: "#13151f", borderColor: "#2a2d38", borderRadius: 16, padding: 28, width: "100%", maxWidth: 400 }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 18, fontWeight: 700, marginBottom: 22 }}>Новый счёт</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div><div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>НАЗВАНИЕ</div>
                <input className="inp" placeholder="Сбербанк накопительный" value={newAccount.name}
                  onChange={(e) => setNewAccount({ ...newAccount, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && addAccount()} /></div>
              <div><div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>ТИП</div>
                <select className="sel" value={newAccount.type} onChange={(e) => setNewAccount({ ...newAccount, type: e.target.value })}>
                  {ACCOUNT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}</select></div>
              <div><div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>ВАЛЮТА</div>
                <select className="sel" value={newAccount.currency} onChange={(e) => setNewAccount({ ...newAccount, currency: e.target.value })}>
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setModal(null)}>Отмена</button>
              <button className="btn-primary" style={{ flex: 2 }} onClick={addAccount}>Добавить</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: Edit account ── */}
      {modal === "edit-account" && editAccount && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="fade-in card" style={{ background: "#13151f", borderColor: "#2a2d38", borderRadius: 16, padding: 28, width: "100%", maxWidth: 400 }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 18, fontWeight: 700, marginBottom: 22 }}>Редактировать</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div><div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>НАЗВАНИЕ</div>
                <input className="inp" value={editAccount.name} onChange={(e) => setEditAccount({ ...editAccount, name: e.target.value })} /></div>
              <div><div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>ТИП</div>
                <select className="sel" value={editAccount.type} onChange={(e) => setEditAccount({ ...editAccount, type: e.target.value })}>
                  {ACCOUNT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}</select></div>
              <div><div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>ВАЛЮТА</div>
                <select className="sel" value={editAccount.currency} onChange={(e) => setEditAccount({ ...editAccount, currency: e.target.value })}>
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                <div style={{ fontSize: 10, color: "#4b5563", marginTop: 6 }}>Записи за прошлые месяцы сохранят свою валюту.</div></div>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setModal(null)}>Отмена</button>
              <button className="btn-primary" style={{ flex: 2 }} onClick={updateAccount}>Сохранить</button>
            </div>
            <div style={{ borderTop: "1px solid #1e2030", marginTop: 20, paddingTop: 16, display: "flex", justifyContent: "space-between", gap: 10 }}>
              {editAccount.closedMonth ? (
                <button className="btn-ghost" style={{ fontSize: 12, color: "#6ee7b7", borderColor: "#2a4a3a" }} onClick={() => reopenAccount(editAccount)}>Открыть счёт</button>
              ) : (
                <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => closeAccount(editAccount)}>Закрыть счёт</button>
              )}
              <button className="btn-ghost" style={{ fontSize: 12, color: "#f87171", borderColor: "#3a1e1e" }} onClick={() => deleteAccount(editAccount)}>Удалить</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: Record ── */}
      {modal === "record" && (
        <div className="modal-overlay">
          <div className="fade-in card" style={{ background: "#13151f", borderColor: "#2a2d38", borderRadius: 16, padding: 28, width: "100%", maxWidth: 440, maxHeight: "90vh", overflowY: "auto" }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 18, fontWeight: 700, marginBottom: 14 }}>Записать состояние</div>
            <input type="month" className="inp" value={recordMonth} style={{ marginBottom: 18 }}
              onChange={(e) => {
                const mn = e.target.value;
                setRecordMonth(mn);
                if (isMonth(mn)) setForm(buildForm(mn));   // v1 crashed on an empty value
              }} />
            {!isMonth(recordMonth) && <div style={{ fontSize: 12, color: "#f87171", marginBottom: 12 }}>Укажите месяц</div>}

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {formAccounts.map((acc) => {
                const f = form[acc.id] || { balance: "", contributed: "", contribCurrency: acc.currency };
                const set = (patch) => setForm((prev) => ({ ...prev, [acc.id]: { ...(prev[acc.id] || f), ...patch } }));
                return (
                  <div key={acc.id}>
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <span>{typeIcon(acc.type)}</span><span>{acc.name.toUpperCase()}</span>
                      <span style={{ color: "#4b5563" }}>· {acc.currency}</span>
                      {acc.type === "debt" && <span style={{ color: "#f87171" }}>· долг</span>}
                    </div>
                    {formErrors[acc.id] && (
                      <div style={{ fontSize: 10, color: "#f87171", marginBottom: 4 }}>{formErrors[acc.id]}</div>
                    )}
                    {HAS_PNL.has(acc.type) ? (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <div style={{ flex: "1 1 120px" }}>
                          <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 4 }}>Стоимость, {acc.currency}</div>
                          <input className="inp" inputMode="decimal" placeholder="0" value={f.balance} onChange={(e) => set({ balance: e.target.value })} />
                        </div>
                        <div style={{ flex: "1 1 120px" }}>
                          <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 4 }}>Внесено за месяц</div>
                          <div style={{ display: "flex", gap: 4 }}>
                            <input className="inp" inputMode="decimal" placeholder="—" value={f.contributed} onChange={(e) => set({ contributed: e.target.value })} />
                            <select className="sel" style={{ width: 78, padding: "10px 6px" }} value={f.contribCurrency} onChange={(e) => set({ contribCurrency: e.target.value })}>
                              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <input className="inp" inputMode="decimal" placeholder="0" value={f.balance} onChange={(e) => set({ balance: e.target.value })} />
                    )}
                  </div>
                );
              })}
              {formAccounts.length === 0 && <div style={{ fontSize: 12, color: "#4b5563" }}>Ни один счёт не был открыт в этом месяце.</div>}
            </div>

            {Object.keys(formErrors).length > 0 && (
              <div style={{ fontSize: 11, color: "#f87171", marginTop: 12 }}>
                Исправьте выделенные значения — иначе они молча не сохранятся.
              </div>
            )}
            <div style={{ fontSize: 10, color: "#4b5563", marginTop: 12, lineHeight: 1.6 }}>
              «Внесено за месяц» — сколько денег вы добавили именно в этом месяце (вывод — со знаком минус). Пусто = не указано. Для крипто-счетов указывайте сумму в рублях, иначе доходность не посчитается.
            </div>

            <div style={{ marginTop: 14, padding: "12px 16px", background: "#0d0f14", borderRadius: 8, fontSize: 13, color: "#9ca3af", display: "flex", justifyContent: "space-between" }}>
              <span>Итого</span><span style={{ color: "#6ee7b7" }}>{fmtShort(formTotal)} ₽</span>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setModal(null)}>Отмена</button>
              <button className="btn-primary" style={{ flex: 2 }} onClick={saveRecord}
                disabled={!isMonth(recordMonth) || syncStatus === "syncing" || Object.keys(formErrors).length > 0}>
                {syncStatus === "syncing" ? <span><span className="spin">↻</span> Сохраняю…</span> : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: Confirm ── */}
      {confirm && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setConfirm(null)}>
          <div className="fade-in card" style={{ background: "#13151f", borderColor: "#2a2d38", borderRadius: 16, padding: 26, width: "100%", maxWidth: 380 }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 16, fontWeight: 700, marginBottom: 10 }}>{confirm.title}</div>
            <div style={{ fontSize: 12, color: "#9ca3af", lineHeight: 1.7, marginBottom: 22 }}>{confirm.body}</div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setConfirm(null)}>Отмена</button>
              <button className={confirm.danger ? "btn-danger" : "btn-primary"} style={{ flex: 2 }} onClick={confirm.onConfirm}>{confirm.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
