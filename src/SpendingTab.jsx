import { useEffect, useMemo, useState } from "react";
import { BarChart, Bar, Cell, LabelList, ReferenceLine, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

import { CURRENCY_SYMBOLS, fmtShort, fmtAmount, monthLabel } from "./lib/format.js";
import { accountLabel } from "./lib/institutions.js";
import { spendingByMonth, mergeMonths, topPayees, opTitle, dayOf, dailySeries, dailyCap, groupInfo } from "./lib/spending.js";
import { Empty } from "./FeedTab.jsx";

const INK = "#e8eaf0", INK_2 = "#9ca3af", INK_3 = "#6b7280", LINE = "#141620";
const BAR = "#4a90e2", BAR_DIM = "#27415f", BAR_FILL = "#1d3a4f", CARD = "#111320";
const CURRENCIES = ["RUB", "USD", "EUR"];
const sym = (c) => CURRENCY_SYMBOLS[c] || c;
const pct = (x) => (x * 100).toFixed(x >= 0.1 ? 0 : 1) + "%";
const ddmm = (day) => (day ? `${day.slice(8, 10)}.${day.slice(5, 7)}` : "");
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const dayName = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]}, ${d} ${MONTHS_GEN[m - 1]}`;
};
const localToday = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const lastDayOf = (month) => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
};
const RECENT_DAYS = 90;

const ChartTip = ({ active, payload, currency }) => {
  if (!active || !payload?.length) return null;
  const m = payload[0].payload;
  return (
    <div style={{ background: "#1a1d26", border: "1px solid #2a2d38", borderRadius: 8, padding: "8px 12px", fontSize: 12, fontFamily: "DM Mono, monospace" }}>
      <div style={{ color: INK, marginBottom: 4 }}>{monthLabel(m.month)}</div>
      <div style={{ color: INK_2 }}>траты {fmtShort(m.spend)} {sym(currency)}</div>
      <div style={{ color: INK_3 }}>поступления {fmtShort(m.income)} {sym(currency)}</div>
      <div style={{ color: INK_3 }}>счетов с операциями: {m.accounts.size}</div>
      <div style={{ color: INK_3 }}>операции с {ddmm(m.firstDay)} по {ddmm(m.lastDay)}</div>
    </div>
  );
};

// Where the money went, month by month. Transfers between own accounts are
// never spending; they are counted apart, with what the moves cost.
export default function SpendingTab({ ops, data, ratesOf, onReload, signedIn, onOpenFeed }) {
  const [currency, setCurrency] = useState("RUB");
  const [selected, setSelected] = useState(null);
  const [openGroup, setOpenGroup] = useState(null);
  const accounts = useMemo(() => new Map(data.accounts.map((a) => [a.id, a])), [data.accounts]);
  const months = useMemo(() => spendingByMonth(ops.list, currency, ratesOf), [ops.list, currency, ratesOf]);
  useEffect(() => {
    if (months.length && (!selected || (selected !== "all" && !months.some((m) => m.month === selected)))) setSelected(months[months.length - 1].month);
  }, [months, selected]);
  const view = useMemo(() => {
    if (selected === "all") return mergeMonths(months);
    return months.find((m) => m.month === selected) || null;
  }, [months, selected]);

  if (!signedIn) return <Empty icon="🔒" text="Операции лежат в Google Sheets — войдите в Google, чтобы увидеть траты." />;
  if (ops.status === "loading" && !ops.list.length) return <Empty icon="↻" text="Загружаю операции…" />;
  if (ops.status === "error") return <Empty icon="⚠" text={`Не удалось загрузить операции: ${ops.error}`} action={["Повторить", onReload]} />;
  if (!months.length || !view) return <Empty icon="📭" text="Операций пока нет — статистике не из чего считаться." />;

  const chart = months.slice(-12);
  // The record starts mid-month: that first bar covers only part of it, and says so.
  const first = months[0];
  const partialFirst = first && first.firstDay.slice(8, 10) !== "01" ? first : null;
  const max = view.groupList[0]?.total || 1;
  const covered = [...view.accounts].map((id) => accountLabel(accounts.get(id))).sort((a, b) => a.localeCompare(b, "ru"));

  return (
    <div className="fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700 }}>Траты</div>
        <div style={{ display: "flex", gap: 2 }}>
          {CURRENCIES.map((c) => (
            <button key={c} className="tab-btn" onClick={() => setCurrency(c)}
              style={{ padding: "5px 10px", borderRadius: 6, fontSize: 12, color: currency === c ? "#6ee7b7" : INK_3, background: currency === c ? "#1a2820" : "none" }}>{c}</button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: "16px 12px 8px 4px", marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0 8px 8px 16px", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span className="lbl">Траты по месяцам, {sym(currency)}</span>
          <button className="tab-btn" onClick={() => setSelected(selected === "all" ? months[months.length - 1].month : "all")}
            style={{ fontSize: 11, color: selected === "all" ? "#6ee7b7" : INK_3, padding: "2px 6px" }}>
            {selected === "all" ? "✓ всё время" : "всё время"}
          </button>
        </div>
        <ResponsiveContainer width="100%" height={170}>
          <BarChart data={chart} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%"
            onClick={(e) => e?.activePayload?.[0] && setSelected(e.activePayload[0].payload.month)}>
            <XAxis dataKey="month" tickFormatter={(m) => monthLabel(m).slice(0, 3)} tick={{ fill: INK_3, fontSize: 11 }} axisLine={{ stroke: "#1e2030" }} tickLine={false} />
            <YAxis tickFormatter={fmtShort} tick={{ fill: INK_3, fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip content={<ChartTip currency={currency} />} cursor={{ fill: "#ffffff08" }} />
            <Bar dataKey="spend" radius={[4, 4, 0, 0]} style={{ cursor: "pointer" }}>
              {chart.map((m) => <Cell key={m.month} fill={selected === "all" || m.month === selected ? BAR : BAR_DIM} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        {partialFirst && (
          <div style={{ fontSize: 11, color: INK_3, padding: "2px 8px 4px 16px" }}>
            {monthLabel(partialFirst.month)} — неполный: операции в учёте с {ddmm(partialFirst.firstDay)}.
          </div>
        )}
      </div>

      <DailyChart view={view} all={selected === "all"} currency={currency} accounts={accounts} onOpenFeed={onOpenFeed} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
        <Stat label={selected === "all" ? "Траты за всё время" : `Траты, ${monthLabel(view.month)}`} value={`${fmtShort(view.spend)} ${sym(currency)}`} />
        <Stat label="Поступления" value={`${fmtShort(view.income)} ${sym(currency)}`} hint="зарплата, проценты, кэшбэк, переводы от людей" />
        <Stat label="Между своими счетами" value={`${fmtShort(view.moved)} ${sym(currency)}`}
          hint={`не трата. ${view.movesPaired ? `Стоимость переводов (курс, комиссии) по ${view.movesPaired} сведённым: ${fmtShort(view.moveCost)} ${sym(currency)}` : "Сведённых пар нет"}${view.movesUnpaired ? `; без второй стороны: ${view.movesUnpaired}` : ""}`} />
      </div>

      <div className="card" style={{ padding: "16px 18px", marginBottom: 14 }}>
        <div className="lbl" style={{ marginBottom: 10 }}>На что</div>
        {view.groupList.map((g) => {
          const isOpen = openGroup === g.id;
          return (
            <div key={g.id} style={{ borderTop: `1px solid ${LINE}` }}>
              <div onClick={() => setOpenGroup(isOpen ? null : g.id)}
                style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, padding: "8px 8px", cursor: "pointer", borderRadius: 6 }}>
                <div style={{ position: "absolute", inset: "3px auto 3px 0", width: `${Math.max((Math.max(g.total, 0) / max) * 100, 0.6)}%`, background: BAR_FILL, borderRadius: 4, pointerEvents: "none" }} />
                <span style={{ position: "relative", width: 20, textAlign: "center" }}>{g.icon}</span>
                <span style={{ position: "relative", flex: 1, minWidth: 0, fontSize: 13, color: INK_2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.label}</span>
                <span style={{ position: "relative", fontSize: 11, color: INK_3 }}>{g.ops.length} шт · {view.spend > 0 ? pct(Math.max(g.total, 0) / view.spend) : "—"}</span>
                <span style={{ position: "relative", fontSize: 13, color: INK, fontFamily: "DM Mono, monospace", minWidth: 80, textAlign: "right" }}>{fmtShort(g.total)} {sym(currency)}</span>
              </div>
              {isOpen && <GroupDetail group={g} currency={currency} accounts={accounts} onOpenFeed={onOpenFeed} month={selected === "all" ? "" : view.month} />}
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 11, color: INK_3, lineHeight: 1.7, padding: "0 4px" }}>
        <div>Учтены операции {covered.length} счетов: {covered.join(", ")}. Счёт без операций за период в сумму не попадает — смотрите, все ли банки собраны.</div>
        <div>Не считается тратой: переводы между своими счетами и снятие наличных в свой кошелёк. Наличные, снятые без пометки, — отдельной строкой «{"Снято наличными, не размечено"}»: когда известно, на что они ушли, их можно разметить.</div>
        <div>Суммы в {currency} — по курсу месяца операции.{view.unconverted ? ` Без курса и не учтено: ${view.unconverted} операций.` : ""}</div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }) {
  return (
    <div className="card" style={{ padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: INK_3, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 18, color: INK, fontFamily: "DM Mono, monospace" }}>{value}</div>
      {hint && <div style={{ fontSize: 10, color: INK_3, marginTop: 6, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

function GroupDetail({ group, currency, accounts, onOpenFeed, month }) {
  const payees = topPayees(group.ops);
  const shown = group.ops.slice(0, 25);
  return (
    <div style={{ padding: "4px 8px 12px 36px", fontSize: 12 }}>
      <div style={{ color: INK_3, fontSize: 11, margin: "4px 0" }}>Кому больше всего</div>
      {payees.map((p) => (
        <div key={p.key} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
          <span style={{ flex: 1, minWidth: 0, color: INK_2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.key.length > 70 ? opTitle({ description: p.key }) : p.key}</span>
          <span style={{ color: INK_3 }}>{p.count}×</span>
          <span style={{ color: INK, fontFamily: "DM Mono, monospace", minWidth: 70, textAlign: "right" }}>{fmtShort(p.total)} {sym(currency)}</span>
        </div>
      ))}
      <div style={{ color: INK_3, fontSize: 11, margin: "10px 0 4px" }}>Операции, крупные сначала{group.ops.length > shown.length ? ` (${shown.length} из ${group.ops.length})` : ""}</div>
      {shown.map(({ op }) => (
        <div key={op.id} style={{ display: "flex", gap: 8, padding: "2px 0", alignItems: "baseline" }}>
          <span style={{ color: INK_3, fontFamily: "DM Mono, monospace", fontSize: 11 }}>{dayOf(op).slice(8, 10)}.{dayOf(op).slice(5, 7)}</span>
          <span style={{ flex: 1, minWidth: 0, color: INK_2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={op.note || op.description}>
            {opTitle(op)}<span style={{ color: INK_3 }}> · {accountLabel(accounts.get(op.accountId))}</span>
          </span>
          <span style={{ color: INK, fontFamily: "DM Mono, monospace", whiteSpace: "nowrap" }}>{op.amount > 0 ? "+" : "−"}{fmtAmount(Math.abs(op.amount), op.currency)} {sym(op.currency)}</span>
        </div>
      ))}
      <button className="tab-btn" style={{ marginTop: 8, fontSize: 11, color: INK_2, padding: 0, textDecoration: "underline dotted" }}
        onClick={() => onOpenFeed({ q: group.label, flow: "spend", month })}>показать в ленте</button>
    </div>
  );
}

const DayTip = ({ active, payload, currency, accounts }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const top = d.ops.slice(0, 4);
  return (
    <div style={{ background: "#1a1d26", border: "1px solid #2a2d38", borderRadius: 8, padding: "8px 12px", fontSize: 12, maxWidth: 300 }}>
      <div style={{ color: INK, marginBottom: 4 }}>{dayName(d.day)}</div>
      <div style={{ color: INK_2, fontFamily: "DM Mono, monospace", marginBottom: top.length ? 6 : 0 }}>
        {d.ops.length ? `траты ${fmtShort(d.spend)} ${sym(currency)}` : "трат нет"}
      </div>
      {top.map(({ op, value, group }) => (
        <div key={op.id} style={{ display: "flex", gap: 8, color: INK_3, lineHeight: 1.6 }}>
          <span style={{ width: 16, textAlign: "center" }}>{groupInfo(group).icon}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {opTitle(op)} · {accountLabel(accounts.get(op.accountId))}
          </span>
          <span style={{ color: INK_2, fontFamily: "DM Mono, monospace" }}>{fmtShort(value)}</span>
        </div>
      ))}
      {d.ops.length > top.length && <div style={{ color: INK_3, marginTop: 2 }}>ещё {d.ops.length - top.length} · нажмите — вся лента дня</div>}
    </div>
  );
};

// Spending day by day: the selected month, or the last 90 days when the whole
// record is selected. A click on a bar opens that day in the feed.
function DailyChart({ view, all, currency, accounts, onOpenFeed }) {
  const series = useMemo(() => {
    const today = localToday();
    let from, to;
    if (all) {
      to = view.lastDay > today ? view.lastDay : today;
      const start = new Date(`${to}T12:00:00Z`);
      start.setUTCDate(start.getUTCDate() - (RECENT_DAYS - 1));
      from = start.toISOString().slice(0, 10);
    } else {
      from = `${view.month}-01`;
      to = lastDayOf(view.month);
      if (to > today && today >= from) to = today;
    }
    const days = dailySeries(view.days, from, to);
    const cap = dailyCap(days.map((d) => d.spend));
    return {
      days: days.map((d) => ({ ...d, bar: Math.max(cap ? Math.min(d.spend, cap) : d.spend, 0), clipped: cap !== null && d.spend > cap })),
      cap,
      from,
      to,
    };
  }, [view, all]);
  const total = series.days.reduce((sum, d) => sum + d.spend, 0);
  const average = series.days.length ? total / series.days.length : 0;
  const quiet = series.days.filter((d) => !d.ops.length).length;
  const peak = series.days.reduce((best, d) => (d.spend > (best?.spend ?? 0) ? d : best), null);
  const clipped = series.days.filter((d) => d.clipped);
  const tick = (day) => (all || series.days.length > 40 ? ddmm(day) : String(Number(day.slice(8, 10))));

  return (
    <div className="card" style={{ padding: "16px 12px 8px 4px", marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "0 8px 8px 16px", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span className="lbl">Траты по дням, {sym(currency)}</span>
        <span style={{ fontSize: 11, color: INK_3 }}>
          {all ? `последние ${RECENT_DAYS} дней` : monthLabel(view.month)} · в среднем {fmtShort(average)} {sym(currency)} в день
          {quiet ? ` · без трат: ${quiet}` : ""}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={190}>
        <BarChart data={series.days} margin={{ top: 18, right: 8, bottom: 0, left: 0 }} barCategoryGap={series.days.length > 40 ? 1 : "18%"}
          onClick={(e) => {
            const d = e?.activePayload?.[0]?.payload;
            if (d?.ops.length) onOpenFeed({ day: d.day, flow: "spend" });
          }}>
          <XAxis dataKey="day" tickFormatter={tick} tick={{ fill: INK_3, fontSize: 11 }} axisLine={{ stroke: "#1e2030" }} tickLine={false}
            interval="preserveStartEnd" minTickGap={18} />
          <YAxis tickFormatter={fmtShort} tick={{ fill: INK_3, fontSize: 11 }} axisLine={false} tickLine={false} width={44}
            domain={series.cap ? [0, series.cap] : [0, "auto"]} allowDataOverflow={false} />
          <Tooltip content={<DayTip currency={currency} accounts={accounts} />} cursor={{ fill: "#ffffff08" }} />
          {average > 0 && <ReferenceLine y={average} stroke={INK_3} strokeDasharray="3 4" ifOverflow="hidden" />}
          <Bar dataKey="bar" fill={BAR} radius={[3, 3, 0, 0]} style={{ cursor: "pointer" }} isAnimationActive={false}>
            <LabelList dataKey="spend" position="top"
              content={({ x, y, width, index }) => {
                const d = series.days[index];
                if (!d?.clipped) return null;
                // A bar taller than the axis gets a break across its top and an arrow; the sum is
                // written above it only when the bar is wide enough to hold it without colliding.
                const roomy = width >= 30;
                return (
                  <g pointerEvents="none">
                    <polygon points={`${x - 1},${y + 10} ${x + width + 1},${y + 7} ${x + width + 1},${y + 10} ${x - 1},${y + 13}`} fill={CARD} />
                    <text x={x + width / 2} y={y - 5} textAnchor="middle" fill={INK_2} fontSize={10} fontFamily="DM Mono, monospace">
                      {roomy ? `↑${fmtShort(d.spend)}` : "↑"}
                    </text>
                  </g>
                );
              }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 11, color: INK_3, padding: "2px 8px 4px 16px", lineHeight: 1.6 }}>
        Пунктир — среднее за день.{peak && peak.spend > 0 ? ` Больше всего — ${dayName(peak.day)}: ${fmtShort(peak.spend)} ${sym(currency)}.` : ""}
        {clipped.length ? ` Шкала обрезана на ${fmtShort(series.cap)}, чтобы крупные траты не сплющили остальные дни; выше неё (столбец с разрывом и ↑): ${clipped.map((d) => `${ddmm(d.day)} — ${fmtShort(d.spend)} ${sym(currency)}`).join(", ")}.` : ""}
        {" "}Нажмите на столбец — откроется лента этого дня.
      </div>
    </div>
  );
}
