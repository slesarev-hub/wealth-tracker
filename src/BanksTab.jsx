import { useMemo, useState } from "react";

import { ACCOUNT_TYPES, currentMonth } from "./lib/model.js";
import { CURRENCY_SYMBOLS, fmtShort, fmtAmount, monthLabel } from "./lib/format.js";
import { institutionsFor, shortName } from "./lib/institutions.js";
import { dayOf } from "./lib/spending.js";
import { Empty } from "./FeedTab.jsx";

const INK = "#e8eaf0", INK_2 = "#9ca3af", INK_3 = "#6b7280", LINE = "#141620";
const AMBER = "#fcd34d";
const BAR = "#4a90e2";
const CURRENCIES = ["RUB", "USD", "EUR"];
const typeOf = (id) => ACCOUNT_TYPES.find((t) => t.id === id) || { icon: "🗂️", label: id };
const sym = (c) => CURRENCY_SYMBOLS[c] || c;
const pct = (x) => (x * 100).toFixed(x >= 0.1 || x === 0 ? 0 : 1) + "%";

// One tile per bank or organisation: what it holds now, account by account.
// A balance carried forward from an earlier month is marked with that month,
// so a tile never looks fresher than its data.
export default function BanksTab({ data, idx, ratesOf, ops, onOpenFeed }) {
  const [currency, setCurrency] = useState("RUB");
  const month = currentMonth();
  const table = ratesOf(month).table;
  const tiles = useMemo(() => institutionsFor(data, month, currency, table, idx), [data, month, currency, table, idx]);
  const lastOp = useMemo(() => {
    const out = new Map();
    for (const op of ops.list) {
      const day = dayOf(op);
      if (!out.has(op.accountId) || out.get(op.accountId) < day) out.set(op.accountId, day);
    }
    return out;
  }, [ops.list]);
  const net = tiles.reduce((s, t) => s + t.total, 0);
  if (!tiles.length) return <Empty icon="🏦" text="Счетов пока нет — плашки банков появятся, когда они будут." />;
  const staleCount = tiles.reduce((s, t) => s + t.accounts.filter((a) => a.asOf && a.asOf < month).length, 0);

  return (
    <div className="fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700 }}>Банки и организации</div>
        <div style={{ display: "flex", gap: 2 }}>
          {CURRENCIES.map((c) => (
            <button key={c} className="tab-btn" onClick={() => setCurrency(c)}
              style={{ padding: "5px 10px", borderRadius: 6, fontSize: 12, color: currency === c ? "#6ee7b7" : INK_3, background: currency === c ? "#1a2820" : "none" }}>{c}</button>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 12, color: INK_3, marginBottom: 18, lineHeight: 1.6 }}>
        Всего {fmtShort(net)} {sym(currency)} в {tiles.length} местах на {monthLabel(month)}, по курсу этого месяца.
        {staleCount > 0 && <> <span style={{ color: AMBER }}>{staleCount} остатков старше этого месяца</span> — у них в строке стоит месяц записи.</>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
        {tiles.map((t) => (
          <div key={t.institution} className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <button className="tab-btn" title="Операции этого банка в ленте" onClick={() => onOpenFeed({ institution: t.institution })}
                style={{ flex: 1, minWidth: 0, textAlign: "left", padding: 0, color: INK, fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.institution}
              </button>
              <span style={{ fontSize: 15, color: t.total < 0 ? "#f87171" : INK, fontFamily: "DM Mono, monospace", whiteSpace: "nowrap" }}>
                {fmtShort(t.total)} {sym(currency)}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0 10px" }}>
              <div style={{ flex: 1, height: 4, background: "#1a1d26", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ width: `${Math.max(t.share * 100, t.share > 0 ? 1 : 0)}%`, height: "100%", background: BAR, borderRadius: 2 }} />
              </div>
              <span style={{ fontSize: 11, color: INK_3, width: 34, textAlign: "right" }}>{pct(t.share)}</span>
            </div>
            {t.accounts.map((a, i) => {
              const type = typeOf(a.acc.type);
              const name = shortName(a.acc, t.institution) || type.label;
              const stale = a.asOf && a.asOf < month;
              const last = lastOp.get(a.acc.id);
              return (
                <div key={a.acc.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 0", borderTop: i ? `1px solid ${LINE}` : "none" }}>
                  <span style={{ fontSize: 14, width: 20, textAlign: "center", flexShrink: 0 }} title={type.label}>{type.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: INK_2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.acc.name}>{name}</div>
                    <div style={{ fontSize: 10, color: INK_3, marginTop: 1 }}>
                      {a.asOf ? <span style={{ color: stale ? AMBER : INK_3 }}>остаток {stale ? `на ${monthLabel(a.asOf)}` : "этого месяца"}</span> : <span style={{ color: AMBER }}>остатка нет</span>}
                      {last && <> · <button className="tab-btn" style={{ padding: 0, fontSize: 10, color: INK_3, textDecoration: "underline dotted" }}
                        onClick={() => onOpenFeed({ account: a.acc.id, institution: t.institution })}>операция {last.slice(8, 10)}.{last.slice(5, 7)}</button></>}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0, fontFamily: "DM Mono, monospace" }}>
                    <div style={{ fontSize: 12, color: a.acc.type === "debt" ? "#f87171" : INK }}>
                      {a.balance === null ? "—" : `${a.acc.type === "debt" ? "−" : ""}${fmtAmount(a.balance, a.currency)} ${sym(a.currency)}`}
                    </div>
                    {a.balance !== null && a.currency !== currency && a.value !== null && (
                      <div style={{ fontSize: 10, color: INK_3 }}>≈ {fmtShort(a.value)} {sym(currency)}</div>
                    )}
                  </div>
                </div>
              );
            })}
            {t.unconverted > 0 && <div style={{ fontSize: 10, color: AMBER, marginTop: 6 }}>{t.unconverted} без курса — не вошли в сумму</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
