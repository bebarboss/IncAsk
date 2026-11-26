// Charts next to the pivot (SPEC §9) — hand-written SVG/CSS, data-only, shared with the report.
import type { Charts } from "../lib/types";
import { fmtInt, thMonth } from "../lib/format";

export function TopBars({ charts }: { charts: Charts }) {
  const last = charts.months[charts.months.length - 1];
  const max = charts.top[0]?.count ?? 0;
  return (
    <section className="card card-pad" aria-labelledby="top5-h">
      <h2 id="top5-h">5 หมวดที่พบบ่อยที่สุด{last ? ` · ${thMonth(last, true)}` : ""}</h2>
      {charts.top.length === 0 && <p className="muted">ยังไม่มีทิกเก็ตที่จัดหมวดแล้วในเดือนนี้</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {charts.top.map((t) => (
          <div key={t.service + t.category} className="hbar">
            <div className="hbar-top"><span>{t.service} › {t.category}</span><span className="num" style={{ fontWeight: 600 }}>{fmtInt(t.count)}</span></div>
            <div className="hbar-track"><div style={{ width: `${max ? (t.count / max) * 100 : 0}%`, background: t.color }} /></div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function TrendChart({ charts }: { charts: Charts }) {
  const W = 420, H = 170, P = 30, L = 52;
  const max = Math.max(1, ...charts.trend.flatMap((s) => s.values));
  const n = charts.months.length;
  const x = (i: number) => (n <= 1 ? W / 2 : L + (i * (W - L - P)) / (n - 1));
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const step = Math.max(1, Math.ceil(n / 6));
  return (
    <section className="card card-pad" aria-labelledby="trend-h">
      <h2 id="trend-h">แนวโน้มรายเดือนตามเซอร์วิส</h2>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`จำนวนทิกเก็ตรายเดือน: ${charts.trend.map((s) => `${s.name} ${s.values.map(fmtInt).join(", ")}`).join(" · ")}`}>
        <line x1={L} x2={W - P} y1={H - P} y2={H - P} stroke="var(--border)" />
        <text x={L - 8} y={y(max) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{fmtInt(max)}</text>
        {charts.months.map((m, i) => (i % step === 0 || i === n - 1) && (
          <text key={m} x={x(i)} y={H - 9} textAnchor="middle" fontSize="12" fill="var(--muted)">{thMonth(m, true)}</text>
        ))}
        {charts.trend.map((s) => (
          <g key={s.name}>
            <polyline points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" />
            {s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="3.5" fill={s.color}><title>{`${s.name} · ${thMonth(charts.months[i])}: ${fmtInt(v)}`}</title></circle>)}
          </g>
        ))}
      </svg>
      <div className="legend" style={{ marginTop: 6 }}>
        {charts.trend.map((s) => <span key={s.name}><span className="swatch" style={{ background: s.color }} />{s.name}</span>)}
      </div>
    </section>
  );
}
