// ผลลัพธ์ (SPEC §8, canvas 3): TanStack Table for column state (order, visibility, size, pinning)
// + TanStack Virtual for rows. Rows are fetched from Rust in pages of 200 as they scroll into view,
// so 50,000 tickets stay smooth; sorting and filtering happen in SQLite.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCoreRowModel, useReactTable, type ColumnDef, type ColumnOrderState, type ColumnPinningState, type ColumnSizingState, type VisibilityState } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Columns3, Download, Pin, RefreshCw, Search, X } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { Project, ResultsQuery, TicketRow } from "../lib/types";
import { fmtInt, thDate, thMonth } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { ErrorState, Modal, usePopover } from "../components/ui";
import { NoData } from "../components/NoData";
import { CategoryPicker, categoryLabel, useTaxonomy } from "../components/CategoryPicker";

const PAGE = 200;
const PREF = "results_columns";

interface Prefs {
  order: ColumnOrderState;
  visibility: VisibilityState;
  sizing: ColumnSizingState;
  pinning: ColumnPinningState;
  srcCols: string[];
  dense: boolean;
}
const DEFAULT_PREFS: Prefs = { order: [], visibility: {}, sizing: {}, pinning: { left: ["select", "ticketNo"] }, srcCols: [], dense: false };

const BASE_LABEL: Record<string, string> = { ticketNo: "เลขทิกเก็ต", date: "วันที่", service: "เซอร์วิส", problem: "ข้อความปัญหา", confidence: "ความมั่นใจ", source: "ที่มา" };
const BASE_SIZE: Record<string, number> = { select: 40, ticketNo: 132, date: 104, service: 110, problem: 340, confidence: 108, source: 108 };

function colLabel(key: string): string {
  if (key.startsWith("cat:") || key.startsWith("src:")) return key.slice(4);
  return BASE_LABEL[key] ?? key;
}

export default function ResultsPageView({ project }: { project: Project }) {
  const app = useApp();
  const tax = useTaxonomy(project.id);
  const [months, setMonths] = useState<string[] | null>(null);
  const [srcAvailable, setSrcAvailable] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [service, setService] = useState("");
  const [month, setMonth] = useState("");
  const [category, setCategory] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [errorOnly, setErrorOnly] = useState(false);
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [selected, setSelected] = useState<Map<string, string>>(new Map()); // id → service
  const [editing, setEditing] = useState<{ ids: string[]; service: string; current: Record<string, string> | null } | null>(null);
  const [reclass, setReclass] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [thr, setThr] = useState(0.7);
  useEffect(() => { api.getPref(project.id, "low_threshold").then((v) => v != null && setThr(Number(v))).catch(() => {}); }, [project.id]);

  // ---- column prefs, remembered per project
  useEffect(() => {
    api.projectMonths(project.id).then(setMonths).catch(() => setMonths([]));
    api.sourceColumns(project.id).then(setSrcAvailable).catch(() => {});
    api.getPref(project.id, PREF).then((v) => setPrefs({ ...DEFAULT_PREFS, ...(v ? JSON.parse(v) : {}) })).catch(() => setPrefs(DEFAULT_PREFS));
  }, [project.id]);
  useEffect(() => {
    if (!prefs) return;
    const t = setTimeout(() => api.setPref(project.id, PREF, JSON.stringify(prefs)).catch(() => {}), 500);
    return () => clearTimeout(t);
  }, [prefs, project.id]);
  const patch = (p: Partial<Prefs>) => setPrefs((cur) => ({ ...(cur ?? DEFAULT_PREFS), ...p }));

  // Ctrl+F → search box
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // category columns merged from every service (empty where a service doesn't use one)
  const catCols = useMemo(() => [...new Set(Object.values(tax ?? {}).flatMap((t) => t.service.columns))], [tax]);
  const topValues = useMemo(() => {
    const vals = new Set<string>();
    Object.values(tax ?? {}).forEach((t) => t.rows.forEach((r) => { const v = r.values[t.service.columns[0]]; if (v) vals.add(v); }));
    return [...vals].sort((a, b) => a.localeCompare(b, "th"));
  }, [tax]);
  const keys = useMemo(() => ["select", "ticketNo", "date", "service", "problem", ...catCols.map((c) => `cat:${c}`), "confidence", "source", ...(prefs?.srcCols ?? []).map((c) => `src:${c}`)], [catCols, prefs?.srcCols]);
  const columns = useMemo<ColumnDef<TicketRow>[]>(() => keys.map((k) => ({ id: k, header: colLabel(k), size: BASE_SIZE[k] ?? (k.startsWith("cat:") ? 170 : 150), minSize: k === "select" ? 40 : 70, enableResizing: k !== "select" })), [keys]);

  const table = useReactTable<TicketRow>({
    data: [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange",
    state: {
      columnOrder: prefs?.order.length ? [...prefs.order.filter((k) => keys.includes(k)), ...keys.filter((k) => !prefs.order.includes(k))] : keys,
      columnVisibility: prefs?.visibility ?? {},
      columnSizing: prefs?.sizing ?? {},
      columnPinning: prefs?.pinning ?? DEFAULT_PREFS.pinning,
    },
    onColumnOrderChange: (u) => patch({ order: typeof u === "function" ? u(prefs?.order ?? keys) : u }),
    onColumnVisibilityChange: (u) => patch({ visibility: typeof u === "function" ? u(prefs?.visibility ?? {}) : u }),
    onColumnSizingChange: (u) => patch({ sizing: typeof u === "function" ? u(prefs?.sizing ?? {}) : u }),
    onColumnPinningChange: (u) => patch({ pinning: typeof u === "function" ? u(prefs?.pinning ?? DEFAULT_PREFS.pinning) : u }),
  });

  // ---- data: pages cached per query
  const query = useMemo<Omit<ResultsQuery, "offset" | "limit">>(() => ({
    search, service: service || undefined, month: month || undefined, category: category || undefined, lowOnly, errorOnly,
    filters: Object.entries(colFilters).filter(([, v]) => v.trim()).map(([key, value]) => ({ key, value })),
    sort: sort?.key ?? null, desc: sort?.desc ?? true,
  }), [search, service, month, category, lowOnly, errorOnly, colFilters, sort]);
  const [debounced, setDebounced] = useState(query);
  useEffect(() => { const t = setTimeout(() => setDebounced(query), 220); return () => clearTimeout(t); }, [query]);
  const pages = useRef(new Map<number, TicketRow[]>());
  const inflight = useRef(new Set<number>());
  const gen = useRef(0);
  const [total, setTotal] = useState<number | null>(null);
  const [lowCount, setLowCount] = useState(0);
  const [, bump] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async (page: number, g: number) => {
    if (pages.current.has(page) || inflight.current.has(page)) return;
    inflight.current.add(page);
    try {
      const r = await api.queryResults(project.id, { ...debounced, offset: page * PAGE, limit: PAGE });
      if (g !== gen.current) return;
      pages.current.set(page, r.rows);
      setTotal(r.total);
      setLowCount(r.lowCount);
      setError(null);
      bump((n) => n + 1);
    } catch (e) {
      if (g === gen.current) setError(errMsg(e));
    } finally {
      inflight.current.delete(page);
    }
  }, [project.id, debounced]);

  const reload = useCallback(() => {
    gen.current++;
    pages.current = new Map();
    inflight.current = new Set();
    fetchPage(0, gen.current);
  }, [fetchPage]);
  useEffect(() => { if (months?.length) reload(); }, [reload, months]);
  // a finished job changes rows → refresh
  const job = app.jobs[project.id];
  useEffect(() => { if (job?.status === "done") reload(); }, [job?.status, reload]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowH = prefs?.dense ? 32 : 42;
  const virt = useVirtualizer({ count: total ?? 0, getScrollElement: () => scrollRef.current, estimateSize: () => rowH, overscan: 12 });
  const items = virt.getVirtualItems();
  useEffect(() => {
    if (!items.length) return;
    const first = Math.floor(items[0].index / PAGE), last = Math.floor(items[items.length - 1].index / PAGE);
    for (let p = first; p <= last; p++) fetchPage(p, gen.current);
  }, [items, fetchPage]);
  useEffect(() => { virt.measure(); }, [rowH]); // eslint-disable-line react-hooks/exhaustive-deps
  const rowAt = (i: number) => pages.current.get(Math.floor(i / PAGE))?.[i % PAGE];

  const updateLocal = (ids: string[], fields: Record<string, string>) => {
    for (const rows of pages.current.values()) {
      rows.forEach((r) => { if (ids.includes(r.id)) { r.fields = { ...fields }; r.source = "human"; r.editedBy = app.settings.userName; } });
    }
    bump((n) => n + 1);
  };

  if (months && months.length === 0) {
    return <div className="page"><h1 className="page-title">ผลลัพธ์</h1><NoData title="ยังไม่มีผลลัพธ์" /></div>;
  }

  const leftHeaders = table.getLeftLeafHeaders();
  const centerHeaders = table.getCenterLeafHeaders();
  const headers = [...leftHeaders, ...centerHeaders];
  const width = headers.reduce((a, h) => a + h.getSize(), 0);
  const selService = selected.size ? [...new Set(selected.values())] : [];
  const pad = prefs?.dense ? "4px 10px" : "9px 12px";

  const toggle = (r: TicketRow) => setSelected((cur) => { const n = new Map(cur); if (n.has(r.id)) n.delete(r.id); else n.set(r.id, r.service); return n; });

  const cell = (key: string, r: TicketRow) => {
    const svc = tax?.[r.service];
    const low = r.confidence != null && !["human", "error", "unknown_service"].includes(r.source) && r.confidence < thr;
    switch (key) {
      case "select": return <input type="checkbox" aria-label={`เลือก ${r.ticketNo}`} checked={selected.has(r.id)} onChange={() => toggle(r)} style={{ accentColor: "var(--accent)" }} />;
      case "ticketNo": return <span className="mono" style={{ fontSize: 12.5 }}>{r.ticketNo}</span>;
      case "date": return thDate(r.date);
      case "service": return <span className="tag">{r.service}</span>;
      case "problem": return <span title={r.problemText}>{r.problemText}</span>;
      case "confidence": return r.confidence == null ? <span className="muted">—</span> : low
        ? <span style={{ color: "var(--warn-text)", fontWeight: 600 }}>ต่ำ · {Math.round(r.confidence * 100)}%</span>
        : `${Math.round(r.confidence * 100)}%`;
      case "source": return <span className={`chip ${r.source === "human" ? "" : r.source === "error" || r.source === "unknown_service" ? "err" : "neutral"}`}>{th.source[r.source]}</span>;
    }
    if (key.startsWith("src:")) return <span title={r.sourceRow[key.slice(4)]}>{r.sourceRow[key.slice(4)]}</span>;
    const col = key.slice(4);
    if (!svc || !svc.service.columns.includes(col)) return <span className="muted">—</span>;
    return (
      <button className="cat-btn ellipsis" style={{ maxWidth: "100%" }} title={r.source === "human" && r.editedBy ? `แก้โดย ${r.editedBy}` : "คลิกเพื่อแก้หมวด"}
        onClick={() => setEditing({ ids: [r.id], service: r.service, current: r.fields })}>
        {r.fields[col] || <span className="muted">เลือกหมวด</span>}
      </button>
    );
  };

  const headerCell = (h: (typeof headers)[number]) => {
    const key = h.column.id;
    const pinned = h.column.getIsPinned();
    const sortable = key !== "select";
    const sorted = sort?.key === key ? (sort.desc ? "desc" : "asc") : null;
    return (
      <th key={h.id} scope="col" style={{ width: h.getSize(), position: "sticky", top: 0, left: pinned ? h.column.getStart("left") : undefined, zIndex: pinned ? 3 : 2, padding: 0 }}
        aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
        draggable={key !== "select"}
        onDragStart={(e) => e.dataTransfer.setData("text/col", key)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const from = e.dataTransfer.getData("text/col");
          if (!from || from === key) return;
          const order = table.getState().columnOrder.filter((k) => k !== from);
          order.splice(order.indexOf(key), 0, from);
          table.setColumnOrder(order);
        }}>
        <div style={{ display: "flex", alignItems: "center", padding: "8px 10px", gap: 4 }}>
          {key === "select" ? (
            <input type="checkbox" aria-label="เลือกทุกแถวที่โหลดแล้ว" style={{ accentColor: "var(--accent)" }}
              checked={selected.size > 0 && [...pages.current.values()].flat().every((r) => selected.has(r.id))}
              onChange={(e) => setSelected(e.target.checked ? new Map([...pages.current.values()].flat().map((r) => [r.id, r.service])) : new Map())} />
          ) : (
            <button className="link-btn ellipsis" style={{ color: "var(--text-2)", fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4 }}
              disabled={!sortable} onClick={() => setSort(sorted === null ? { key, desc: false } : sorted === "asc" ? { key, desc: true } : null)}>
              {colLabel(key)}
              {sorted === "asc" && <ArrowUp size={12} strokeWidth={2.4} aria-hidden="true" />}
              {sorted === "desc" && <ArrowDown size={12} strokeWidth={2.4} aria-hidden="true" />}
            </button>
          )}
        </div>
        {key !== "select" && (
          <div style={{ padding: "0 6px 6px" }}>
            <input className="input" aria-label={`กรอง ${colLabel(key)}`} placeholder="กรอง…" style={{ minHeight: 26, padding: "2px 6px", fontSize: 12, borderRadius: 6 }}
              value={colFilters[key] ?? ""} onChange={(e) => setColFilters({ ...colFilters, [key]: e.target.value })} />
          </div>
        )}
        {h.column.getCanResize() && (
          <div role="separator" aria-label={`ปรับความกว้าง ${colLabel(key)}`} onMouseDown={h.getResizeHandler()} onDoubleClick={() => h.column.resetSize()}
            style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize", background: h.column.getIsResizing() ? "var(--accent)" : "transparent" }} />
        )}
      </th>
    );
  };

  const vItems = items;
  const padTop = vItems.length ? vItems[0].start : 0;
  const padBottom = vItems.length ? virt.getTotalSize() - vItems[vItems.length - 1].end : 0;

  return (
    <div className="page" style={{ gap: 14 }}>
      <header className="page-head">
        <div className="l">
          <h1 className="page-title">ผลลัพธ์</h1>
          <p className="muted">
            {total != null ? `${month ? thMonth(month) : "ทุกเดือน"} · ${fmtInt(total)} ทิกเก็ต · ${fmtInt(lowCount)} รายการที่ AI ไม่มั่นใจ` : "กำลังโหลด…"}
          </p>
        </div>
        <div className="toolbar">
          <button className="btn" onClick={() => setReclass(true)}><RefreshCw size={15} strokeWidth={2} aria-hidden="true" />จัดใหม่…</button>
          <button className="btn btn-primary" onClick={() => app.setExportOpen(true)}><Download size={16} strokeWidth={2} aria-hidden="true" />{th.export}</button>
        </div>
      </header>

      <div className="toolbar" role="toolbar" aria-label="ตัวกรองตาราง">
        <label style={{ position: "relative", flex: "1 1 240px", maxWidth: 340 }}>
          <span className="sr-only">ค้นหา</span>
          <Search size={16} strokeWidth={1.8} aria-hidden="true" style={{ position: "absolute", left: 10, top: 11, color: "var(--muted)" }} />
          <input ref={searchRef} className="input" type="search" style={{ paddingLeft: 34, minHeight: 38 }} placeholder="ค้นหาเลขทิกเก็ตหรือข้อความ (Ctrl+F)" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <select className="select sm" aria-label="เซอร์วิส" value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">ทุกเซอร์วิส</option>
          {Object.keys(tax ?? {}).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="select sm" aria-label="หมวด" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">ทุกหมวด</option>
          {topValues.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="select sm" aria-label="เดือน" value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">ทุกเดือน</option>
          {(months ?? []).map((m) => <option key={m} value={m}>{thMonth(m)}</option>)}
        </select>
        <button className="btn" aria-pressed={lowOnly} onClick={() => setLowOnly(!lowOnly)}><span className="dot" style={{ background: "var(--role-service)" }} aria-hidden="true" />เฉพาะที่ไม่มั่นใจ</button>
        <button className="btn" aria-pressed={errorOnly} onClick={() => setErrorOnly(!errorOnly)}><span className="dot" style={{ background: "var(--err-text)" }} aria-hidden="true" />เฉพาะที่ผิดพลาด</button>
        <span className="spacer" />
        <button className="btn" aria-pressed={!!prefs?.dense} onClick={() => patch({ dense: !prefs?.dense })}>{prefs?.dense ? "แบบแน่น" : "แบบปกติ"}</button>
        <ColumnsMenu table={table} srcAvailable={srcAvailable} srcCols={prefs?.srcCols ?? []} onSrcCols={(srcCols) => patch({ srcCols })} onReset={() => setPrefs({ ...DEFAULT_PREFS, dense: !!prefs?.dense })} />
      </div>

      {selected.size > 0 && (
        <div className="banner info" role="status" style={{ borderRadius: 10, border: "1px solid var(--ring)" }}>
          <span>เลือก {fmtInt(selected.size)} แถว{selService.length > 1 ? " · หลายเซอร์วิส ตั้งหมวดพร้อมกันไม่ได้" : ""}</span>
          <button className="btn btn-primary" disabled={selService.length !== 1 || !tax?.[selService[0]]}
            onClick={() => setEditing({ ids: [...selected.keys()], service: selService[0], current: null })}>ตั้งหมวดเป็น…</button>
          <button className="btn" onClick={() => setReclass(true)}>จัดใหม่</button>
          <button className="icon-btn" aria-label="ล้างการเลือก" onClick={() => setSelected(new Map())}><X size={16} strokeWidth={1.8} /></button>
        </div>
      )}

      {error && <ErrorState message={error} onRetry={reload} />}
      <section className="card" aria-label="ตารางผลลัพธ์" style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div ref={scrollRef} className="table-wrap" style={{ height: "calc(100vh - 290px)", minHeight: 280 }}>
          <table className="tbl" style={{ tableLayout: "fixed", width }}>
            <colgroup>{headers.map((h) => <col key={h.id} style={{ width: h.getSize() }} />)}</colgroup>
            <thead><tr>{headers.map(headerCell)}</tr></thead>
            <tbody>
              {padTop > 0 && <tr aria-hidden="true"><td colSpan={headers.length} style={{ height: padTop, padding: 0, border: 0 }} /></tr>}
              {vItems.map((v) => {
                const r = rowAt(v.index);
                if (!r) return <tr key={v.key} style={{ height: rowH }}><td colSpan={headers.length} style={{ padding: pad }}><div className="skeleton" style={{ height: 12, width: "60%" }} /></td></tr>;
                const low = r.confidence != null && !["human", "error", "unknown_service"].includes(r.source) && r.confidence < thr;
                return (
                  <tr key={r.id} style={{ height: rowH }} className={r.source === "error" ? "row-err" : low ? "row-low" : undefined} aria-selected={selected.has(r.id)}>
                    {headers.map((h) => {
                      const pinned = h.column.getIsPinned();
                      return (
                        <td key={h.id} className={pinned ? "pin" : undefined} style={{ padding: h.column.id === "select" ? "0 0 0 12px" : pad, left: pinned ? h.column.getStart("left") : undefined, whiteSpace: "nowrap", overflow: "hidden", verticalAlign: "middle", textOverflow: h.column.id === "select" ? "clip" : "ellipsis" }}>
                          {cell(h.column.id, r)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {padBottom > 0 && <tr aria-hidden="true"><td colSpan={headers.length} style={{ height: padBottom, padding: 0, border: 0 }} /></tr>}
              {total === 0 && <tr><td colSpan={headers.length} className="muted" style={{ padding: 24, textAlign: "center" }}>ไม่พบทิกเก็ตตามตัวกรองนี้</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {editing && tax?.[editing.service] && (
        <CategoryPicker projectId={project.id} service={editing.service} columns={tax[editing.service].service.columns} rows={tax[editing.service].rows}
          current={editing.current} count={editing.ids} onClose={() => setEditing(null)}
          onSaved={(f) => { updateLocal(editing.ids, f); setSelected(new Map()); app.toast(`✓ บันทึกหมวด ${categoryLabel(tax[editing.service].service.columns, f)}`); }} />
      )}
      {reclass && (
        <ReclassifyDialog projectId={project.id} selected={[...selected.keys()]} lowCount={lowCount} onClose={() => setReclass(false)}
          onStarted={() => { setReclass(false); setSelected(new Map()); app.go({ name: "project", tab: "classify" }); }} />
      )}
    </div>
  );
}

function ColumnsMenu({ table, srcAvailable, srcCols, onSrcCols, onReset }: {
  table: ReturnType<typeof useReactTable<TicketRow>>; srcAvailable: string[]; srcCols: string[]; onSrcCols: (c: string[]) => void; onReset: () => void;
}) {
  const pop = usePopover();
  return (
    <div ref={pop.ref} style={{ position: "relative" }}>
      <button className="btn" aria-haspopup="dialog" aria-expanded={pop.open} onClick={() => pop.setOpen(!pop.open)}><Columns3 size={15} strokeWidth={2} aria-hidden="true" />คอลัมน์</button>
      {pop.open && (
        <div className="popover" role="dialog" aria-label="ตั้งค่าคอลัมน์" style={{ right: 0, top: 42, width: 300, maxHeight: 460, overflowY: "auto" }}>
          <div className="muted" style={{ fontSize: 11, fontWeight: 600, padding: "6px 10px 2px" }}>แสดง · ตรึงซ้าย (ลากหัวคอลัมน์เพื่อเรียง)</div>
          {table.getAllLeafColumns().filter((c) => c.id !== "select").map((c) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "0 6px" }}>
              <label className="check" style={{ flex: 1, minHeight: 32 }}>
                <input type="checkbox" checked={c.getIsVisible()} onChange={c.getToggleVisibilityHandler()} />{colLabel(c.id)}
              </label>
              <button className="icon-btn" style={{ width: 28, height: 28, color: c.getIsPinned() ? "var(--accent)" : undefined }} aria-pressed={!!c.getIsPinned()}
                aria-label={`ตรึง ${colLabel(c.id)}`} onClick={() => c.pin(c.getIsPinned() ? false : "left")}><Pin size={14} strokeWidth={1.8} /></button>
            </div>
          ))}
          {srcAvailable.length > 0 && (
            <>
              <div className="menu-sep" />
              <div className="muted" style={{ fontSize: 11, fontWeight: 600, padding: "6px 10px 2px" }}>เพิ่มคอลัมน์จากไฟล์ต้นทาง</div>
              {srcAvailable.map((s) => (
                <label key={s} className="check" style={{ padding: "0 10px", minHeight: 30 }}>
                  <input type="checkbox" checked={srcCols.includes(s)} onChange={(e) => onSrcCols(e.target.checked ? [...srcCols, s] : srcCols.filter((x) => x !== s))} />{s}
                </label>
              ))}
            </>
          )}
          <div className="menu-sep" />
          <button className="menu-item" onClick={onReset}>คืนค่าเริ่มต้น</button>
        </div>
      )}
    </div>
  );
}

function ReclassifyDialog({ projectId, selected, lowCount, onClose, onStarted }: { projectId: string; selected: string[]; lowCount: number; onClose: () => void; onStarted: () => void }) {
  const [mode, setMode] = useState<"selected" | "low">(selected.length ? "selected" : "low");
  const [human, setHuman] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    try {
      await api.reclassify(projectId, mode === "selected" ? selected : null, mode === "low", human);
      onStarted();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  return (
    <Modal title="จัดหมวดใหม่" subtitle="ล้างผลเดิมของแถวที่เลือกแล้วส่งให้ AI จัดอีกครั้ง" onClose={onClose} width={480}>
      <div role="radiogroup" aria-label="แถวที่จะจัดใหม่" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label className="check"><input type="radio" name="rc" checked={mode === "selected"} disabled={!selected.length} onChange={() => setMode("selected")} />แถวที่เลือก ({fmtInt(selected.length)})</label>
        <label className="check"><input type="radio" name="rc" checked={mode === "low"} onChange={() => setMode("low")} />ทั้งหมดที่ไม่มั่นใจและผิดพลาด ({fmtInt(lowCount)}+)</label>
      </div>
      <label className="check"><input type="checkbox" checked={human} onChange={(e) => setHuman(e.target.checked)} />รวมแถวที่คนแก้แล้วด้วย (ผลที่คนแก้จะหาย)</label>
      {error && <div className="err-box" role="alert">{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-lg" onClick={onClose}>{th.cancel}</button>
        <button className="btn btn-lg btn-primary" onClick={go}>เริ่มจัดใหม่</button>
      </div>
    </Modal>
  );
}
