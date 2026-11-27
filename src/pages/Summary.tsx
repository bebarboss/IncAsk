// สรุปผล / Pivot (SPEC §9, canvas 4 + 4.1): month range, saved views, drag-and-drop pivot fields,
// pivot + heatmap + charts, drill-down with editing (pivot and charts refresh in place), fullscreen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Maximize2, Minimize2, Plus, Trash2 } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { Charts as ChartData, PivotConfig, PivotResult, Project, SavedView, TicketRow, ViewConfig } from "../lib/types";
import { fmtInt, thMonth } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { ErrorState, Modal, SkeletonList } from "../components/ui";
import { NoData } from "../components/NoData";
import { Delta, PivotTable, type CellRef } from "../components/PivotTable";
import { SHOW_CHARTS, TopBars, TrendChart } from "../components/Charts";
import { TicketPanel } from "../components/TicketPanel";
import { normalizeView } from "../lib/pivotjs";
import { PivotConfigBar, placeField, type Zone } from "../components/PivotConfigBar";
import { categoryLabel, useTaxonomy } from "../components/CategoryPicker";
import { causeLabel } from "../lib/cause";
import { InsightsPanel } from "../components/InsightsPanel";

const DEFAULT_VIEW: ViewConfig = { rows: ["service"], col: "month", value: "count", filters: [], heat: true };

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
  const fields = useMemo(() => ["service", "month", "week", "day", ...catCols.map((c) => `cat:${c}`), "cause", "source", ...srcCols.map((c) => `src:${c}`)], [catCols, srcCols]);

  // first load: months, views (the first one applied), heatmap preference
  useEffect(() => {
    api.projectMonths(project.id).then((m) => { setMonths(m); setFrom(m[0] ?? ""); setTo(m[m.length - 1] ?? ""); }).catch((e) => setError(errMsg(e)));
    api.sourceColumns(project.id).then(setSrcCols).catch(() => {});
    api.savedViews(project.id).then((v) => {
      setViews(v);
      if (v[0]) { setActiveView(v[0].id); setView(normalizeView(v[0].config, DEFAULT_VIEW)); }
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
  const applyView = (v: SavedView) => { setActiveView(v.id); setView(normalizeView(v.config, DEFAULT_VIEW)); setCell(null); };
  const place = (field: string, zone: Zone) => { if (view) setV(placeField(view, field, zone)); };

  const save = async (ticket: TicketRow, f: Record<string, string>) => {
    await api.setCategory(project.id, [ticket.id], f);
    // pivot + charts + this list update in place — the ticket may move to another cell
    await Promise.all([load(), cell ? loadDrill(cell) : Promise.resolve()]);
    app.toast(`✓ ${ticket.ticketNo} → ${categoryLabel(tax?.[ticket.service]?.service.columns, f)}`);
  };

  const saveCause = async (ticket: TicketRow, c: string) => {
    await api.setCause(project.id, [ticket.id], c);
    await Promise.all([load(), cell ? loadDrill(cell) : Promise.resolve()]);
    app.toast(`✓ ${ticket.ticketNo} → ต้นเหตุ ${causeLabel(c)}`);
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
          {SHOW_CHARTS && (
            <div className="two-col" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
              <TopBars charts={charts} />
              <TrendChart charts={charts} />
            </div>
          )}
          <section className="card" aria-label="ตาราง pivot" style={{ overflow: "hidden", flex: "none" }}>
            <div className="muted" style={{ padding: "10px 16px", fontSize: 12, borderBottom: "1px solid var(--border)" }}>
              คลิกตัวเลขเพื่อดูทิกเก็ตในช่องนั้น{view.filters.some((f) => f.values.length) ? " · มีตัวกรอง" : ""}
            </div>
            <div className="table-wrap">
              <PivotTable result={pivot} rows={view.rows} col={view.col} value={view.value} heatOn={view.heat} colors={colors} onCell={setCell} selected={cell} large={fs} />
            </div>
          </section>
          {!fs && <InsightsPanel projectId={project.id} from={from} to={to} />}
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
        {cell && <TicketPanel cell={cell} data={drill} taxonomy={tax} onClose={() => setCell(null)} onSave={save} onSaveCause={saveCause} />}
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

        <PivotConfigBar view={view} fields={fields} loadValues={(f) => api.pivotValues(project.id, f, from, to)} onPlace={place} onChange={setV} />
        {body}
      </div>
      {cell && <TicketPanel cell={cell} data={drill} taxonomy={tax} onClose={() => setCell(null)} onSave={save} onSaveCause={saveCause}
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
