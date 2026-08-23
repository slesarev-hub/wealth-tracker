import { useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, ReferenceLine } from "recharts";

import { ACCOUNT_TYPES, BASE_CURRENCY } from "./lib/model.js";
import { CURRENCY_SYMBOLS, fmtShort, fmtSigned, monthLabel } from "./lib/format.js";
import {
  DEFAULT_BENCH_PCT, instrumentsOf, instrumentSeries, portfolioSeries, summarize,
} from "./lib/returns.js";

const LS_BENCH = "wealth-bench-pct";
const PORTFOLIO = "__portfolio__";

const pct = (x, digits = 1) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : (x >= 0 ? "+" : "") + (x * 100).toFixed(digits) + "%";
const typeIcon = (t) => ACCOUNT_TYPES.find((x) => x.id === t)?.icon || "🗂️";

const AXIS = { fill: "#4b5563", fontSize: 11, fontFamily: "DM Mono" };
const TOOLTIP = { background: "#1a1d26", border: "1px solid #2a2d38", borderRadius: 8, fontFamily: "DM Mono", fontSize: 12 };
const GREEN = "#6ee7b7", BLUE = "#60a5fa", GREY = "#6b7280", RED = "#f87171";

export default function ReturnsTab({ data, months, idx, ratesOf }) {
  const [sel, setSel] = useState(PORTFOLIO);
  const [benchPct, setBenchPct] = useState(() => {
    const v = parseFloat(localStorage.getItem(LS_BENCH));
    return Number.isFinite(v) ? v : DEFAULT_BENCH_PCT;
  });
  const setBench = (v) => {
    setBenchPct(v);
    try { localStorage.setItem(LS_BENCH, String(v)); } catch {}
  };

  const { instruments, excluded } = useMemo(
    () => instrumentsOf(data, months, idx, ratesOf),
    [data, months, idx, ratesOf]
  );
  // A deleted or closed selection falls back to the portfolio view.
  const current = sel === PORTFOLIO ? null : instruments.find((i) => i.acc.id === sel) || null;
  const currency = current ? current.currency : BASE_CURRENCY;
  const sym = CURRENCY_SYMBOLS[currency] || currency;

  const points = useMemo(
    () => (current
      ? instrumentSeries(data, current.acc, current.currency, months, idx, ratesOf, benchPct)
      : portfolioSeries(data, instruments, months, idx, ratesOf, benchPct)),
    [data, current, instruments, months, idx, ratesOf, benchPct]
  );
  const sum = summarize(points);
  const rows = points.map((p) => ({
    label: monthLabel(p.month),
    value: p.value,
    basis: Number.isFinite(p.basis) ? p.basis : null,
    deposit: p.deposit,
    twr: (p.index - 1) * 100,
    bench: (p.benchIndex - 1) * 100,
    r: p.r === null ? null : p.r * 100,
    flow: p.flow,
    stamped: p.stamped,
  }));

  const chip = (id, label, active) => (
    <button key={id} className="tab-btn" onClick={() => setSel(id)}
      style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, border: `1px solid ${active ? "#2a4a3a" : "#1e2030"}`,
        color: active ? GREEN : "#9ca3af", background: active ? "#1a2820" : "#111320", whiteSpace: "nowrap" }}>
      {label}
    </button>
  );

  const moneyTip = (v, name) => [fmtShort(v) + " " + sym, name];
  const pctTip = (v, name) => [(v >= 0 ? "+" : "") + Number(v).toFixed(1) + "%", name];

  return (
    <div className="fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700 }}>Доходность</div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#9ca3af" }}>
          Вклад для сравнения
          <input type="number" step="0.5" min="-100" max="1000" value={benchPct}
            onChange={(e) => setBench(parseFloat(e.target.value))}
            style={{ width: 64, padding: "5px 8px", borderRadius: 6, border: "1px solid #2a2d38", background: "#0d0f14", color: "#e8eaf0", fontFamily: "DM Mono", fontSize: 12 }} />
          % годовых
        </label>
      </div>

      {instruments.length === 0 ? (
        <div className="card" style={{ border: "1px dashed #2a2d38", padding: "48px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
          <div style={{ fontSize: 14, color: "#6b7280", lineHeight: 1.6 }}>
            Нет инвестиционных или крипто-счетов с записями.
            {excluded.length > 0 && <><br />У {excluded.map((e) => `${e.acc.name} (${e.acc.currency})`).join(", ")} вложения записаны в монетах — укажите сумму в валюте, чтобы считать доходность.</>}
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
            {chip(PORTFOLIO, "Портфель · " + (CURRENCY_SYMBOLS[BASE_CURRENCY] || BASE_CURRENCY), !current)}
            {instruments.map(({ acc, currency: c }) =>
              chip(acc.id, `${typeIcon(acc.type)} ${acc.name} · ${CURRENCY_SYMBOLS[c] || c}`, current?.acc.id === acc.id)
            )}
          </div>

          {sum && (
            <div className="card" style={{ padding: "18px 22px", marginBottom: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 16 }}>
                <div>
                  <div className="lbl">Доходность</div>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 26, fontWeight: 800, color: sum.total >= 0 ? GREEN : RED, letterSpacing: "-0.02em" }}>{pct(sum.total)}</div>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>{sum.annualized === null ? "за 1 месяц" : `${pct(sum.annualized)} годовых · ${sum.months} мес.`}</div>
                </div>
                <div>
                  <div className="lbl">Вклад {benchPct}%</div>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 26, fontWeight: 800, color: BLUE, letterSpacing: "-0.02em" }}>{pct(sum.benchTotal)}</div>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>с теми же пополнениями</div>
                </div>
                <div>
                  <div className="lbl">Против вклада</div>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 26, fontWeight: 800, color: sum.vsDeposit >= 0 ? GREEN : RED, letterSpacing: "-0.02em" }}>{fmtSigned(sum.vsDeposit)} {sym}</div>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>{fmtShort(sum.value)} сейчас vs {fmtShort(sum.deposit)} на вкладе</div>
                </div>
                <div>
                  <div className="lbl">Прибыль</div>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 26, fontWeight: 800, color: sum.pnl === null ? GREY : sum.pnl >= 0 ? GREEN : RED, letterSpacing: "-0.02em" }}>
                    {sum.pnl === null ? "—" : `${fmtSigned(sum.pnl)} ${sym}`}
                  </div>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>{sum.basis === null ? "вложения не записаны" : `вложено ${fmtShort(sum.basis)} ${sym}`}</div>
                </div>
              </div>
            </div>
          )}

          {rows.length > 1 ? (
            <>
              <div className="card" style={{ padding: "20px 22px", marginBottom: 14 }}>
                <div className="lbl" style={{ marginBottom: 16 }}>Стоимость · вложено · вклад {benchPct}%</div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={rows} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={{ ...AXIS, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={fmtShort} domain={["auto", "auto"]} />
                    <Tooltip contentStyle={TOOLTIP} labelStyle={{ color: "#9ca3af" }} formatter={moneyTip} />
                    <Legend wrapperStyle={{ fontSize: 11, fontFamily: "DM Mono" }} />
                    <Line type="monotone" dataKey="value" name="Стоимость" stroke={GREEN} strokeWidth={2} dot={{ fill: GREEN, r: 3 }} activeDot={{ r: 5 }} />
                    <Line type="monotone" dataKey="deposit" name={`Вклад ${benchPct}%`} stroke={BLUE} strokeWidth={2} strokeDasharray="5 4" dot={false} />
                    <Line type="monotone" dataKey="basis" name="Вложено" stroke={GREY} strokeWidth={1.5} strokeDasharray="2 4" dot={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="card" style={{ padding: "20px 22px", marginBottom: 14 }}>
                <div className="lbl" style={{ marginBottom: 16 }}>Накопленная доходность, % (без учёта пополнений)</div>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={rows} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={{ ...AXIS, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => v.toFixed(0) + "%"} domain={["auto", "auto"]} />
                    <Tooltip contentStyle={TOOLTIP} labelStyle={{ color: "#9ca3af" }} formatter={pctTip} />
                    <Legend wrapperStyle={{ fontSize: 11, fontFamily: "DM Mono" }} />
                    <ReferenceLine y={0} stroke="#2a2d38" />
                    <Line type="monotone" dataKey="twr" name="Доходность" stroke={GREEN} strokeWidth={2} dot={{ fill: GREEN, r: 3 }} activeDot={{ r: 5 }} />
                    <Line type="monotone" dataKey="bench" name={`Вклад ${benchPct}%`} stroke={BLUE} strokeWidth={2} strokeDasharray="5 4" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="card" style={{ overflow: "hidden", marginBottom: 14 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", padding: "10px 22px", borderBottom: "1px solid #141620" }}>
                  {["Месяц", "За месяц", "Пополнено", "Стоимость"].map((h, i) => (
                    <div key={h} className="lbl" style={{ textAlign: i ? "right" : "left" }}>{h}</div>
                  ))}
                </div>
                {[...rows].reverse().map((r, i, arr) => (
                  <div key={r.label} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", padding: "9px 22px", fontSize: 13, fontFamily: "DM Mono", borderBottom: i < arr.length - 1 ? "1px solid #141620" : "none" }}>
                    <div style={{ color: "#9ca3af" }}>{r.label}{!r.stamped && <span title="курс не зафиксирован" style={{ color: "#fcd34d", marginLeft: 4 }}>~</span>}</div>
                    <div style={{ textAlign: "right", color: r.r === null ? GREY : r.r >= 0 ? GREEN : RED }}>{r.r === null ? "—" : (r.r >= 0 ? "+" : "") + r.r.toFixed(2) + "%"}</div>
                    <div style={{ textAlign: "right", color: r.flow ? "#e8eaf0" : GREY }}>{r.flow ? fmtShort(r.flow) : "—"}</div>
                    <div style={{ textAlign: "right" }}>{fmtShort(r.value)}</div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="card" style={{ padding: "36px 22px", marginBottom: 14, textAlign: "center", color: "#4b5563", fontSize: 13 }}>
              Запишите хотя бы 2 месяца по этому счёту, чтобы увидеть доходность
            </div>
          )}

          <div style={{ fontSize: 11, color: "#4b5563", lineHeight: 1.6 }}>
            Доходность за месяц: (стоимость − стоимость месяц назад − пополнения) / (стоимость месяц назад + пополнения/2), то есть пополнения не считаются доходом (Modified Dietz). Накопленная — произведение месячных. «Вклад» — те же пополнения под {benchPct}% годовых с ежемесячной капитализацией, стартуя с той же суммы. Вывод денег со счёта записывайте отрицательным пополнением, иначе он будет выглядеть как убыток.
            {sum?.unstamped > 0 && ` Для ${sum.unstamped} мес. курс не зафиксирован (~): они пересчитаны по сегодняшнему курсу.`}
            {excluded.length > 0 && ` ${excluded.map((e) => `${e.acc.name} (${e.acc.currency})`).join(", ")}: вложения записаны в монетах, доходность в валюте не посчитать — укажите сумму вложений в валюте.`}
          </div>
        </>
      )}
    </div>
  );
}
