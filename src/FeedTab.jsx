import { useMemo, useState } from "react";

import { CURRENCY_SYMBOLS, fmtAmount, monthLabel } from "./lib/format.js";
import { convert } from "./lib/calc.js";
import { institutionOf, accountLabel } from "./lib/institutions.js";
import { OPERATION_KINDS } from "./lib/operations.js";
import { dayOf, flowOf, groupInfo, groupOf, opTitle, pairOwnTransfers } from "./lib/spending.js";

const INK = "#e8eaf0", INK_2 = "#9ca3af", INK_3 = "#6b7280", LINE = "#141620";
const GREEN = "#6ee7b7";
const PAGE = 150;
const KIND_ICON = {
  purchase: "🛒", payment: "🧾", cash: "🏧", fee: "🏦", transfer_out: "↗", transfer_in: "↙",
  income: "💰", refund: "↩", own_transfer: "🔁", other: "•",
};
const kindLabel = (id) => OPERATION_KINDS.find((k) => k.id === id)?.label || id;
const FLOWS = [["all", "Все"], ["spend", "Траты"], ["income", "Поступления"], ["own", "Свои переводы"]];
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

const dayLabel = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return day;
  const thisYear = new Date().getFullYear() === y;
  return `${WEEKDAYS[date.getDay()]}, ${d} ${MONTHS_GEN[m - 1]}${thisYear ? "" : ` ${y}`}`;
};

const money = (amount, currency, signed = true) => {
  const sign = signed ? (amount > 0 ? "+" : amount < 0 ? "−" : "") : "";
  return `${sign}${fmtAmount(Math.abs(amount), currency)} ${CURRENCY_SYMBOLS[currency] || currency}`;
};

// One merged timeline of every operation on every account. A transfer between
// two own accounts is one line ("Газпромбанк → Капиталбанк"), not two, as long
// as both of its sides are on screen.
export default function FeedTab({ ops, data, ratesOf, filter, setFilter, onReload, signedIn }) {
  const [shown, setShown] = useState(PAGE);
  const accounts = useMemo(() => new Map(data.accounts.map((a) => [a.id, a])), [data.accounts]);
  const institutions = useMemo(
    () => [...new Set(data.accounts.filter((a) => !a.deletedAt).map(institutionOf))].sort((a, b) => a.localeCompare(b, "ru")),
    [data.accounts]
  );
  const pairs = useMemo(
    () => pairOwnTransfers(ops.list, (op) => convert(op.amount, op.currency, "RUB", ratesOf(dayOf(op).slice(0, 7)).table)),
    [ops.list, ratesOf]
  );
  const months = useMemo(() => [...new Set(ops.list.map((op) => dayOf(op).slice(0, 7)))].sort().reverse(), [ops.list]);
  const silent = useMemo(() => {
    const withOps = new Set(ops.list.map((op) => op.accountId));
    return data.accounts.filter((a) => !a.deletedAt && !withOps.has(a.id) && (!filter.institution || institutionOf(a) === filter.institution))
      .map((a) => `${accountLabel(a)} · ${a.currency}`);
  }, [ops.list, data.accounts, filter.institution]);

  const rows = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    const scoped = filter.account || filter.institution;
    const pairedIn = new Set(scoped ? [] : [...pairs.values()].map((op) => op.id));
    const match = (op) => {
      if (filter.account && op.accountId !== filter.account) return false;
      if (filter.institution && institutionOf(accounts.get(op.accountId)) !== filter.institution) return false;
      if (filter.flow !== "all" && flowOf(op) !== filter.flow) return false;
      if (filter.month && dayOf(op).slice(0, 7) !== filter.month) return false;
      if (filter.day && dayOf(op) !== filter.day) return false;
      if (q) {
        const hay = `${op.merchant} ${op.description} ${op.category} ${op.note} ${accounts.get(op.accountId)?.name || ""} ${groupInfo(groupOf(op)).label}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };
    return ops.list
      .filter((op) => !pairedIn.has(op.id) && match(op))
      .sort((a, b) => (dayOf(b) < dayOf(a) ? -1 : dayOf(b) > dayOf(a) ? 1 : String(b.date).localeCompare(String(a.date))));
  }, [ops.list, filter, accounts, pairs]);

  const days = useMemo(() => {
    const out = [];
    for (const op of rows.slice(0, shown)) {
      const day = dayOf(op);
      if (!out.length || out[out.length - 1].day !== day) out.push({ day, ops: [], spend: 0 });
      const d = out[out.length - 1];
      d.ops.push(op);
      if (flowOf(op) === "spend") {
        const v = convert(op.amount, op.currency, "RUB", ratesOf(day.slice(0, 7)).table);
        if (Number.isFinite(v)) d.spend += v;
      }
    }
    return out;
  }, [rows, shown, ratesOf]);

  const set = (patch) => { setShown(PAGE); setFilter({ ...filter, ...patch }); };
  const anyFilter = filter.q || filter.account || filter.institution || filter.month || filter.day || filter.flow !== "all";

  if (!signedIn) return <Empty icon="🔒" text="Операции лежат в Google Sheets — войдите в Google, чтобы их увидеть." />;
  if (ops.status === "loading" && !ops.list.length) return <Empty icon="↻" text="Загружаю операции…" />;
  if (ops.status === "error") return <Empty icon="⚠" text={`Не удалось загрузить операции: ${ops.error}`} action={["Повторить", onReload]} />;
  if (!ops.list.length) return <Empty icon="📭" text="Операций пока нет: их записывают сборщики банков и импорт выписок." />;

  return (
    <div className="fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700 }}>Лента операций</div>
        <div style={{ fontSize: 11, color: INK_3 }}>
          {rows.length} из {ops.list.length}
          {ops.loadedAt && <> · загружено {new Date(ops.loadedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</>}
          {" "}<button className="icon-btn" style={{ color: INK_2, fontSize: 12 }} onClick={onReload} title="Перечитать из таблицы">{ops.status === "loading" ? <span className="spin">↻</span> : "↻"}</button>
        </div>
      </div>

      <div className="card" style={{ padding: "12px 14px", marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <input className="inp" placeholder="Поиск: магазин, получатель, категория, заметка" value={filter.q} onChange={(e) => set({ q: e.target.value })} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select className="sel" style={{ flex: "1 1 150px", width: "auto" }} value={filter.institution} onChange={(e) => set({ institution: e.target.value, account: "" })}>
            <option value="">Все банки</option>
            {institutions.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
          <select className="sel" style={{ flex: "1 1 180px", width: "auto" }} value={filter.account} onChange={(e) => set({ account: e.target.value })}>
            <option value="">Все счета</option>
            {data.accounts.filter((a) => !a.deletedAt && (!filter.institution || institutionOf(a) === filter.institution))
              .map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}
          </select>
          <select className="sel" style={{ flex: "1 1 120px", width: "auto" }} value={filter.month} onChange={(e) => set({ month: e.target.value, day: "" })}>
            <option value="">Все месяцы</option>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {FLOWS.map(([id, label]) => (
            <button key={id} className="tab-btn" onClick={() => set({ flow: id })}
              style={{ padding: "5px 10px", borderRadius: 6, fontSize: 12, color: filter.flow === id ? GREEN : INK_3, background: filter.flow === id ? "#1a2820" : "none", border: "1px solid #1e2030" }}>{label}</button>
          ))}
          {filter.day && (
            <button className="tab-btn" onClick={() => set({ day: "" })} title="Убрать фильтр по дню"
              style={{ padding: "5px 10px", borderRadius: 6, fontSize: 12, color: GREEN, background: "#1a2820", border: "1px solid #1e2030" }}>{dayLabel(filter.day)} ✕</button>
          )}
          {anyFilter && (
            <button className="tab-btn" style={{ marginLeft: "auto", fontSize: 12, color: INK_2 }}
              onClick={() => set({ q: "", account: "", institution: "", month: "", day: "", flow: "all" })}>Сбросить ✕</button>
          )}
        </div>
      </div>

      {days.map(({ day, ops: dayOps, spend }) => (
        <div key={day} style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "0 4px 6px", fontSize: 12, color: INK_3 }}>
            <span>{dayLabel(day)}</span>
            {spend < 0 && <span title="Траты за день в рублях по курсу месяца">{money(spend, "RUB")}</span>}
          </div>
          <div className="card" style={{ overflow: "hidden" }}>
            {dayOps.map((op, i) => (
              <Row key={op.id} op={op} pair={pairs.get(op.id)} accounts={accounts} last={i === dayOps.length - 1}
                collapsed={!(filter.account || filter.institution)} />
            ))}
          </div>
        </div>
      ))}
      {rows.length > shown && (
        <button className="btn-ghost" style={{ width: "100%", fontSize: 12 }} onClick={() => setShown(shown + PAGE)}>
          Показать ещё {Math.min(PAGE, rows.length - shown)} (осталось {rows.length - shown})
        </button>
      )}
      {!rows.length && <div className="card" style={{ padding: 24, textAlign: "center", color: INK_3, fontSize: 13 }}>Под фильтр ничего не попало.</div>}
      {silent.length > 0 && !filter.account && (
        <div style={{ fontSize: 11, color: INK_3, lineHeight: 1.7, padding: "14px 4px 0" }}>
          Без операций в учёте, только остатки ({silent.length}): {silent.join(", ")}. Их траты в ленту не попадают — у брокеров, вкладов и наличных
          меняется остаток, а операции не собираются.
        </div>
      )}
    </div>
  );
}

function Row({ op, pair, accounts, last, collapsed }) {
  const [open, setOpen] = useState(false);
  const acc = accounts.get(op.accountId);
  const flow = flowOf(op);
  const own = flow === "own";
  const counter = op.counterAccountId ? accounts.get(op.counterAccountId) : null;
  let title = opTitle(op);
  let sub = [accountLabel(acc)];
  if (own) {
    const showPair = collapsed && pair;
    if (op.amount < 0 && counter) title = `${accountLabel(acc)} → ${accountLabel(counter)}`;
    else if (op.amount > 0 && counter) title = `${accountLabel(counter)} → ${accountLabel(acc)}`;
    sub = [showPair || counter ? "перевод между своими" : "свой перевод, вторая сторона не найдена"];
    if (!counter) sub.push(accountLabel(acc), opTitle(op));
  } else if (flow === "spend") {
    sub.push(op.category || groupInfo(groupOf(op)).label);
  } else {
    sub.push(op.category || kindLabel(op.kind));
  }
  const color = own ? INK_3 : op.amount > 0 ? GREEN : INK;
  const arrived = collapsed && pair && (pair.currency !== op.currency || Math.abs(pair.amount + op.amount) >= 0.005) ? pair : null;
  return (
    <div style={{ borderBottom: last ? "none" : `1px solid ${LINE}` }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 16px", cursor: "pointer" }}>
        <span style={{ width: 22, textAlign: "center", fontSize: 15, color: INK_2, flexShrink: 0 }} title={kindLabel(op.kind)}>{KIND_ICON[op.kind] || "•"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: own ? INK_2 : INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={title}>{title}</div>
          <div style={{ fontSize: 11, color: INK_3, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {sub.filter(Boolean).join(" · ")}
            {op.note && <span style={{ color: "#a7a3d9" }}> · {op.note}</span>}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 13, color, fontFamily: "DM Mono, monospace" }}>{money(op.amount, op.currency)}</div>
          {arrived && <div style={{ fontSize: 11, color: INK_3, fontFamily: "DM Mono, monospace" }}>пришло {money(arrived.amount, arrived.currency, false)}</div>}
        </div>
      </div>
      {open && (
        <div style={{ padding: "0 16px 12px 50px", fontSize: 11, color: INK_3, lineHeight: 1.7, wordBreak: "break-word" }}>
          <div>{kindLabel(op.kind)} · {acc?.name || op.accountId} · {String(op.date).replace("T", " ").slice(0, 16)}
            {op.postedDate && op.postedDate.slice(0, 10) !== dayOf(op) && <> · отражено {op.postedDate.slice(0, 10)}</>}</div>
          {op.description && op.description !== title && <div>{op.description}</div>}
          {op.origAmount !== null && op.origCurrency && <div>в валюте операции: {money(op.origAmount, op.origCurrency)}</div>}
          <div>источник: {op.source}{op.ref ? ` · ${op.ref}` : ""}</div>
        </div>
      )}
    </div>
  );
}

export function Empty({ icon, text, action }) {
  return (
    <div className="card fade-in" style={{ border: "1px dashed #2a2d38", padding: "48px 24px", textAlign: "center" }}>
      <div style={{ fontSize: 28, marginBottom: 12, color: INK_2 }}>{icon}</div>
      <div style={{ fontSize: 13, color: INK_3, lineHeight: 1.6 }}>{text}</div>
      {action && <button className="btn-ghost" style={{ marginTop: 14, fontSize: 12 }} onClick={action[1]}>{action[0]}</button>}
    </div>
  );
}
