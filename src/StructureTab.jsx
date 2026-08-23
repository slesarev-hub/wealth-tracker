import { useMemo, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";

import { BASE_CURRENCY } from "./lib/model.js";
import { CURRENCY_SYMBOLS, fmtShort, fmtAmount, monthLabel } from "./lib/format.js";
import { structureFor, OTHER_KEY } from "./lib/structure.js";

// Six hues plus one neutral, all-pairs validated on this surface (#111320):
// worst pair ΔE 8.4 under protanopia, 15.9 for normal vision, every swatch over
// 3:1 against the surface. All-pairs is the binding list because a category
// absent from the displayed month closes the gap and re-seats its neighbours.
//
// Lightness deliberately varies — two of these sit outside the equal-weight
// band. That is the trade that makes six work at all: under deuteranopia hue
// collapses toward one axis, and lightness is the only channel left that still
// separates a red from a green. A ring's slices already differ in weight, so
// equal visual weight is the cheaper thing to spend. The equal-lightness
// version of this palette caps out at three.
const SLOT = ["#4a90e2", "#c98500", "#199e70", "#d58cb4", "#a8cdf7", "#f2cd7d"];
const OTHER = "#6e6a63";
const SURFACE = "#111320";
const INK = "#e8eaf0", INK_2 = "#9ca3af", INK_3 = "#6b7280";

const colorOf = (slice) => (slice.key === OTHER_KEY ? OTHER : SLOT[slice.slot] || OTHER);
const pct = (x) => (x * 100).toFixed(x >= 0.1 ? 0 : 1) + "%";

// NB: never name a prop `valueOf`/`toString` — destructuring an absent one
// picks the method up off Object.prototype instead of yielding undefined.
// Ranked bars for a set too large to be a ring. No colour identity is needed —
// the bar length is the encoding and the name is right there — so the series
// cap that constrains the donut does not apply here at all.
const Bars = ({ title, rows }) => {
  if (!rows.length) return null;
  const max = rows[0].share || 1;
  return (
    <div className="card" style={{ padding: "18px 20px" }}>
      <div className="lbl" style={{ marginBottom: 12 }}>{title}</div>
      {rows.map((s) => (
        <div key={s.key} style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6 }}>
          <div style={{
            position: "absolute", inset: "0 auto 0 0", width: `${Math.max((s.share / max) * 100, 0.6)}%`,
            background: "#1d3a4f", borderRadius: 6, pointerEvents: "none",
          }} />
          <span style={{ position: "relative", fontSize: 12, color: INK_2, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.label}>
            {s.icon ? s.icon + " " : ""}{s.label}
          </span>
          {s.currency && s.currency !== BASE_CURRENCY && (
            <span style={{ position: "relative", fontSize: 11, color: INK_3, whiteSpace: "nowrap" }}>
              {fmtAmount(s.native, s.currency)} {CURRENCY_SYMBOLS[s.currency] || s.currency}
            </span>
          )}
          <span style={{ position: "relative", fontSize: 12, color: INK, minWidth: 56, textAlign: "right" }}>{fmtShort(s.value)} ₽</span>
          <span style={{ position: "relative", fontSize: 11, color: INK_2, minWidth: 36, textAlign: "right" }}>{pct(s.share)}</span>
        </div>
      ))}
    </div>
  );
};

const Donut = ({ title, slices, total, secondary }) => {
  const [active, setActive] = useState(null);
  const [open, setOpen] = useState(false);

  const rows = slices.filter((s) => s.value > 0);
  // The ring keeps the palette's declared order; the list ranks by value. Hover
  // links them by KEY, and a key that is no longer on screen highlights nothing
  // — otherwise a stale key would leave the whole ring dimmed with nothing lit.
  const lit = active !== null && rows.some((r) => r.key === active) ? active : null;
  const ranked = [...rows].sort((a, b) => b.value - a.value);
  if (!rows.length) return null;

  const Row = ({ s, inset }) => (
    <div
      onMouseEnter={() => setActive(s.key)} onMouseLeave={() => setActive(null)}
      style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, marginLeft: inset ? 18 : 0 }}>
      {/* A share bar behind each row. The list is the readable chart and the
          ring is the glance, so nothing is lost when the tail is folded. */}
      <div style={{
        position: "absolute", inset: "0 auto 0 0", width: `${Math.max(s.share * 100, 0.6)}%`,
        background: lit === s.key ? "#242938" : "#191c26", borderRadius: 6, pointerEvents: "none",
      }} />
      <span style={{ position: "relative", width: 9, height: 9, borderRadius: 2, background: inset ? "#3a3f4d" : colorOf(s), flexShrink: 0 }} />
      <span style={{ position: "relative", fontSize: 12, color: INK_2, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.label}>
        {s.icon ? s.icon + " " : ""}{s.label}
      </span>
      {secondary && secondary(s) && <span style={{ position: "relative", fontSize: 11, color: INK_3 }}>{secondary(s)}</span>}
      <span style={{ position: "relative", fontSize: 12, color: INK, minWidth: 56, textAlign: "right" }}>{fmtShort(s.value)} ₽</span>
      <span style={{ position: "relative", fontSize: 11, color: INK_2, minWidth: 36, textAlign: "right" }}>{pct(s.share)}</span>
    </div>
  );

  return (
    <div className="card" style={{ padding: "18px 20px" }}>
      <div className="lbl" style={{ marginBottom: 12 }}>{title}</div>

      <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 168, height: 168, flexShrink: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={rows} dataKey="value" nameKey="label"
                innerRadius={54} outerRadius={80}
                // minAngle keeps a sub-percent slice from being erased by the
                // gap and the surface stroke while the list still reports it.
                paddingAngle={1} minAngle={3} startAngle={90} endAngle={-270}
                stroke={SURFACE} strokeWidth={2} isAnimationActive={false}
                onMouseEnter={(e) => setActive(e?.payload?.key ?? null)} onMouseLeave={() => setActive(null)}
              >
                {rows.map((s) => (
                  <Cell key={s.key} fill={colorOf(s)} opacity={lit === null || lit === s.key ? 1 : 0.4} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: "#1a1d26", border: "1px solid #2a2d38", borderRadius: 8, fontFamily: "DM Mono", fontSize: 12 }}
                itemStyle={{ color: INK }} labelStyle={{ display: "none" }}
                formatter={(v, _n, p) => [`${fmtShort(v)} ₽ · ${pct(p.payload.share)}`, p.payload.label]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 19, fontWeight: 800, color: INK }}>{fmtShort(total)}</div>
            <div style={{ fontSize: 11, color: INK_3 }}>₽</div>
          </div>
        </div>

        {/* Every category by name and number — the table view the ring leans on,
            and the only thing that works without a mouse. */}
        <div style={{ flex: 1, minWidth: 190 }}>
          {ranked.map((s) => (
            <div key={s.key}>
              <Row s={s} />
              {s.members && (
                <>
                  <button className="tab-btn" onClick={() => setOpen(!open)}
                    style={{ fontSize: 11, color: INK_2, padding: "2px 8px", marginLeft: 18, textDecoration: "underline dotted" }}>
                    {open ? "свернуть" : `показать ${s.members.length}`}
                  </button>
                  {open && s.members.map((mm) => <Row key={mm.key} s={mm} inset />)}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default function StructureTab({ data, months, idx, ratesOf }) {
  const [month, setMonth] = useState(null);
  // Derived, never stale: a remembered month that no longer exists falls back
  // to the latest instead of silently reasserting itself if it ever returns.
  const m = month && months.includes(month) ? month : months[months.length - 1];

  const s = useMemo(
    () => (m ? structureFor(data, m, BASE_CURRENCY, ratesOf, idx) : null),
    [data, m, idx, ratesOf]
  );

  if (!m || !s) {
    return (
      <div className="fade-in card" style={{ border: "1px dashed #2a2d38", padding: "48px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🥧</div>
        <div style={{ fontSize: 14, color: INK_3 }}>Нет записей — сначала запишите месяц.</div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700, flex: 1, cursor: "help" }}
          title="Доли считаются от активов. Долги в них не входят — доля от целого не бывает отрицательной.">Активы · структура</div>
        <select className="sel" style={{ width: "auto", padding: "7px 12px", fontSize: 12 }}
          value={m} onChange={(e) => setMonth(e.target.value)}>
          {[...months].reverse().map((x) => <option key={x} value={x}>{monthLabel(x)}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 10, alignItems: "baseline" }}>
        <div>
          <div className="lbl" style={{ marginBottom: 4 }}>Активы</div>
          <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 26, fontWeight: 800 }}>{fmtShort(s.assets)} <span style={{ fontSize: 13, color: INK_3 }}>₽</span></div>
        </div>
        {s.liabilities > 0 && (
          <>
            <div>
              <div className="lbl" style={{ marginBottom: 4 }}>Долги</div>
              <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700, color: "#f87171" }}>−{fmtShort(s.liabilities)} <span style={{ fontSize: 12, color: INK_3 }}>₽</span></div>
            </div>
            <div>
              <div className="lbl" style={{ marginBottom: 4 }}>Чистый капитал</div>
              <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 700 }}>{fmtShort(s.net)} <span style={{ fontSize: 12, color: INK_3 }}>₽</span></div>
            </div>
          </>
        )}
      </div>

      {s.unconverted.length > 0 && (
        <div style={{ background: "#1a1a12", border: "1px solid #fcd34d44", color: "#fcd34d", borderRadius: 10, padding: "10px 14px", fontSize: 12, marginBottom: 14 }}>
          Без курса и потому не учтены: {s.unconverted.map((a) => a.name).join(", ")}.
        </div>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        <Donut title="По валютам" slices={s.byCurrency} total={s.assets}
          secondary={(x) => {
            const c = x.ofKey || x.key;
            return x.native !== undefined && c !== BASE_CURRENCY
              ? `${fmtAmount(x.native, c)} ${CURRENCY_SYMBOLS[c] || c}` : null;
          }} />
        <Donut title="По инструментам" slices={s.byType} total={s.assets} />
        <Bars title="По счетам" rows={s.accountRows} />
      </div>
    </div>
  );
}
