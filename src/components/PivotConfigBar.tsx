// Pivot field chips (SPEC §9): drag into แถว / คอลัมน์ / ตัวกรอง, or click a chip for the same
// choices (keyboard). Shared by the app and the offline HTML report.
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { ViewConfig } from "../lib/types";
import { SkeletonList, usePopover } from "./ui";
import { fieldLabel, valueLabel } from "./PivotTable";

export type Zone = "rows" | "col" | "filters";

/** move a field into a zone (taking it out of any other) */
export function placeField(view: ViewConfig, field: string, zone: Zone): Partial<ViewConfig> {
  const rows = view.rows.filter((f) => f !== field);
  const col = view.col === field ? "" : view.col;
  const filters = view.filters.filter((f) => f.field !== field);
  if (zone === "rows") return { rows: [...rows, field].slice(-3), col, filters };
  if (zone === "col") return { rows: rows.length ? rows : view.rows, col: field, filters };
  return { filters: [...filters, { field, values: [] }] };
}

/** Field chips: drag into แถว / คอลัมน์ / ตัวกรอง, or click a chip for the same choices (keyboard). */
export function PivotConfigBar({ view, fields, loadValues, onPlace, onChange }: {
  view: ViewConfig; fields: string[]; loadValues: (field: string) => Promise<string[]>;
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
            <FilterChip key={f.field} field={f.field} values={f.values} loadValues={loadValues}
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

function FilterChip({ field, values, loadValues, onChange, onRemove }: {
  field: string; values: string[]; loadValues: (field: string) => Promise<string[]>; onChange: (v: string[]) => void; onRemove: () => void;
}) {
  const pop = usePopover();
  const [all, setAll] = useState<string[] | null>(null);
  useEffect(() => { if (pop.open && !all) loadValues(field).then(setAll).catch(() => setAll([])); }, [pop.open, all, field, loadValues]);
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

