import { useState, useEffect, useCallback, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

const LS_KEY = "money-tracker-v1";
const LS_GSHEET = "money-tracker-gsheet";
const LS_CLIENT = "money-tracker-client-id";
const LS_RATES = "money-tracker-rates";
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const DISPLAY_CURRENCIES = ["RUB", "USD", "EUR"];
const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", GBP: "£", AED: "د.إ", BTC: "₿", ETH: "Ξ", USDT: "₮", SOL: "◎", TON: "💎" };

const ACCOUNT_TYPES = [
  { id: "checking", label: "Расчётный счёт", icon: "💳" },
  { id: "savings", label: "Накопительный", icon: "🏦" },
  { id: "deposit", label: "Вклад", icon: "📈" },
  { id: "cash", label: "Наличные", icon: "💵" },
  { id: "investment", label: "Инвестиции", icon: "📊" },
  { id: "crypto", label: "Крипто", icon: "🪙" },
  { id: "debt", label: "Долг", icon: "🔻" },
  { id: "other", label: "Другое", icon: "🗂️" },
];
const FIAT_CURRENCIES = ["RUB", "USD", "EUR", "GBP", "AED"];
const CRYPTO_CURRENCIES = ["BTC", "ETH", "USDT", "SOL", "TON"];
const CURRENCIES = [...FIAT_CURRENCIES, ...CRYPTO_CURRENCIES];
const CRYPTO_IDS = { BTC: "bitcoin", ETH: "ethereum", USDT: "tether", SOL: "solana", TON: "the-open-network" };
const HAS_PNL = new Set(["investment", "crypto"]);

const fmtShort = (n) => {
  if (isNaN(n) || n === null) return "—";
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(0) + "K";
  if (Math.abs(n) < 1 && n !== 0) return Number(n).toPrecision(3);
  return Number(n).toFixed(0);
};

const fmtBalance = (n, currency) => {
  if (isNaN(n) || n === null) return "—";
  if (CRYPTO_CURRENCIES.includes(currency)) return String(n);
  return fmtShort(n);
};

const monthLabel = (ym) => {
  if (!ym) return "";
  const [y, m] = ym.split("-");
  const months = ["Янв","Фев","Мар","Апр","Май","Июн","Июл","Авг","Сен","Окт","Ноя","Дек"];
  return months[parseInt(m) - 1] + " " + y;
};

const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// ── Sheets API ────────────────────────────────────────────────────────────────
const sheetsGet = async (token, sid, range) => {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(`Sheets GET ${r.status}`);
  return r.json();
};
const sheetsClear = async (token, sid, range) => {
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}:clear`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } }
  );
};
const sheetsUpdate = async (token, sid, range, values) => {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values }) }
  );
  if (!r.ok) throw new Error(`Sheets update failed: ${r.status}`);
};
const createSpreadsheet = async (token) => {
  const r = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { title: "Wealth Tracker" }, sheets: [{ properties: { title: "Accounts" } }, { properties: { title: "Snapshots" } }] }),
  });
  if (!r.ok) throw new Error("Cannot create spreadsheet");
  return (await r.json()).spreadsheetId;
};
const readFromSheets = async (token, sid) => {
  const [accRes, snapRes] = await Promise.all([sheetsGet(token, sid, "Accounts!A2:F"), sheetsGet(token, sid, "Snapshots!A2:E")]);
  const accounts = (accRes.values || []).map(([id, name, type, currency, closed, closedMonth]) => ({ id, name, type, currency, ...(closed === "true" ? { closed: true, closedMonth: closedMonth || undefined } : {}) }));
  const snapshots = (snapRes.values || []).map(([id, accountId, month, balance, invested]) => ({ id, accountId, month, balance: parseFloat(balance), ...(invested ? { invested: parseFloat(invested) } : {}) }));
  return { accounts, snapshots };
};
const writeToSheets = async (token, sid, data) => {
  await sheetsClear(token, sid, "Accounts!A1:Z");
  await sheetsClear(token, sid, "Snapshots!A1:Z");
  await sheetsUpdate(token, sid, "Accounts!A1", [["id","name","type","currency","closed","closedMonth"], ...data.accounts.map(a => [a.id,a.name,a.type,a.currency,a.closed ? "true" : "",a.closedMonth || ""])]);
  await sheetsUpdate(token, sid, "Snapshots!A1", [["id","accountId","month","balance","invested"], ...data.snapshots.map(s => [s.id,s.accountId,s.month,String(s.balance),s.invested != null ? String(s.invested) : ""])]);
};

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData] = useState({ accounts: [], snapshots: [] });
  const [tab, setTab] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [newAccount, setNewAccount] = useState({ name: "", type: "savings", currency: "RUB" });
  const [editAccount, setEditAccount] = useState(null);
  const [recordMonth, setRecordMonth] = useState(currentMonth());
  const [recordValues, setRecordValues] = useState({});
  const [recordInvested, setRecordInvested] = useState({});
  const [selectedMonth, setSelectedMonth] = useState(null);

  const [rates, setRates] = useState(() => {
    try { const cached = JSON.parse(localStorage.getItem(LS_RATES)); if (cached?.rates) return cached; } catch {}
    return null;
  });
  const [ratesErrors, setRatesErrors] = useState([]);

  useEffect(() => {
    const errors = [];
    Promise.all([
      fetch("https://open.er-api.com/v6/latest/USD").then(r => r.json()).catch(() => { errors.push("open.er-api.com (фиат)"); return null; }),
      fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(CRYPTO_IDS).join(",")}&vs_currencies=usd`).then(r => r.json()).catch(() => { errors.push("CoinGecko (крипто)"); return null; }),
    ]).then(([fiat, crypto]) => {
      if (!fiat || fiat.result !== "success") { errors.push("open.er-api.com (фиат)"); setRatesErrors([...new Set(errors)]); return; }
      if (crypto) {
        Object.entries(CRYPTO_IDS).forEach(([sym, id]) => {
          if (crypto[id]?.usd) fiat.rates[sym] = 1 / crypto[id].usd;
        });
      } else if (!errors.includes("CoinGecko (крипто)")) {
        errors.push("CoinGecko (крипто)");
      }
      setRates(fiat);
      localStorage.setItem(LS_RATES, JSON.stringify(fiat));
      setRatesErrors([...new Set(errors)]);
    }).catch(() => { setRatesErrors(["open.er-api.com (фиат)", "CoinGecko (крипто)"]); });
  }, []);

  const convert = (amount, from, to) => {
    if (from === to) return amount;
    if (!rates?.rates || !rates.rates[from] || !rates.rates[to]) return NaN;
    return amount / rates.rates[from] * rates.rates[to];
  };

  const [clientId, setClientId] = useState(() => localStorage.getItem(LS_CLIENT) || "");
  const [clientIdDraft, setClientIdDraft] = useState("");
  const [sheetIdDraft, setSheetIdDraft] = useState("");
  const [token, setToken] = useState(null);
  const [sheetId, setSheetId] = useState(() => localStorage.getItem(LS_GSHEET) || "");
  const [syncStatus, setSyncStatus] = useState("idle");
  const [syncMsg, setSyncMsg] = useState("");
  const tokenClientRef = useRef(null);

  useEffect(() => {
    try { const raw = localStorage.getItem(LS_KEY); if (raw) setData(JSON.parse(raw)); } catch {}
  }, []);

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
          await syncFrom(resp.access_token, sheetId);
        },
      });
    };
    if (window.google) { load(); return; }
    const existing = document.getElementById("gsi-script");
    if (existing) { existing.addEventListener("load", load); return; }
    const s = document.createElement("script");
    s.id = "gsi-script";
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = load;
    document.head.appendChild(s);
  }, [clientId]);

  const requestToken = () => { if (tokenClientRef.current) tokenClientRef.current.requestAccessToken(); };

  const syncFrom = async (tk, sid) => {
    setSyncStatus("syncing"); setSyncMsg("Загрузка…");
    try {
      let id = sid;
      if (!id) {
        id = await createSpreadsheet(tk);
        setSheetId(id); localStorage.setItem(LS_GSHEET, id);
      }
      const remote = await readFromSheets(tk, id);
      if (remote.accounts.length > 0 || remote.snapshots.length > 0) {
        setData(remote); localStorage.setItem(LS_KEY, JSON.stringify(remote));
        setSyncMsg("Синхронизировано ✓");
      } else {
        const local = JSON.parse(localStorage.getItem(LS_KEY) || '{"accounts":[],"snapshots":[]}');
        await writeToSheets(tk, id, local);
        setSyncMsg("Загружено в Sheets ✓");
      }
      setSyncStatus("ok");
    } catch (e) { setSyncStatus("error"); setSyncMsg("Ошибка: " + e.message); }
  };

  const syncTo = useCallback(async (next, tk = token, sid = sheetId) => {
    if (!tk || !sid) { setSyncStatus("error"); setSyncMsg("Не подключено к Sheets"); return; }
    setSyncStatus("syncing");
    try { await writeToSheets(tk, sid, next); setSyncStatus("ok"); setSyncMsg("Сохранено ✓"); }
    catch (e) { setSyncStatus("error"); setSyncMsg("Ошибка записи: " + e.message); }
  }, [token, sheetId]);

  const save = useCallback((next) => {
    setData(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
    syncTo(next);
  }, [syncTo]);

  const isClosedAt = (acc, month) => acc.closed && acc.closedMonth && month > acc.closedMonth;

  const balSign = (acc) => acc?.type === "debt" ? -1 : 1;

  const monthTotal = (m, toCurrency) => {
    return data.snapshots
      .filter(s => s.month === m && !isClosedAt(data.accounts.find(a => a.id === s.accountId) || {}, m))
      .reduce((sum, s) => {
        const acc = data.accounts.find(a => a.id === s.accountId);
        const bal = parseFloat(s.balance) || 0;
        const converted = toCurrency && acc ? convert(bal, acc.currency, toCurrency) : bal;
        return sum + converted * balSign(acc);
      }, 0);
  };

  const months = [...new Set(data.snapshots.map(s => s.month))].sort();
  const totalByMonth = months.map(m => ({ month: m, label: monthLabel(m), total: monthTotal(m, "RUB") }));
  const latestTotals = Object.fromEntries(DISPLAY_CURRENCIES.map(c => [c, months.length > 0 ? monthTotal(months[months.length - 1], c) : 0]));
  const prevTotals = Object.fromEntries(DISPLAY_CURRENCIES.map(c => [c, months.length > 1 ? monthTotal(months[months.length - 2], c) : null]));
  const deltas = Object.fromEntries(DISPLAY_CURRENCIES.map(c => [c, prevTotals[c] !== null ? latestTotals[c] - prevTotals[c] : null]));

  const getSnapshot = (accountId, month) => data.snapshots.find(s => s.accountId === accountId && s.month === month);

  const activeAccounts = data.accounts.filter(a => !a.closed);

  const openRecord = (m) => {
    const mn = m || recordMonth;
    setRecordMonth(mn);
    const vals = {}, inv = {};
    activeAccounts.forEach(a => {
      const snap = getSnapshot(a.id, mn);
      vals[a.id] = snap ? String(snap.balance) : "";
      if (HAS_PNL.has(a.type)) inv[a.id] = snap?.invested != null ? String(snap.invested) : "";
    });
    setRecordValues(vals);
    setRecordInvested(inv);
    setModal("record");
  };

  const saveRecord = () => {
    const next = { ...data, snapshots: [...data.snapshots] };
    Object.entries(recordValues).forEach(([accountId, val]) => {
      if (val === "") return;
      const balance = parseFloat(val.replace(/\s/g, "").replace(",", "."));
      if (isNaN(balance)) return;
      const acc = data.accounts.find(a => a.id === accountId);
      const invested = HAS_PNL.has(acc?.type) && recordInvested[accountId] !== "" ? parseFloat((recordInvested[accountId] || "").replace(/\s/g, "").replace(",", ".")) : undefined;
      const idx = next.snapshots.findIndex(s => s.accountId === accountId && s.month === recordMonth);
      const snap = { balance, ...(invested != null && !isNaN(invested) ? { invested } : {}) };
      if (idx >= 0) next.snapshots[idx] = { ...next.snapshots[idx], ...snap };
      else next.snapshots.push({ id: crypto.randomUUID(), accountId, month: recordMonth, ...snap });
    });
    save(next); setModal(null);
  };

  const addAccount = () => {
    if (!newAccount.name.trim()) return;
    save({ ...data, accounts: [...data.accounts, { id: crypto.randomUUID(), ...newAccount, name: newAccount.name.trim() }] });
    setNewAccount({ name: "", type: "savings", currency: "RUB" }); setModal(null);
  };

  const updateAccount = () => {
    save({ ...data, accounts: data.accounts.map(a => a.id === editAccount.id ? editAccount : a) });
    setModal(null); setEditAccount(null);
  };

  const closeAccount = (id) => save({ ...data, accounts: data.accounts.map(a => a.id === id ? { ...a, closed: true, closedMonth: currentMonth() } : a) });
  const reopenAccount = (id) => save({ ...data, accounts: data.accounts.map(a => a.id === id ? { ...a, closed: false, closedMonth: undefined } : a) });

  const deleteAccount = (id) => save({ accounts: data.accounts.filter(a => a.id !== id), snapshots: data.snapshots.filter(s => s.accountId !== id) });
  const deleteMonth = (month) => { save({ ...data, snapshots: data.snapshots.filter(s => s.month !== month) }); setSelectedMonth(null); };

  const saveClientId = () => {
    localStorage.setItem(LS_CLIENT, clientIdDraft); setClientId(clientIdDraft);
    const trimmedSheet = sheetIdDraft.trim();
    if (trimmedSheet) {
      const match = trimmedSheet.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      const id = match ? match[1] : trimmedSheet;
      setSheetId(id); localStorage.setItem(LS_GSHEET, id);
    }
    setModal(null);
  };
  const disconnect = () => { setToken(null); setSheetId(""); setClientId(""); localStorage.removeItem(LS_GSHEET); localStorage.removeItem(LS_CLIENT); setSyncStatus("idle"); setSyncMsg(""); };

  const typeIcon = (type) => ACCOUNT_TYPES.find(t => t.id === type)?.icon || "🗂️";
  const isConnected = !!token && !!sheetId;
  const syncColor = { idle: "#4b5563", syncing: "#fcd34d", ok: "#6ee7b7", error: "#f87171" }[syncStatus];

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
        .del-btn { opacity: 0; transition: opacity 0.15s; background: none; border: none; cursor: pointer; padding: 2px 6px; font-size: 14px; }
        .acc-row:hover .del-btn { opacity: 1; }
        .month-row:hover { background: #1a1d26 !important; cursor: pointer; }
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center; z-index: 100; backdrop-filter: blur(4px); }
        .btn-primary { background: #6ee7b7; color: #0d0f14; border: none; padding: 10px 22px; border-radius: 8px; font-family: inherit; font-weight: 500; cursor: pointer; font-size: 13px; transition: opacity 0.15s; }
        .btn-primary:hover { opacity: 0.85; }
        .btn-primary:disabled { opacity: 0.4; cursor: default; }
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
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #1e2030" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 24px", display: "flex", alignItems: "center", height: 60, gap: 12 }}>
          <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em", flex: 1 }}>
            <span style={{ color: "#6ee7b7" }}>₽</span> wealth tracker
          </div>

          <div className="sync-pill" style={{ border: `1px solid ${syncColor}33`, color: syncColor }}
            onClick={() => {
              if (!clientId) { setClientIdDraft(""); setSheetIdDraft(""); setModal("setup"); }
              else if (!token) requestToken();
              else syncFrom(token, sheetId);
            }}>
            {syncStatus === "syncing" ? <span className="spin">↻</span> : <span style={{ fontSize: 14 }}>⬡</span>}
            <span>{syncStatus === "idle" ? (clientId ? "Войти в Google" : "Настроить Sheets") : (syncMsg || "Sheets")}</span>
          </div>

          {clientId && (
            <div className="sync-pill" style={{ border: "1px solid #2a2d38", color: "#6b7280", padding: "4px 6px" }}
              onClick={() => { setClientIdDraft(clientId); setSheetIdDraft(sheetId); setModal("setup"); }}
              title="Настройки Sheets">
              <span style={{ fontSize: 13 }}>⚙</span>
            </div>
          )}

          {ratesErrors.length > 0 && (
            <div className="sync-pill" style={{ border: "1px solid #f8717133", color: "#f87171" }} title={ratesErrors.join(", ")}>
              <span style={{ fontSize: 14 }}>⚠</span>
              <span>Курс: {ratesErrors.join(", ")}</span>
            </div>
          )}

          <div style={{ display: "flex", gap: 2 }}>
            {[["dashboard","Обзор"],["accounts","Счета"],["history","История"]].map(([id, label]) => (
              <button key={id} className="tab-btn" onClick={() => setTab(id)} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 12, fontFamily: "inherit", color: tab === id ? "#6ee7b7" : "#6b7280", background: tab === id ? "#1a2820" : "none" }}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 24px" }}>

        {/* ── DASHBOARD ── */}
        {tab === "dashboard" && (
          <div className="fade-in">
            <div style={{ background: "#111320", border: "1px solid #1e2030", borderRadius: 12, padding: "20px 22px", marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>Итого сейчас</div>
              <div style={{ display: "flex", gap: 20, alignItems: "baseline", flexWrap: "wrap" }}>
                {DISPLAY_CURRENCIES.map((c, i) => (
                  <div key={c}>
                    <span style={{ fontFamily: "'Syne',sans-serif", fontSize: i === 0 ? 36 : 22, fontWeight: i === 0 ? 800 : 700, letterSpacing: "-0.03em", color: i === 0 ? "#e8eaf0" : "#9ca3af" }}>
                      {fmtShort(latestTotals[c])}
                    </span>
                    <span style={{ fontSize: i === 0 ? 16 : 12, color: "#6b7280", fontWeight: 400, marginLeft: 4 }}>{CURRENCY_SYMBOLS[c]}</span>
                  </div>
                ))}
              </div>
              {months.length > 0 && <div style={{ fontSize: 12, color: "#4b5563", marginTop: 8 }}>{monthLabel(months[months.length - 1])}{!rates && " · курс не загружен"}</div>}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 24 }}>
              {DISPLAY_CURRENCIES.map(c => {
                const d = deltas[c];
                const prev = prevTotals[c];
                return (
                  <div key={c} style={{ background: "#111320", border: "1px solid #1e2030", borderRadius: 12, padding: "16px 18px" }}>
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, letterSpacing: "0.08em", textTransform: "uppercase" }}>За месяц · {CURRENCY_SYMBOLS[c]}</div>
                    {d !== null ? (
                      <>
                        <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700, color: d >= 0 ? "#6ee7b7" : "#f87171" }}>{d >= 0 ? "+" : ""}{fmtShort(d)}</div>
                        <div style={{ fontSize: 11, color: d >= 0 ? "#6ee7b7" : "#f87171", marginTop: 3 }}>{prev ? ((d / prev) * 100).toFixed(1) : "0"}%</div>
                      </>
                    ) : <div style={{ fontSize: 13, color: "#4b5563" }}>—</div>}
                  </div>
                );
              })}
            </div>

            {totalByMonth.length > 1 ? (
              <div style={{ background: "#111320", border: "1px solid #1e2030", borderRadius: 12, padding: "20px 22px", marginBottom: 24 }}>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 16, letterSpacing: "0.08em", textTransform: "uppercase" }}>Динамика капитала</div>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={totalByMonth} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis dataKey="label" tick={{ fill: "#4b5563", fontSize: 11, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "#4b5563", fontSize: 10, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} tickFormatter={fmtShort} />
                    <Tooltip contentStyle={{ background: "#1a1d26", border: "1px solid #2a2d38", borderRadius: 8, fontFamily: "DM Mono", fontSize: 12 }} labelStyle={{ color: "#9ca3af" }} formatter={(v) => [fmtShort(v) + " " + CURRENCY_SYMBOLS.RUB, "Итого"]} />
                    <Line type="monotone" dataKey="total" stroke="#6ee7b7" strokeWidth={2} dot={{ fill: "#6ee7b7", r: 3 }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div style={{ background: "#111320", border: "1px solid #1e2030", borderRadius: 12, padding: "36px 22px", marginBottom: 24, textAlign: "center", color: "#4b5563", fontSize: 13 }}>
                Запишите хотя бы 2 месяца чтобы увидеть динамику
              </div>
            )}

            {activeAccounts.length > 0 && months.length > 0 && (() => {
              const lastM = months[months.length - 1];
              const rubTotal = latestTotals["RUB"] || 0;

              const byCurrency = {};
              activeAccounts.forEach(acc => {
                if (acc.type === "debt") return;
                const snap = getSnapshot(acc.id, lastM);
                if (!snap) return;
                if (!byCurrency[acc.currency]) byCurrency[acc.currency] = { sum: 0, rubSum: 0 };
                byCurrency[acc.currency].sum += snap.balance;
                byCurrency[acc.currency].rubSum += convert(snap.balance, acc.currency, "RUB");
              });

              const byType = {};
              activeAccounts.forEach(acc => {
                const snap = getSnapshot(acc.id, lastM);
                if (!snap) return;
                const t = ACCOUNT_TYPES.find(t => t.id === acc.type) || { id: acc.type, label: acc.type, icon: "🗂️" };
                if (!byType[t.id]) byType[t.id] = { label: t.label, icon: t.icon, rubSum: 0 };
                byType[t.id].rubSum += convert(snap.balance, acc.currency, "RUB") * balSign(acc);
              });

              const assetsRubTotal = Object.values(byCurrency).reduce((s, { rubSum }) => s + (rubSum || 0), 0);

              return (<>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 24 }}>
                  <div style={{ background: "#111320", border: "1px solid #1e2030", borderRadius: 12, padding: "16px 20px" }}>
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>По валютам</div>
                    {Object.entries(byCurrency).sort((a, b) => b[1].rubSum - a[1].rubSum).map(([cur, { sum, rubSum }]) => (
                      <div key={cur} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #141620" }}>
                        <div>
                          <span style={{ fontSize: 13 }}>{CURRENCY_SYMBOLS[cur] || cur} {fmtBalance(sum, cur)}</span>
                          <span style={{ fontSize: 11, color: "#4b5563", marginLeft: 4 }}>{cur}</span>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 12, color: "#9ca3af" }}>{fmtShort(rubSum)} ₽</div>
                          {assetsRubTotal > 0 && <div style={{ fontSize: 10, color: "#4b5563" }}>{(rubSum / assetsRubTotal * 100).toFixed(0)}%</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ background: "#111320", border: "1px solid #1e2030", borderRadius: 12, padding: "16px 20px" }}>
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>По инструментам</div>
                    {Object.values(byType).sort((a, b) => b.rubSum - a.rubSum).map(({ label, icon, rubSum }) => (
                      <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #141620" }}>
                        <div style={{ fontSize: 13 }}>{icon} {label}</div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 12, color: "#9ca3af" }}>{fmtShort(rubSum)} ₽</div>
                          {rubTotal > 0 && <div style={{ fontSize: 10, color: "#4b5563" }}>{(rubSum / rubTotal * 100).toFixed(0)}%</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>);
            })()}

            {activeAccounts.length > 0 && months.length > 0 && (
              <div style={{ background: "#111320", border: "1px solid #1e2030", borderRadius: 12, overflow: "hidden", marginBottom: 24 }}>
                <div style={{ padding: "13px 22px", borderBottom: "1px solid #1e2030", fontSize: 11, color: "#6b7280", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  Счета · {monthLabel(months[months.length - 1])}
                </div>
                {activeAccounts.map((acc, i) => {
                  const snap = getSnapshot(acc.id, months[months.length - 1]);
                  const prevSnap = months.length > 1 ? getSnapshot(acc.id, months[months.length - 2]) : null;
                  const d = snap && prevSnap ? snap.balance - prevSnap.balance : null;
                  const pnl = HAS_PNL.has(acc.type) && snap?.invested != null ? snap.balance - snap.invested : null;
                  return (
                    <div key={acc.id} className="acc-row" style={{ display: "flex", alignItems: "center", padding: "13px 22px", borderBottom: i < activeAccounts.length - 1 ? "1px solid #141620" : "none", transition: "background 0.1s" }}>
                      <span style={{ marginRight: 12, fontSize: 16 }}>{typeIcon(acc.type)}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13 }}>{acc.name}</div>
                        <div style={{ fontSize: 11, color: "#4b5563", marginTop: 2 }}>{acc.currency}{pnl != null && <span style={{ color: pnl >= 0 ? "#6ee7b7" : "#f87171", marginLeft: 6 }}>P&L {pnl >= 0 ? "+" : ""}{fmtShort(pnl)}</span>}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 14, color: acc.type === "debt" ? "#f87171" : undefined }}>{snap ? (acc.type === "debt" ? "−" : "") + fmtBalance(snap.balance, acc.currency) + " " + acc.currency : "—"}</div>
                        {d !== null && <div style={{ fontSize: 11, color: d >= 0 ? "#6ee7b7" : "#f87171", marginTop: 2 }}>{d >= 0 ? "+" : ""}{fmtShort(d)}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <button className="btn-primary" onClick={() => openRecord()} disabled={activeAccounts.length === 0} style={{ width: "100%", padding: 14, borderRadius: 10, fontSize: 13 }}>
              + Записать {monthLabel(recordMonth)}
            </button>
            {activeAccounts.length === 0 && <div style={{ textAlign: "center", fontSize: 12, color: "#4b5563", marginTop: 10 }}>{data.accounts.length === 0 ? "Сначала добавьте счета во вкладке «Счета»" : "Все счета закрыты"}</div>}
          </div>
        )}

        {/* ── ACCOUNTS ── */}
        {tab === "accounts" && (
          <div className="fade-in">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700 }}>Счета и вклады</div>
              <button className="btn-primary" onClick={() => setModal("add-account")}>+ Добавить</button>
            </div>
            {data.accounts.length === 0 ? (
              <div style={{ background: "#111320", border: "1px dashed #2a2d38", borderRadius: 12, padding: "48px 24px", textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>🏦</div>
                <div style={{ fontSize: 14, color: "#6b7280" }}>Нет счетов. Добавьте первый.</div>
              </div>
            ) : (
              <div style={{ background: "#111320", border: "1px solid #1e2030", borderRadius: 12, overflow: "hidden" }}>
                {data.accounts.map((acc, i) => {
                  const snaps = data.snapshots.filter(s => s.accountId === acc.id);
                  return (
                    <div key={acc.id} className="acc-row" style={{ display: "flex", alignItems: "center", padding: "14px 22px", borderBottom: i < data.accounts.length - 1 ? "1px solid #141620" : "none", transition: "background 0.1s", opacity: acc.closed ? 0.45 : 1 }}>
                      <span style={{ marginRight: 12, fontSize: 18 }}>{typeIcon(acc.type)}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14 }}>{acc.name}{acc.closed && <span style={{ fontSize: 11, color: "#f87171", marginLeft: 8 }}>закрыт</span>}</div>
                        <div style={{ fontSize: 11, color: "#4b5563", marginTop: 3 }}>{ACCOUNT_TYPES.find(t => t.id === acc.type)?.label} · {acc.currency} · {snaps.length} записей</div>
                      </div>
                      <button className="del-btn" style={{ color: "#9ca3af" }} onClick={() => { setEditAccount({ ...acc }); setModal("edit-account"); }}>✏️</button>
                      <button className="del-btn" style={{ color: "#ef4444" }} onClick={() => deleteAccount(acc.id)}>✕</button>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ marginTop: 24, background: "#111320", border: "1px solid #1e2030", borderRadius: 12, padding: "16px 20px" }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>Google Sheets</div>
              {isConnected ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontSize: 13, color: "#6ee7b7" }}>✓ Подключено</div>
                    <a href={`https://docs.google.com/spreadsheets/d/${sheetId}`} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#6b7280", textDecoration: "underline", marginTop: 4, display: "block" }}>Открыть таблицу ↗</a>
                  </div>
                  <button className="btn-ghost" style={{ fontSize: 12, padding: "6px 12px" }} onClick={disconnect}>Отключить</button>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 13, color: "#6b7280" }}>{clientId ? "Требуется авторизация" : "Не настроено"}</div>
                  <button className="btn-primary" style={{ fontSize: 12, padding: "7px 14px" }} onClick={() => clientId ? requestToken() : (setClientIdDraft(""), setSheetIdDraft(""), setModal("setup"))}>
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
              <div style={{ background: "#111320", border: "1px dashed #2a2d38", borderRadius: 12, padding: "48px 24px", textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📅</div>
                <div style={{ fontSize: 14, color: "#6b7280" }}>Записей нет.</div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[...months].reverse().map((m, mi) => {
                  const total = monthTotal(m, "RUB");
                  const prevM = months[months.length - 1 - mi - 1];
                  const prevTot = prevM ? monthTotal(prevM, "RUB") : null;
                  const d = prevTot !== null ? total - prevTot : null;
                  const isOpen = selectedMonth === m;
                  return (
                    <div key={m} style={{ background: "#111320", border: `1px solid ${isOpen ? "#2a4a3a" : "#1e2030"}`, borderRadius: 12, overflow: "hidden", transition: "border-color 0.15s" }}>
                      <div className="month-row" onClick={() => setSelectedMonth(isOpen ? null : m)} style={{ display: "flex", alignItems: "center", padding: "16px 22px", transition: "background 0.1s" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 15, fontWeight: 700 }}>{monthLabel(m)}</div>
                          <div style={{ fontSize: 11, color: "#4b5563", marginTop: 2 }}>{data.snapshots.filter(s => s.month === m).length} счетов</div>
                        </div>
                        <div style={{ textAlign: "right", marginRight: 16 }}>
                          <div style={{ fontSize: 16, fontWeight: 600 }}>{fmtShort(total)} ₽</div>
                          {d !== null && <div style={{ fontSize: 11, color: d >= 0 ? "#6ee7b7" : "#f87171" }}>{d >= 0 ? "+" : ""}{fmtShort(d)}</div>}
                        </div>
                        <span style={{ color: "#4b5563", fontSize: 12 }}>{isOpen ? "▲" : "▼"}</span>
                      </div>
                      {isOpen && (
                        <div style={{ borderTop: "1px solid #1e2030" }}>
                          {data.accounts.map(acc => {
                            const snap = getSnapshot(acc.id, m);
                            if (!snap) return null;
                            return (
                              <div key={acc.id} style={{ display: "flex", alignItems: "center", padding: "10px 22px", borderBottom: "1px solid #141620" }}>
                                <span style={{ marginRight: 10, fontSize: 14 }}>{typeIcon(acc.type)}</span>
                                <div style={{ flex: 1, fontSize: 13, color: "#9ca3af" }}>{acc.name}</div>
                                <div style={{ textAlign: "right" }}>
                                  <div style={{ fontSize: 13 }}>{fmtBalance(snap.balance, acc.currency)} {acc.currency}</div>
                                  {HAS_PNL.has(acc.type) && snap.invested != null && (() => { const pl = snap.balance - snap.invested; return (
                                    <div style={{ fontSize: 10, color: pl >= 0 ? "#6ee7b7" : "#f87171", marginTop: 2 }}>внесено {fmtShort(snap.invested)} · P&L {pl >= 0 ? "+" : ""}{fmtShort(pl)}</div>
                                  ); })()}
                                </div>
                              </div>
                            );
                          })}
                          <div style={{ padding: "12px 22px", display: "flex", gap: 10 }}>
                            <button className="btn-ghost" style={{ fontSize: 12, padding: "7px 14px" }} onClick={() => openRecord(m)}>Редактировать</button>
                            <button onClick={() => deleteMonth(m)} style={{ background: "none", border: "1px solid #3a1e1e", color: "#f87171", padding: "7px 14px", borderRadius: 8, fontFamily: "inherit", fontSize: 12, cursor: "pointer" }}>Удалить</button>
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
          <div className="fade-in" style={{ background: "#13151f", border: "1px solid #2a2d38", borderRadius: 16, padding: 28, width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto" }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Подключить Google Sheets</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 20, lineHeight: 1.7 }}>
              Данные хранятся в твоей таблице — доступны с любого устройства. Нужен Google Cloud Client ID (бесплатно).
            </div>
            <div style={{ background: "#0d0f14", borderRadius: 10, padding: "16px 18px", marginBottom: 20, fontSize: 12, color: "#9ca3af", lineHeight: 1.8 }}>
              <div style={{ color: "#e8eaf0", fontWeight: 500, marginBottom: 10, fontSize: 13 }}>Как получить Client ID</div>
              <ol style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
                <li>Открой <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer" style={{ color: "#6ee7b7" }}>Google Cloud Console</a> → создай проект</li>
                <li>APIs &amp; Services → Library → найди и включи <b style={{ color: "#e8eaf0" }}>Google Sheets API</b></li>
                <li>APIs &amp; Services → OAuth consent screen → External → заполни название</li>
                <li>Credentials → Create Credentials → <b style={{ color: "#e8eaf0" }}>OAuth 2.0 Client ID</b></li>
                <li>Тип приложения: <b style={{ color: "#e8eaf0" }}>Web application</b></li>
                <li>Authorized JavaScript origins — добавь:</li>
              </ol>
              <div style={{ background: "#141620", borderRadius: 6, padding: "8px 12px", marginTop: 8, fontSize: 11, color: "#6ee7b7", wordBreak: "break-all" }}>
                {window.location.origin}
              </div>
              <ol start={7} style={{ paddingLeft: 18, marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <li>Скопируй <b style={{ color: "#e8eaf0" }}>Client ID</b> и вставь ниже</li>
              </ol>
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, letterSpacing: "0.06em" }}>CLIENT ID</div>
              <input className="inp" placeholder="xxxxxxx.apps.googleusercontent.com" value={clientIdDraft} onChange={e => setClientIdDraft(e.target.value)} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, letterSpacing: "0.06em" }}>GOOGLE SHEET <span style={{ opacity: 0.6 }}>(необязательно)</span></div>
              <input className="inp" placeholder="Ссылка на таблицу или ID — оставь пустым для новой" value={sheetIdDraft} onChange={e => setSheetIdDraft(e.target.value)} />
              <div style={{ fontSize: 11, color: "#4b5563", marginTop: 6 }}>Если у тебя уже есть заполненная таблица — вставь ссылку или ID, чтобы не создавать новую</div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setModal(null)}>Отмена</button>
              <button className="btn-primary" style={{ flex: 2 }} onClick={saveClientId} disabled={!clientIdDraft.trim()}>Сохранить и войти →</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: Add Account ── */}
      {modal === "add-account" && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="fade-in" style={{ background: "#13151f", border: "1px solid #2a2d38", borderRadius: 16, padding: 28, width: "100%", maxWidth: 400 }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 18, fontWeight: 700, marginBottom: 22 }}>Новый счёт</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div><div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, letterSpacing: "0.06em" }}>НАЗВАНИЕ</div>
                <input className="inp" placeholder="Сбербанк накопительный" value={newAccount.name} onChange={e => setNewAccount({ ...newAccount, name: e.target.value })} onKeyDown={e => e.key === "Enter" && addAccount()} /></div>
              <div><div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, letterSpacing: "0.06em" }}>ТИП</div>
                <select className="sel" value={newAccount.type} onChange={e => setNewAccount({ ...newAccount, type: e.target.value })}>
                  {ACCOUNT_TYPES.map(t => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}</select></div>
              <div><div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, letterSpacing: "0.06em" }}>ВАЛЮТА</div>
                <select className="sel" value={newAccount.currency} onChange={e => setNewAccount({ ...newAccount, currency: e.target.value })}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setModal(null)}>Отмена</button>
              <button className="btn-primary" style={{ flex: 2 }} onClick={addAccount}>Добавить</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: Edit Account ── */}
      {modal === "edit-account" && editAccount && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="fade-in" style={{ background: "#13151f", border: "1px solid #2a2d38", borderRadius: 16, padding: 28, width: "100%", maxWidth: 400 }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 18, fontWeight: 700, marginBottom: 22 }}>Редактировать</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div><div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, letterSpacing: "0.06em" }}>НАЗВАНИЕ</div>
                <input className="inp" value={editAccount.name} onChange={e => setEditAccount({ ...editAccount, name: e.target.value })} /></div>
              <div><div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, letterSpacing: "0.06em" }}>ТИП</div>
                <select className="sel" value={editAccount.type} onChange={e => setEditAccount({ ...editAccount, type: e.target.value })}>
                  {ACCOUNT_TYPES.map(t => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}</select></div>
              <div><div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, letterSpacing: "0.06em" }}>ВАЛЮТА</div>
                <select className="sel" value={editAccount.currency} onChange={e => setEditAccount({ ...editAccount, currency: e.target.value })}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setModal(null)}>Отмена</button>
              <button className="btn-primary" style={{ flex: 2 }} onClick={updateAccount}>Сохранить</button>
            </div>
            <div style={{ borderTop: "1px solid #1e2030", marginTop: 20, paddingTop: 16, display: "flex", justifyContent: "center" }}>
              {editAccount.closed ? (
                <button className="btn-ghost" style={{ fontSize: 12, color: "#6ee7b7", borderColor: "#2a4a3a" }} onClick={() => { reopenAccount(editAccount.id); setModal(null); setEditAccount(null); }}>Открыть счёт</button>
              ) : (
                <button className="btn-ghost" style={{ fontSize: 12, color: "#f87171", borderColor: "#3a1e1e" }} onClick={() => { closeAccount(editAccount.id); setModal(null); setEditAccount(null); }}>Закрыть счёт</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: Record ── */}
      {modal === "record" && (
        <div className="modal-overlay">
          <div className="fade-in" style={{ background: "#13151f", border: "1px solid #2a2d38", borderRadius: 16, padding: 28, width: "100%", maxWidth: 420, maxHeight: "90vh", overflowY: "auto" }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 18, fontWeight: 700, marginBottom: 14 }}>Записать состояние</div>
            <input type="month" className="inp" value={recordMonth} onChange={e => {
              setRecordMonth(e.target.value);
              const vals = {}, inv = {};
              activeAccounts.forEach(a => {
                const snap = getSnapshot(a.id, e.target.value);
                vals[a.id] = snap ? String(snap.balance) : "";
                if (HAS_PNL.has(a.type)) inv[a.id] = snap?.invested != null ? String(snap.invested) : "";
              });
              setRecordValues(vals);
              setRecordInvested(inv);
            }} style={{ marginBottom: 18 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {activeAccounts.map(acc => (
                <div key={acc.id}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, letterSpacing: "0.06em", display: "flex", gap: 6 }}>
                    <span>{typeIcon(acc.type)}</span><span>{acc.name.toUpperCase()}</span><span style={{ color: "#4b5563" }}>· {acc.currency}</span>
                  </div>
                  {HAS_PNL.has(acc.type) ? (
                    <div style={{ display: "flex", gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 4 }}>Стоимость</div>
                        <input className="inp" type="number" step="any" placeholder="0" value={recordValues[acc.id] ?? ""} onChange={e => setRecordValues({ ...recordValues, [acc.id]: e.target.value })} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 4 }}>Внесено</div>
                        <input className="inp" type="number" step="any" placeholder="0" value={recordInvested[acc.id] ?? ""} onChange={e => setRecordInvested({ ...recordInvested, [acc.id]: e.target.value })} />
                      </div>
                    </div>
                  ) : (
                    <input className="inp" type="number" step="any" placeholder="0" value={recordValues[acc.id] ?? ""} onChange={e => setRecordValues({ ...recordValues, [acc.id]: e.target.value })} />
                  )}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 18, padding: "12px 16px", background: "#0d0f14", borderRadius: 8, fontSize: 13, color: "#9ca3af", display: "flex", justifyContent: "space-between" }}>
              <span>Итого</span>
              <span style={{ color: "#6ee7b7" }}>{fmtShort(activeAccounts.reduce((s, acc) => s + convert(parseFloat(recordValues[acc.id]) || 0, acc.currency, "RUB") * balSign(acc), 0))} ₽</span>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setModal(null)}>Отмена</button>
              <button className="btn-primary" style={{ flex: 2 }} onClick={saveRecord}>
                {syncStatus === "syncing" ? <span><span className="spin">↻</span> Сохраняю…</span> : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
