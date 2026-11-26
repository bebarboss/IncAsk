// สรุปผล / Pivot (SPEC §9, canvas 4 + 4.1): month range, saved views, drag-and-drop pivot fields,
// pivot + heatmap + charts, drill-down with editing (pivot and charts refresh in place), fullscreen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Maximize2, Minimize2, Plus, Trash2, X } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { Charts as ChartData, PivotConfig, PivotResult, Project, SavedView, TicketRow, ViewConfig } from "../lib/types";
import { fmtInt, thMonth } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { ErrorState, Modal, SkeletonList, usePopover } from "../components/ui";
import { NoData } from "../components/NoData";
import { Delta, PivotTable, fieldLabel, valueLabel, type CellRef } from "../components/PivotTable";
import { TopBars, TrendChart } from "../components/Charts";
import { TicketPanel } from "../components/TicketPanel";
import { categoryLabel, useTaxonomy } from "../components/CategoryPicker";

const DEFAULT_VIEW: ViewConfig = { rows: ["service"], col: "month", value: "count", filters: [], heat: true };
type Zone = "rows" | "col" | "filters";

export default function SummaryPage({ project }: { project: Project }) {
  const app = useApp();
  const tax = useTaxonomy(project.id);
  const [months, setMonths] = useState<string[] | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [srcCols, setSrcCols] = useState<string[]>([]);
  const [views, setViews] = useState<SavedView[]>([]);
  const [activeView, setActiveView] = useState<string | null>(null);
  const [view, setView] = useState<ViewConfig | null>(null);
  const [pivot, setPivot] = useState<PivotResult | null>(null);
  const [charts, setCharts] = useState<ChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cell, setCell] = useState<CellRef | null>(null);
  const [drill, setDrill] = useState<{ total: number; rows: TicketRow[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const fs = app.fullscreen;

  const catCols = useMemo(() => [...new Set(Object.values(tax ?? {}).flatMap((t) => t.service.columns))], [tax]);
  const colors = useMemo(() => Object.fromEntries(Object.values(tax ?? {}).map((t) => [t.service.name, t.service.color])), [tax]);
  const fields = useMemo(() => ["service", "month", ...catCols.map((c) => `cat:${c}`), "source", ...srcCols.map((c) => `src:${c}`)], [catCols, srcCols]);

  // first load: months, views (the first one applied), heatmap preference
  useEffect(() => {
    api.projectMonths(project.id).then((m) => { setMonths(m); setFrom(m[0] ?? ""); setTo(m[m.length - 1] ?? ""); }).catch((e) => setError(errMsg(e)));
    api.sourceColumns(project.id).then(setSrcCols).catch(() => {});
    api.savedViews(project.id).then((v) => {
      setViews(v);
      if (v[0]) { setActiveView(v[0].id); setView(v[0].config); }
      else setView({ ...DEFAULT_VIEW, rows: catCols.length ? ["service", `cat:${catCols[0]}`] : ["service"] });
    }).catch(() => setView(DEFAULT_VIEW));
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // the default view needs category columns, which arrive with the taxonomy
  useEffect(() => {
    if (view && !activeView && view.rows.length === 1 && view.rows[0] === "service" && catCols.length) setView({ ...view, rows: ["service", `cat:${catCols[0]}`] });
  }, [catCols]); // eslint-disable-line react-hooks/exhaustive-deps

  const cfg = useMemo<PivotConfig | null>(() => (view && from && to ? { rows: view.rows, col: view.col, filters: view.filters, from, to } : null), [view, from, to]);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!cfg) return;
    const n = ++seq.current;
    try {
      const [p, c] = await Promise.all([api.pivot(project.id, cfg), api.pivotCharts(project.id, cfg.from, cfg.to, cfg.filters)]);
      if (n !== seq.current) return;
      setPivot(p);
      setCharts(c);
      setError(null);
    } catch (e) {
      if (n === seq.current) setError(errMsg(e));
    }
  }, [cfg, project.id]);
  useEffect(() => { load(); }, [load]);

  const loadDrill = useCallback(async (c: CellRef) => {
    if (!cfg) return;
    setDrill(null);
    try { setDrill(await api.drill(project.id, cfg, { path: c.path, col: c.col }, 100)); } catch { setDrill({ total: 0, rows: [] }); }
  }, [cfg, project.id]);
  useEffect(() => { if (cell) loadDrill(cell); }, [cell, loadDrill]);

  // F11 toggles fullscreen here, Esc leaves it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11") { e.preventDefault(); app.setFullscreen(!app.fullscreen); }
      else if (e.key === "Escape" && app.fullscreen && !document.querySelector(".modal")) app.setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app]);
  useEffect(() => () => app.setFullscreen(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const setV = (patch: Partial<ViewConfig>) => { setView((v) => ({ ...(v ?? DEFAULT_VIEW), ...patch })); setCell(null); };
  const applyView = (v: SavedView) => { setActiveView(v.id); setView(v.config); setCell(null); };
  const place = (field: string, zone: Zone) => {
    if (!view) return;
    const rows = view.rows.filter((f) => f !== field);
    const col = view.col === field ? "" : view.col;
    const filters = view.filters.filter((f) => f.field !== field);
    if (zone === "rows") setV({ rows: [...rows, field].slice(-3), col, filters });
    if (zone === "col") setV({ rows: rows.length ? rows : view.rows, col: field, filters });
    if (zone === "filters") setV({ filters: [...filters, { field, values: [] }] });
  };

  const save = async (ticket: TicketRow, f: Record<string, string>) => {
    await api.setCategory(project.id, [ticket.id], f);
    // pivot + charts + this list update in place — the ticket may move to another cell
    await Promise.all([load(), cell ? loadDrill(cell) : Promise.resolve()]);
    app.toast(`✓ ${ticket.ticketNo} → ${categoryLabel(tax?.[ticket.service]?.service.columns, f)}`);
  };

  if (months && months.length === 0) {
    return <div className="page" style={{ flex: 1 }}><h1 className="page-title">สรุปผล</h1><NoData title="ยังไม่มีข้อมูลสำหรับสรุปผล" /></div>;
  }
  if (!view) return <div className="page"><SkeletonList rows={4} h={60} /></div>;

  const rangeSelects = (dark?: boolean) => (
    <>
      <select className="select sm" aria-label="ตั้งแต่เดือน" value={from} style={dark ? { background: "#262A31", color: "#ECEEF2", borderColor: "#3B414C" } : undefined}
        onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }}>
        {(months ?? []).map((m) => <option key={m} value={m}>{thMonth(m)}</option>)}
      </select>
      <span style={{ fontSize: 13, color: dark ? "#C9CDD5" : "var(--muted)" }}>ถึง</span>
      <select className="select sm" aria-label="ถึงเดือน" value={to} style={dark ? { background: "#262A31", color: "#ECEEF2", borderColor: "#3B414C" } : undefined}
        onChange={(e) => { setTo(e.target.value); if (e.target.value < from) setFrom(e.target.value); }}>
        {(months ?? []).map((m) => <option key={m} value={m}>{thMonth(m)}</option>)}
      </select>
    </>
  );

  const body = (
    <>
      {error && <ErrorState message={error} onRetry={load} />}
      {!pivot && !error && <SkeletonList rows={4} h={60} />}
      {pivot && charts && (
        <>
          {fs && <ServiceCards charts={charts} />}
          <div className="two-col" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
            <TopBars charts={charts} />
            <TrendChart charts={charts} />
          </div>
          <section className="card" aria-label="ตาราง pivot" style={{ overflow: "hidden" }}>
            <div className="muted" style={{ padding: "10px 16px", fontSize: 12, borderBottom: "1px solid var(--border)" }}>
              คลิกตัวเลขเพื่อดูทิกเก็ตในช่องนั้น{view.filters.some((f) => f.values.length) ? " · มีตัวกรอง" : ""}
            </div>
            <div className="table-wrap">
              <PivotTable result={pivot} rows={view.rows} col={view.col} value={view.value} heatOn={view.heat} colors={colors} onCell={setCell} selected={cell} large={fs} />
            </div>
          </section>
        </>
      )}
    </>
  );

  if (fs) {
    return (
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <FullscreenBar>
          <span style={{ fontSize: 12, color: "#C9CDD5", padding: "0 4px" }}>ช่วง</span>
          {rangeSelects(true)}
          {views.map((v) => (
            <button key={v.id} className={`fs-btn${activeView === v.id ? " on" : ""}`} aria-pressed={activeView === v.id} onClick={() => applyView(v)}>{v.name}</button>
          ))}
          <button className={`fs-btn${view.heat ? " on" : ""}`} aria-pressed={view.heat} onClick={() => setV({ heat: !view.heat })}>Heatmap</button>
          <span style={{ width: 1, height: 22, background: "#3B414C" }} />
          <button className="fs-btn" onClick={() => app.setFullscreen(false)}><Minimize2 size={15} strokeWidth={2} aria-hidden="true" />ออกจากเต็มจอ · Esc</button>
        </FullscreenBar>
        <div className="page fs-page" style={{ flex: 1, overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
            <h1 style={{ fontSize: 28, fontWeight: 700 }}>{project.name}{activeView ? ` · ${views.find((v) => v.id === activeView)?.name ?? ""}` : ""}</h1>
            <span className="muted">{thMonth(from)} – {thMonth(to)} · {fmtInt(pivot?.grandTotal ?? 0)} ทิกเก็ต</span>
          </div>
          {body}
        </div>
        {cell && <TicketPanel cell={cell} data={drill} taxonomy={tax} onClose={() => setCell(null)} onSave={save} />}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div className="page" style={{ flex: 1, overflowY: "auto" }}>
        <header className="page-head" style={{ alignItems: "center" }}>
          <h1 className="page-title">สรุปผล</h1>
          <div className="toolbar">
            {rangeSelects()}
            <button className="btn" onClick={() => app.setExportOpen(true)}><Download size={16} strokeWidth={2} aria-hidden="true" />{th.export}</button>
            <button className="icon-btn bordered" aria-label="แสดงเต็มจอ (F11)" title="เต็มจอ (F11)" onClick={() => app.setFullscreen(true)}><Maximize2 size={16} strokeWidth={2} /></button>
          </div>
        </header>

        <div className="toolbar">
          <span className="muted" style={{ fontSize: 13, fontWeight: 600 }}>มุมมองที่บันทึก</span>
          {views.length > 0 && (
            <div className="seg-tabs" role="tablist" aria-label="มุมมองที่บันทึก">
              {views.map((v) => <button key={v.id} role="tab" aria-selected={activeView === v.id} onClick={() => applyView(v)}>{v.name}</button>)}
            </div>
          )}
          {activeView && (
            <button className="icon-btn" aria-label="ลบมุมมองนี้" title="ลบมุมมองนี้" onClick={async () => {
              await api.deleteView(project.id, activeView);
              setViews(views.filter((v) => v.id !== activeView));
              setActiveView(null);
            }}><Trash2 size={15} strokeWidth={1.8} /></button>
          )}
          <button className="btn" onClick={() => setSaving(true)}><Plus size={15} strokeWidth={2} aria-hidden="true" />บันทึกมุมมอง</button>
        </div>

        <PivotConfigBar projectId={project.id} view={view} fields={fields} from={from} to={to} onPlace={place} onChange={setV} />
        {body}
      </div>
      {cell && <TicketPanel cell={cell} data={drill} taxonomy={tax} onClose={() => setCell(null)} onSave={save}
        onSeeAll={() => app.go({ name: "project", tab: "results" })} />}
      {saving && (
        <SaveViewDialog views={views} activeView={activeView} onClose={() => setSaving(false)} onSave={async (id, name) => {
          const v = await api.saveView(project.id, id, name, view);
          setViews((cur) => (cur.some((x) => x.id === v.id) ? cur.map((x) => (x.id === v.id ? v : x)) : [...cur, v]));
          setActiveView(v.id);
          app.toast(`✓ บันทึกมุมมอง ${v.name}`);
        }} />
      )}
    </div>
  );
}

/** Field chips: drag into แถว / คอลัมน์ / ตัวกรอง, or click a chip for the same choices (keyboard). */
function PivotConfigBar({ projectId, view, fields, from, to, onPlace, onChange }: {
  projectId: string; view: ViewConfig; fields: string[]; from: string; to: string;
  onPlace: (field: string, zone: Zone) => void; onChange: (p: Partial<ViewConfig>) => void;
}) {
  const used = new Set([...view.rows, view.col, ...view.filters.map((f) => f.field)]);
  const drop = (zone: Zone) => ({
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => { const f = e.dataTransfer.getData("text/field"); if (f) onPlace(f, zone); },
  });
  const chip = (f: string, onRemove: () => void) => (
    <span key={f} className="chip" draggable onDragStart={(e) => e.dataTransfer.setData("text/field", f)}>
      {fieldLabel(f)}
      <button className="attach-x" aria-label={`เอา ${fieldLabel(f)} ออก`} onClick={onRemove}><X size={12} strokeWidth={2.4} /></button>
    </span>
  );
  return (
    <section className="card" aria-label="ตั้งค่า pivot" style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 22px" }}>
        <div className="pv-zone" {...drop("rows")}>
          <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>แถว</span>
          {view.rows.map((f) => chip(f, () => view.rows.length > 1 && onChange({ rows: view.rows.filter((x) => x !== f) })))}
          {view.rows.length < 3 && <span className="chip dashed">+ ลากมาวาง</span>}
        </div>
        <div className="pv-zone" {...drop("col")}>
          <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>คอลัมน์</span>
          {view.col ? chip(view.col, () => onChange({ col: "" })) : <span className="chip dashed">+ ลากมาวาง</span>}
        </div>
        <div className="pv-zone">
          <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>ค่า</span>
          <div className="seg-tabs sm" role="radiogroup" aria-label="ค่า">
            <button role="radio" aria-checked={view.value === "count"} onClick={() => onChange({ value: "count" })}>จำนวนทิกเก็ต</button>
            <button role="radio" aria-checked={view.value === "share"} onClick={() => onChange({ value: "share" })}>ส่วนแบ่ง %</button>
          </div>
        </div>
        <div className="pv-zone" {...drop("filters")}>
          <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>ตัวกรอง</span>
          {view.filters.map((f, i) => (
            <FilterChip key={f.field} projectId={projectId} field={f.field} values={f.values} from={from} to={to}
              onChange={(values) => onChange({ filters: view.filters.map((x, j) => (j === i ? { ...x, values } : x)) })}
              onRemove={() => onChange({ filters: view.filters.filter((_, j) => j !== i) })} />
          ))}
          <span className="chip dashed">+ ลากมาวาง</span>
        </div>
        <label className="check" style={{ marginLeft: "auto" }}>
          <input type="checkbox" checked={view.heat} onChange={(e) => onChange({ heat: e.target.checked })} />Heatmap
        </label>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, paddingTop: 8, borderTop: "1px solid var(--border-soft)" }}>
        <span className="muted" style={{ fontSize: 12 }}>ฟิลด์ (ลากไปวาง หรือคลิก):</span>
        {fields.filter((f) => !used.has(f)).map((f) => <FieldChip key={f} field={f} onPlace={onPlace} canRow={view.rows.length < 3} />)}
      </div>
    </section>
  );
}

function FieldChip({ field, onPlace, canRow }: { field: string; onPlace: (f: string, z: Zone) => void; canRow: boolean }) {
  const pop = usePopover();
  return (
    <div ref={pop.ref} style={{ position: "relative" }}>
      <button className="chip dashed" draggable onDragStart={(e) => e.dataTransfer.setData("text/field", field)} aria-haspopup="menu" aria-expanded={pop.open} onClick={() => pop.setOpen(!pop.open)}>
        {field.startsWith("src:") ? `${fieldLabel(field)} · ต้นทาง` : fieldLabel(field)}
      </button>
      {pop.open && (
        <div className="popover" role="menu" style={{ left: 0, top: 30, minWidth: 160 }}>
          <button role="menuitem" className="menu-item" disabled={!canRow} onClick={() => { pop.setOpen(false); onPlace(field, "rows"); }}>ใส่ในแถว</button>
          <button role="menuitem" className="menu-item" onClick={() => { pop.setOpen(false); onPlace(field, "col"); }}>ใส่ในคอลัมน์</button>
          <button role="menuitem" className="menu-item" onClick={() => { pop.setOpen(false); onPlace(field, "filters"); }}>ใช้เป็นตัวกรอง</button>
        </div>
      )}
    </div>
  );
}

function FilterChip({ projectId, field, values, from, to, onChange, onRemove }: {
  projectId: string; field: string; values: string[]; from: string; to: string; onChange: (v: string[]) => void; onRemove: () => void;
}) {
  const pop = usePopover();
  const [all, setAll] = useState<string[] | null>(null);
  useEffect(() => { if (pop.open && !all) api.pivotValues(projectId, field, from, to).then(setAll).catch(() => setAll([])); }, [pop.open, all, projectId, field, from, to]);
  return (
    <div ref={pop.ref} style={{ position: "relative" }}>
      <span className="chip">
        <button className="link-btn" style={{ color: "inherit", fontWeight: 600, fontSize: 12 }} aria-haspopup="dialog" aria-expanded={pop.open} onClick={() => pop.setOpen(!pop.open)}>
          {fieldLabel(field)}: {values.length ? (values.length === 1 ? valueLabel(field, values[0], true) : `${values.length} ค่า`) : "ทั้งหมด"}
        </button>
        <button className="attach-x" aria-label={`เอาตัวกรอง ${fieldLabel(field)} ออก`} onClick={onRemove}><X size={12} strokeWidth={2.4} /></button>
      </span>
      {pop.open && (
        <div className="popover" role="dialog" aria-label={`กรอง ${fieldLabel(field)}`} style={{ left: 0, top: 32, width: 260, maxHeight: 320, overflowY: "auto" }}>
          {!all ? <SkeletonList rows={3} h={24} /> : all.map((v) => (
            <label key={v} className="check" style={{ padding: "4px 8px", display: "flex" }}>
              <input type="checkbox" checked={values.includes(v)} onChange={(e) => onChange(e.target.checked ? [...values, v] : values.filter((x) => x !== v))} />
              {valueLabel(field, v)}
            </label>
          ))}
          {values.length > 0 && <><div className="menu-sep" /><button className="menu-item" onClick={() => onChange([])}>ล้างตัวกรอง</button></>}
        </div>
      )}
    </div>
  );
}

function ServiceCards({ charts }: { charts: ChartData }) {
  const n = charts.months.length;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(Math.max(charts.trend.length, 1), 6)}, minmax(0, 1fr))`, gap: 14 }}>
      {charts.trend.map((s) => (
        <div key={s.name} style={{ padding: "14px 16px", background: "var(--surface)", border: "1px solid var(--border)", borderTop: `4px solid ${s.color}`, borderRadius: 12 }}>
          <div className="muted" style={{ fontSize: 13 }}>{s.name}{n ? ` · ${thMonth(charts.months[n - 1], true)}` : ""}</div>
          <div style={{ fontSize: 26, fontWeight: 700, display: "flex", alignItems: "baseline", gap: 8 }}>
            {fmtInt(s.values[n - 1] ?? 0)}
            {n >= 2 && <span style={{ fontSize: 14 }}><Delta prev={s.values[n - 2]} cur={s.values[n - 1]} /></span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Dark toolbar that slides in when the pointer is within 48 px of the top edge. */
function FullscreenBar({ children }: { children: React.ReactNode }) {
  const [show, setShow] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShow(false), 2500);
    const onMove = (e: MouseEvent) => setShow(e.clientY < 48 || !!(e.target as HTMLElement).closest?.(".fs-bar"));
    window.addEventListener("mousemove", onMove);
    return () => { clearTimeout(t); window.removeEventListener("mousemove", onMove); };
  }, []);
  return (
    <div role="toolbar" aria-label="แถบเครื่องมือโหมดเต็มจอ" className={`fs-bar${show ? " show" : ""}`} onFocus={() => setShow(true)}>
      {children}
    </div>
  );
}

function SaveViewDialog({ views, activeView, onClose, onSave }: { views: SavedView[]; activeView: string | null; onClose: () => void; onSave: (id: string | null, name: string) => Promise<void> }) {
  const current = views.find((v) => v.id === activeView);
  const [name, setName] = useState(current?.name ?? "");
  const [overwrite, setOverwrite] = useState(!!current);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="บันทึกมุมมอง" subtitle="จำแถว คอลัมน์ ค่า ตัวกรอง และ heatmap ไว้กดกลับมาดูได้" onClose={onClose} width={440}>
      <form style={{ display: "flex", flexDirection: "column", gap: 14 }} onSubmit={async (e) => {
        e.preventDefault();
        try { await onSave(overwrite && current ? current.id : null, name); onClose(); } catch (err) { setError(errMsg(err)); }
      }}>
        <div className="field">
          <label htmlFor="view-name">ชื่อมุมมอง</label>
          <input id="view-name" className="input" value={name} placeholder="เช่น รายงานประจำเดือน" onChange={(e) => setName(e.target.value)} />
        </div>
        {current && (
          <label className="check"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />บันทึกทับมุมมอง "{current.name}"</label>
        )}
        {error && <div className="err-box" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-lg" onClick={onClose}>{th.cancel}</button>
          <button type="submit" className="btn btn-lg btn-primary" disabled={!name.trim()}>{th.save}</button>
        </div>
      </form>
    </Modal>
  );
}
