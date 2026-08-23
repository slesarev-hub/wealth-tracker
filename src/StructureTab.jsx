import { useMemo, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";

import { BASE_CURRENCY } from "./lib/model.js";
import { CURRENCY_SYMBOLS, fmtShort, fmtBalance, monthLabel } from "./lib/format.js";
import { structureFor, OTHER_KEY } from "./lib/structure.js";

// The documented categorical slot order, stepped for a dark surface. Five slots
// only: with the app's surface (#111320) all five adjacent pairs and the ring's
// wrap-around pair pass every separation check, while a sixth hue (violet)
// collides with slot 1 — ΔE 1.9 under protanopia, 9.8 under normal vision.
// Anything past five folds into OTHER, which is deliberately not a hue.
const SLOT = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];
const OTHER = "#5b6070";
const SURFACE = "#111320";

const colorOf = (slice) => (slice.key === OTHER_KEY ? OTHER : SLOT[slice.slot] || OTHER);
const pct = (x) => (x * 100).toFixed(x >= 0.1 ? 0 : 1) + "%";

// NB: never name a prop `valueOf`/`toString` — destructuring an absent one
// picks the method up off Object.prototype instead of yielding undefined.
const Donut = ({ title, slices, total, note, secondary }) => {
  // Hover is linked by KEY, not by index: the ring and the list are in
  // different orders on purpose.
  const [active, setActive] = useState(null);
  const rows = slices.filter((s) => s.value > 0);
  // The ring keeps the palette's declared order — sorting it by size would let
  // any two hues end up touching, and the pairs that are then possible fail the
  // separation checks (orange vs yellow ΔE 10.6 normal, magenta vs green 1.6
  // deutan). The list is free to rank, since its identity is the name.
  const ranked = [...rows].sort((a, b) => b.value - a.value);
  if (!rows.length) return null;

  return (
    <div className="card" style={{ padding: "18px 20px" }}>
      <div className="lbl" style={{ marginBottom: 4 }}>{title}</div>
      {note && <div style={{ fontSize: 11, color: "#4b5563", marginBottom: 10 }}>{note}</div>}

      <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 168, height: 168, flexShrink: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={rows} dataKey="value" nameKey="label"
                innerRadius={54} outerRadius={80}
                paddingAngle={2} startAngle={90} endAngle={-270}
                stroke={SURFACE} strokeWidth={2} isAnimationActive={false}
                onMouseEnter={(e) => setActive(e?.payload?.key ?? null)} onMouseLeave={() => setActive(null)}
              >
                {rows.map((s) => (
                  <Cell key={s.key} fill={colorOf(s)} opacity={active === null || active === s.key ? 1 : 0.45} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: "#1a1d26", border: "1px solid #2a2d38", borderRadius: 8, fontFamily: "DM Mono", fontSize: 12 }}
                itemStyle={{ color: "#e8eaf0" }} labelStyle={{ display: "none" }}
                formatter={(v, _n, p) => [`${fmtShort(v)} ₽ · ${pct(p.payload.share)}`, p.payload.label]}
              />
            </PieChart>
          </ResponsiveContainer>
          {/* The hole carries the total, so the ring answers "of what?" itself. */}
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 19, fontWeight: 800, color: "#e8eaf0" }}>{fmtShort(total)}</div>
            <div style={{ fontSize: 11, color: "#4b5563" }}>₽</div>
          </div>
        </div>

        {/* Doubles as the table view: every slice named, with its exact number,
            so identity never rests on colour alone. */}
        <div style={{ flex: 1, minWidth: 190 }}>
          {ranked.map((s) => (
            <div key={s.key}
              onMouseEnter={() => setActive(s.key)} onMouseLeave={() => setActive(null)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6,
                background: active === s.key ? "#1a1d26" : "transparent", transition: "background 0.1s",
              }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: colorOf(s), flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "#9ca3af", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={s.members ? s.members.map((m) => `${m.label}: ${fmtShort(m.value)} ₽`).join("\n") : undefined}>
                {s.icon ? s.icon + " " : ""}{s.label}
              </span>
              {secondary && <span style={{ fontSize: 11, color: "#4b5563" }}>{secondary(s)}</span>}
              <span style={{ fontSize: 12, color: "#e8eaf0", minWidth: 52, textAlign: "right" }}>{fmtShort(s.value)} ₽</span>
              <span style={{ fontSize: 11, color: "#6b7280", minWidth: 34, textAlign: "right" }}>{pct(s.share)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default function StructureTab({ data, months, idx, ratesOf }) {
  const [month, setMonth] = useState(() => months[months.length - 1] || null);
  const m = months.includes(month) ? month : months[months.length - 1];

  const s = useMemo(
    () => (m ? structureFor(data, m, BASE_CURRENCY, ratesOf, idx) : null),
    [data, m, idx, ratesOf]
  );

  if (!m || !s) {
    return (
      <div className="fade-in card" style={{ border: "1px dashed #2a2d38", padding: "48px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🥧</div>
        <div style={{ fontSize: 14, color: "#6b7280" }}>Нет записей — сначала запишите месяц.</div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700, flex: 1 }}>Структура</div>
        <select className="sel" style={{ width: "auto", padding: "7px 12px", fontSize: 12 }}
          value={m} onChange={(e) => setMonth(e.target.value)}>
          {[...months].reverse().map((x) => <option key={x} value={x}>{monthLabel(x)}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 18, alignItems: "baseline" }}>
        <div>
          <div className="lbl" style={{ marginBottom: 4 }}>Активы</div>
          <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 26, fontWeight: 800 }}>{fmtShort(s.assets)} <span style={{ fontSize: 13, color: "#6b7280" }}>₽</span></div>
        </div>
        {s.liabilities > 0 && (
          <div>
            <div className="lbl" style={{ marginBottom: 4 }}>Долги</div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700, color: "#f87171" }}>−{fmtShort(s.liabilities)} <span style={{ fontSize: 12, color: "#6b7280" }}>₽</span></div>
          </div>
        )}
        {s.liabilities > 0 && (
          <div>
            <div className="lbl" style={{ marginBottom: 4 }}>Чистый капитал</div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700 }}>{fmtShort(s.net)} <span style={{ fontSize: 12, color: "#6b7280" }}>₽</span></div>
          </div>
        )}
      </div>

      {s.unconverted.length > 0 && (
        <div style={{ background: "#1a1a12", border: "1px solid #fcd34d44", color: "#fcd34d", borderRadius: 10, padding: "10px 14px", fontSize: 12, marginBottom: 14 }}>
          Без курса и потому не учтены: {s.unconverted.map((a) => a.name).join(", ")}.
        </div>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        <Donut title="По валютам" slices={s.byCurrency} total={s.assets}
          note="Доли активов. Долги показаны отдельно — отрицательная доля не бывает."
          secondary={(x) => (x.native !== undefined && x.key !== BASE_CURRENCY
            ? `${fmtBalance(x.native, x.key)} ${CURRENCY_SYMBOLS[x.key] || x.key}` : null)} />
        <Donut title="По инструментам" slices={s.byType} total={s.assets} />
        <Donut title="По счетам" slices={s.byAccount} total={s.assets}
          note="Пять крупнейших за всю историю; остальные сведены в одну долю — наведите, чтобы увидеть состав." />
      </div>
    </div>
  );
}
