// Offline HTML report (SPEC §10.3). Reads the data Rust embedded in #incask-data (base64 of
// deflate-raw JSON), then offers the same pivot (drag-and-drop, heatmap, month range), charts and
// ticket drill-down as the app — read-only, no network.
import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/ibm-plex-sans-thai-looped/thai-400.css";
import "@fontsource/ibm-plex-sans-thai-looped/latin-400.css";
import "@fontsource/ibm-plex-sans-thai-looped/thai-600.css";
import "@fontsource/ibm-plex-sans-thai-looped/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/theme.css";
import type { SavedView, TicketRow, ViewConfig } from "../src/lib/types";
import { chartsJs, drillJs, fieldValuesJs, normalizeView, pivotJs } from "../src/lib/pivotjs";
import { fmtInt, thMonth } from "../src/lib/format";
import { PivotTable, type CellRef } from "../src/components/PivotTable";
import { SHOW_CHARTS, TopBars, TrendChart } from "../src/components/Charts";
import { TicketPanel } from "../src/components/TicketPanel";
import { PivotConfigBar, placeField } from "../src/components/PivotConfigBar";

type Compact = [string, string, string, string, string, string[], number | null, TicketRow["source"], string[] | null, string | null, string[], (string | null)?];
interface Payload {
  v: number;
  project: [string, string];
  exportedAt: string;
  from: string;
  to: string;
  services: { name: string; color: string; columns: string[] }[];
  categories: string[];
  sourceHeaders: string[];
  views: SavedView[];
  tickets: Compact[];
}

async function readData(): Promise<Payload> {
  const b64 = document.getElementById("incask-data")?.textContent?.trim() ?? "";
  if (!b64) throw new Error("ไฟล์นี้ไม่มีข้อมูล — ส่งออกใหม่จากโปรแกรม IncAsk");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return JSON.parse(await new Response(stream).text());
}

function toRows(p: Payload): TicketRow[] {
  const zip = (keys: string[], vals: string[] | null) => (vals ? Object.fromEntries(keys.map((k, i) => [k, vals[i]]).filter(([, v]) => v)) : null);
  return p.tickets.map((t, i) => ({
    id: String(i),
    ticketNo: t[0], date: t[1], month: t[2], service: t[3], problemText: t[4],
    fields: zip(p.categories, t[5]) ?? {}, confidence: t[6], source: t[7], aiFields: zip(p.categories, t[8]),
    editedBy: t[9], reason: null, sourceRow: zip(p.sourceHeaders, t[10]) ?? {}, cause: t[11] ?? null,
  }));
}

const DEFAULT_VIEW: ViewConfig = { rows: ["service"], col: "month", value: "count", filters: [], heat: true };

function Report({ data }: { data: Payload }) {
  const rows = useMemo(() => toRows(data), [data]);
  const months = useMemo(() => [...new Set(rows.map((r) => r.month))].sort(), [rows]);
  const [from, setFrom] = useState(months[0] ?? data.from);
  const [to, setTo] = useState(months[months.length - 1] ?? data.to);
  const firstCat = data.services[0]?.columns[0];
  const [active, setActive] = useState<string | null>(data.views[0]?.id ?? null);
  const fallback: ViewConfig = { ...DEFAULT_VIEW, rows: firstCat ? ["service", `cat:${firstCat}`] : ["service"] };
  const [view, setView] = useState<ViewConfig>(normalizeView(data.views[0]?.config, fallback));
  const [cell, setCell] = useState<CellRef | null>(null);
  const cfg = { rows: view.rows, col: view.col, filters: view.filters, from, to };
  const pivot = useMemo(() => pivotJs(rows, cfg), [rows, view, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  const charts = useMemo(() => chartsJs(rows, cfg, data.services), [rows, view.filters, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  const drill = useMemo(() => {
    if (!cell) return null;
    const all = drillJs(rows, cfg, cell.path, cell.col).sort((a, b) => b.date.localeCompare(a.date));
    return { total: all.length, rows: all.slice(0, 100) };
  }, [cell, rows, view, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  const colors = Object.fromEntries(data.services.map((s) => [s.name, s.color]));
  const fields = ["service", "month", "week", "day", ...data.categories.map((c) => `cat:${c}`), "cause", "source", ...data.sourceHeaders.map((h) => `src:${h}`)];
  const taxonomy = Object.fromEntries(data.services.map((s) => [s.name, { service: { id: s.name, name: s.name, color: s.color, columns: s.columns, taxonomyVersion: 1, sort: 0 }, rows: [] }]));
  const setV = (p: Partial<ViewConfig>) => { setView((v) => ({ ...v, ...p })); setCell(null); };

  return (
    <div style={{ display: "flex", height: "100%" }}>
      <div className="page" style={{ flex: 1, overflowY: "auto" }}>
        <header className="page-head" style={{ alignItems: "center" }}>
          <div className="l">
            <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="swatch" style={{ background: data.project[1], width: 14, height: 14 }} aria-hidden="true" />{data.project[0]}
            </h1>
            <p className="muted">รายงาน IncAsk · {fmtInt(rows.length)} ทิกเก็ต · ส่งออกเมื่อ {new Date(data.exportedAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}</p>
          </div>
          <div className="toolbar">
            <select className="select sm" aria-label="ตั้งแต่เดือน" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); setCell(null); }}>
              {months.map((m) => <option key={m} value={m}>{thMonth(m)}</option>)}
            </select>
            <span className="muted" style={{ fontSize: 13 }}>ถึง</span>
            <select className="select sm" aria-label="ถึงเดือน" value={to} onChange={(e) => { setTo(e.target.value); if (e.target.value < from) setFrom(e.target.value); setCell(null); }}>
              {months.map((m) => <option key={m} value={m}>{thMonth(m)}</option>)}
            </select>
          </div>
        </header>
        {data.views.length > 0 && (
          <div className="toolbar">
            <span className="muted" style={{ fontSize: 13, fontWeight: 600 }}>มุมมองที่บันทึก</span>
            <div className="seg-tabs" role="tablist" aria-label="มุมมองที่บันทึก">
              {data.views.map((v) => <button key={v.id} role="tab" aria-selected={active === v.id} onClick={() => { setActive(v.id); setView(normalizeView(v.config, fallback)); setCell(null); }}>{v.name}</button>)}
            </div>
          </div>
        )}
        <PivotConfigBar view={view} fields={fields} loadValues={async (f) => fieldValuesJs(rows, f, from, to)} onPlace={(f, z) => setV(placeField(view, f, z))} onChange={setV} />
        {SHOW_CHARTS && (
          <div className="two-col" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
            <TopBars charts={charts} />
            <TrendChart charts={charts} />
          </div>
        )}
        <section className="card" aria-label="ตาราง pivot" style={{ overflow: "hidden", flex: "none" }}>
          <div className="muted" style={{ padding: "10px 16px", fontSize: 12, borderBottom: "1px solid var(--border)" }}>คลิกตัวเลขเพื่อดูทิกเก็ตในช่องนั้น · รายงานนี้ดูได้อย่างเดียว แก้หมวดได้ในโปรแกรม IncAsk</div>
          <div className="table-wrap">
            <PivotTable result={pivot} rows={view.rows} col={view.col} value={view.value} heatOn={view.heat} colors={colors} onCell={setCell} selected={cell} />
          </div>
        </section>
      </div>
      {cell && <TicketPanel cell={cell} data={drill} taxonomy={taxonomy} onClose={() => setCell(null)} />}
    </div>
  );
}

function App() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { readData().then(setData).catch((e) => setError(String(e?.message ?? e))); }, []);
  if (error) return <div className="page"><div className="err-box" role="alert">{error}</div></div>;
  if (!data) return <div className="page"><p className="muted">กำลังเปิดรายงาน…</p></div>;
  return <Report data={data} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<React.StrictMode><App /></React.StrictMode>);
