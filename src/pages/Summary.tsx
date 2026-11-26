// สรุปผล / Pivot (SPEC §9, canvas 4). Step 1: month range, saved-view tabs, fixed pivot
// (เซอร์วิส › หัวข้อหลัก × เดือน) with heatmap, collapsible groups, MoM change, two charts and the
// drill-down panel (list → detail). Drag-and-drop config, editing, saving views and fullscreen: step 8.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Download, Maximize2, X } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { PivotResult, Project, SavedView, TicketRow } from "../lib/types";
import { delta, fmtInt, thDate, thMonth } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { ErrorState, SkeletonList } from "../components/ui";
import { NoData } from "../components/NoData";

interface Cell { service: string; category: string | null; month: string | null; label: string }

function heat(v: number, max: number): string {
  if (!v || !max) return "";
  const r = v / max;
  return r >= 0.75 ? "h4" : r >= 0.5 ? "h3" : r >= 0.25 ? "h2" : "h1";
}

function Delta({ prev, cur }: { prev: number; cur: number }) {
  const d = delta(prev, cur);
  if (!d) return <span className="muted">—</span>;
  return d.up
    ? <span className="delta-up" aria-label={`เพิ่มขึ้น ${d.text}`}>▲ {d.text}</span>
    : <span className="delta-down" aria-label={`ลดลง ${d.text}`}>▼ {d.text}</span>;
}

export default function SummaryPage({ project }: { project: Project }) {
  const app = useApp();
  const [months, setMonths] = useState<string[]>([]);
  const [noData, setNoData] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [views, setViews] = useState<SavedView[]>([]);
  const [view, setView] = useState<string | null>(null);
  const [heatOn, setHeatOn] = useState(true);
  const [pivot, setPivot] = useState<PivotResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [cell, setCell] = useState<Cell | null>(null);

  useEffect(() => {
    api.projectMonths(project.id).then((m) => { setMonths(m); setNoData(m.length === 0); setFrom(m[0] ?? ""); setTo(m[m.length - 1] ?? ""); }).catch((e) => setError(errMsg(e)));
    api.savedViews(project.id).then((v) => { setViews(v); setView(v[0]?.id ?? null); }).catch(() => setViews([]));
  }, [project.id]);

  useEffect(() => {
    if (!from || !to) return;
    api.pivot(project.id, from, to).then((p) => { setPivot(p); setError(null); }).catch((e) => setError(errMsg(e)));
  }, [project.id, from, to]);

  const max = useMemo(() => Math.max(0, ...(pivot?.groups.flatMap((g) => g.children.flatMap((c) => c.values)) ?? [])), [pivot]);
  const last = pivot ? pivot.months.length - 1 : -1;
  const top5 = useMemo(() => {
    if (!pivot || last < 0) return [];
    return pivot.groups.flatMap((g) => g.children.map((c) => ({ label: `${g.key} › ${c.key}`, color: g.color, v: c.values[last] })))
      .sort((a, b) => b.v - a.v).slice(0, 5);
  }, [pivot, last]);

  const open = (c: Cell) => setCell(c);

  if (noData) {
    return <div className="page" style={{ flex: 1 }}><h1 className="page-title">สรุปผล</h1><NoData title="ยังไม่มีข้อมูลสำหรับสรุปผล" /></div>;
  }

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div className="page" style={{ flex: 1, overflowY: "auto" }}>
        <header className="page-head" style={{ alignItems: "center" }}>
          <h1 className="page-title">สรุปผล</h1>
          <div className="toolbar">
            <select className="select sm" aria-label="ตั้งแต่เดือน" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }}>
              {months.map((m) => <option key={m} value={m}>{thMonth(m)}</option>)}
            </select>
            <span className="muted" style={{ fontSize: 13 }}>ถึง</span>
            <select className="select sm" aria-label="ถึงเดือน" value={to} onChange={(e) => { setTo(e.target.value); if (e.target.value < from) setFrom(e.target.value); }}>
              {months.map((m) => <option key={m} value={m}>{thMonth(m)}</option>)}
            </select>
            <button className="btn" onClick={() => app.setExportOpen(true)}><Download size={16} strokeWidth={2} aria-hidden="true" />{th.export}</button>
            <button className="icon-btn bordered" aria-label="แสดงเต็มจอ" onClick={() => app.toast("โหมดเต็มจอ — ทำในขั้นที่ 8")}><Maximize2 size={16} strokeWidth={2} /></button>
          </div>
        </header>

        <div className="toolbar">
          <span className="muted" style={{ fontSize: 13, fontWeight: 600 }}>มุมมองที่บันทึก</span>
          <div className="seg-tabs" role="tablist" aria-label="มุมมองที่บันทึก">
            {views.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} onClick={() => setView(v.id)}>{v.name}</button>
            ))}
          </div>
          <button className="btn" onClick={() => app.toast("บันทึกมุมมอง — ทำในขั้นที่ 8")}>+ บันทึกมุมมอง</button>
        </div>

        <section className="card" aria-label="ตั้งค่า pivot" style={{ padding: "12px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 22px" }}>
          <PivotZone label="แถว" chips={["เซอร์วิส", "หัวข้อหลัก"]} />
          <PivotZone label="คอลัมน์" chips={["เดือน"]} />
          <PivotZone label="ค่า" chips={["จำนวนทิกเก็ต"]} />
          <PivotZone label="ตัวกรอง" chips={[]} />
          <label className="check" style={{ marginLeft: "auto" }}>
            <input type="checkbox" checked={heatOn} onChange={(e) => setHeatOn(e.target.checked)} />Heatmap
          </label>
        </section>

        {error && <ErrorState message={error} />}
        {!pivot && !error && <SkeletonList rows={4} h={60} />}
        {pivot && (
          <>
            <div className="two-col" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
              <section className="card card-pad" aria-labelledby="top5-h">
                <h2 id="top5-h">5 หมวดที่พบบ่อยที่สุด · {last >= 0 ? thMonth(pivot.months[last], true) : ""}</h2>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {top5.map((t) => (
                    <div key={t.label} className="hbar">
                      <div className="hbar-top"><span>{t.label}</span><span className="num" style={{ fontWeight: 600 }}>{fmtInt(t.v)}</span></div>
                      <div className="hbar-track"><div style={{ width: `${top5[0].v ? (t.v / top5[0].v) * 100 : 0}%`, background: t.color }} /></div>
                    </div>
                  ))}
                </div>
              </section>
              <section className="card card-pad" aria-labelledby="trend-h">
                <h2 id="trend-h">แนวโน้มรายเดือนตามเซอร์วิส</h2>
                <TrendChart pivot={pivot} />
              </section>
            </div>

            <section className="card" aria-label="ตาราง pivot" style={{ overflow: "hidden" }}>
              <div className="muted" style={{ padding: "10px 16px", fontSize: 12, borderBottom: "1px solid var(--border)" }}>คลิกตัวเลขเพื่อดูทิกเก็ตในช่องนั้น</div>
              <div className="table-wrap">
                <table className="tbl pivot" style={{ fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th scope="col">เซอร์วิส › หัวข้อหลัก</th>
                      {pivot.months.map((m) => <th key={m} scope="col">{thMonth(m, true)}</th>)}
                      <th scope="col">รวม</th>
                      <th scope="col">เทียบเดือนก่อน</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pivot.groups.map((g) => (
                      <GroupRows
                        key={g.key}
                        g={g}
                        months={pivot.months}
                        max={max}
                        heatOn={heatOn}
                        collapsed={!!collapsed[g.key]}
                        toggle={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}
                        selected={cell}
                        onOpen={open}
                      />
                    ))}
                    <tr className="grand">
                      <th scope="row">รวมทั้งหมด</th>
                      {pivot.grand.map((v, i) => <td key={i}>{fmtInt(v)}</td>)}
                      <td>{fmtInt(pivot.grandTotal)}</td>
                      <td>{last > 0 ? <Delta prev={pivot.grand[last - 1]} cur={pivot.grand[last]} /> : "—"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
      {cell && <DrillPanel project={project} cell={cell} from={from} to={to} onClose={() => setCell(null)} />}
    </div>
  );
}

function PivotZone({ label, chips }: { label: string; chips: string[] }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
      {chips.map((c) => <span key={c} className="chip">{c}</span>)}
      {chips.length === 0 && <span className="chip dashed">+ ลากฟิลด์มาวาง</span>}
    </div>
  );
}

function GroupRows({ g, months, max, heatOn, collapsed, toggle, selected, onOpen }: {
  g: PivotResult["groups"][number]; months: string[]; max: number; heatOn: boolean; collapsed: boolean;
  toggle: () => void; selected: Cell | null; onOpen: (c: Cell) => void;
}) {
  const last = months.length - 1;
  return (
    <>
      <tr className="group">
        <th scope="row">
          <button className="collapse-btn" aria-expanded={!collapsed} onClick={toggle}>
            {collapsed ? <ChevronRight size={14} strokeWidth={2} aria-hidden="true" /> : <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />}
            <span className="swatch" style={{ background: g.color }} aria-hidden="true" />{g.key}
          </button>
        </th>
        {g.values.map((v, i) => <td key={i}>{fmtInt(v)}</td>)}
        <td>{fmtInt(g.total)}</td>
        <td>{last > 0 ? <Delta prev={g.values[last - 1]} cur={g.values[last]} /> : "—"}</td>
      </tr>
      {!collapsed && g.children.map((c) => (
        <tr key={c.key}>
          <th scope="row" style={{ paddingLeft: 40 }}>{c.key}</th>
          {c.values.map((v, i) => {
            const sel = selected?.service === g.key && selected.category === c.key && selected.month === months[i];
            return (
              <td key={i} className={`cell-btn ${heatOn ? heat(v, max) : ""}`}>
                <button
                  className={`pv-btn${sel ? " sel" : ""}`}
                  aria-label={`${g.key} › ${c.key} · ${thMonth(months[i])}: ${v} ทิกเก็ต`}
                  onClick={() => onOpen({ service: g.key, category: c.key, month: months[i], label: `${g.key} › ${c.key}` })}
                >
                  {fmtInt(v)}
                </button>
              </td>
            );
          })}
          <td>{fmtInt(c.total)}</td>
          <td>{last > 0 ? <Delta prev={c.values[last - 1]} cur={c.values[last]} /> : "—"}</td>
        </tr>
      ))}
    </>
  );
}

function TrendChart({ pivot }: { pivot: PivotResult }) {
  const W = 420, H = 170, P = 28;
  const max = Math.max(1, ...pivot.groups.flatMap((g) => g.values));
  const n = pivot.months.length;
  const x = (i: number) => (n <= 1 ? W / 2 : P + (i * (W - 2 * P)) / (n - 1));
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`จำนวนทิกเก็ตรายเดือนของ ${pivot.groups.map((g) => g.key).join(", ")}`}>
        <line x1={P} x2={W - P} y1={H - P} y2={H - P} stroke="var(--border)" />
        {pivot.months.map((m, i) => (
          <text key={m} x={x(i)} y={H - 8} textAnchor="middle" fontSize="17" fill="var(--muted)">{thMonth(m, true)}</text>
        ))}
        {pivot.groups.map((g) => (
          <g key={g.key}>
            <polyline points={g.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke={g.color} strokeWidth="2.5" strokeLinejoin="round" />
            {g.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="3.5" fill={g.color} />)}
          </g>
        ))}
      </svg>
      <div className="legend" style={{ marginTop: 6 }}>
        {pivot.groups.map((g) => <span key={g.key}><span className="swatch" style={{ background: g.color }} />{g.key}</span>)}
      </div>
    </div>
  );
}

function DrillPanel({ project, cell, from, to, onClose }: { project: Project; cell: Cell; from: string; to: string; onClose: () => void }) {
  const app = useApp();
  const [data, setData] = useState<{ total: number; rows: TicketRow[] } | null>(null);
  const [detail, setDetail] = useState<TicketRow | null>(null);
  useEffect(() => {
    setData(null);
    setDetail(null);
    api.drill(project.id, { service: cell.service, category: cell.category, month: cell.month }, from, to).then(setData).catch(() => setData({ total: 0, rows: [] }));
  }, [project.id, cell, from, to]);

  return (
    <aside className="drill" aria-label="รายละเอียดทิกเก็ต">
      {!detail ? (
        <>
          <div className="drill-head">
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span className="muted" style={{ fontSize: 12 }}>{cell.month ? thMonth(cell.month) : "ทุกเดือน"}</span>
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>{cell.label}</h2>
              <span className="muted" style={{ fontSize: 12 }}>{data ? `${fmtInt(data.total)} ทิกเก็ต${data.total > data.rows.length ? ` · แสดง ${data.rows.length} รายการแรก` : ""}` : "กำลังโหลด…"}</span>
            </div>
            <button className="icon-btn" aria-label="ปิดแผง" onClick={onClose}><X size={18} strokeWidth={1.8} /></button>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {data?.rows.map((t) => (
              <button key={t.id} className="tk" onClick={() => setDetail(t)}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                  <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{t.ticketNo}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{thDate(t.date)}</span>
                  {t.source === "human" && <span className="chip" style={{ marginLeft: "auto" }}>แก้โดยคน</span>}
                </span>
                <span className="ellipsis" style={{ fontSize: 13, color: "var(--text-2)", width: "100%" }}>{t.problemText}</span>
                <span style={{ fontSize: 12, color: "var(--accent-ink)", fontWeight: 600 }}>{Object.values(t.fields).slice(1).join(" › ") || "—"}</span>
              </button>
            ))}
          </div>
          <div style={{ padding: 12, borderTop: "1px solid var(--border)" }}>
            <button className="btn" style={{ width: "100%" }} onClick={() => app.go({ name: "project", tab: "results" })}>ดูทั้งหมดในหน้าผลลัพธ์</button>
          </div>
        </>
      ) : (
        <>
          <div className="drill-head" style={{ alignItems: "center" }}>
            <button className="btn btn-ghost" onClick={() => setDetail(null)}><ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />กลับไปรายการ</button>
            <button className="icon-btn" aria-label="ปิดแผง" onClick={onClose}><X size={18} strokeWidth={1.8} /></button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <h2 className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{detail.ticketNo}</h2>
              <p style={{ fontSize: 13, lineHeight: 1.7 }}>{detail.problemText}</p>
            </div>
            <div className="kv">
              {Object.entries(detail.sourceRow).map(([k, v]) => <div key={k}><span className="k">{k}</span><span>{v}</span></div>)}
            </div>
            {detail.aiFields && (
              <div className="info-box" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                <span className="muted" style={{ fontSize: 12 }}>AI จัดหมวดเป็น · ความมั่นใจ {detail.confidence != null ? `${Math.round(detail.confidence * 100)}%` : "—"}</span>
                <span style={{ fontWeight: 600, color: "var(--text)" }}>{Object.values(detail.aiFields).join(" › ")}</span>
                {detail.reason && <span style={{ fontSize: 12 }}>เหตุผล: {detail.reason}</span>}
              </div>
            )}
            {detail.source === "human" && detail.aiFields && (
              <div className="chip" style={{ whiteSpace: "normal" }}>แก้โดยคน · เดิม AI จัดเป็น {Object.values(detail.aiFields).join(" › ")}</div>
            )}
            <div className="form-grid">
              {Object.entries(detail.fields).map(([k, v]) => (
                <div key={k} className="field">
                  <label htmlFor={`dd-${k}`}>{k}</label>
                  <select id={`dd-${k}`} className="select" value={v} disabled><option value={v}>{v}</option></select>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn" onClick={() => setDetail(null)}>ยกเลิก</button>
              <button className="btn btn-primary" onClick={() => app.toast("แก้หมวดแล้ว pivot อัปเดตทันที — ทำในขั้นที่ 8")}>บันทึก</button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
