// Pivot table (SPEC §9) — data-only, shared by the app and the offline HTML report.
// Collapsible groups with subtotals, grand total row/column, month-over-month change (arrow +
// colour, never colour alone), 5-level heatmap on the innermost cells, clickable numbers.
// With วัน or สัปดาห์ across, columns nest เดือน › สัปดาห์ › วัน: each group column shows its total
// and ▸ opens its parts next to it.
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PivotNode, PivotResult } from "../lib/types";
import { delta, fmtInt, thMonth } from "../lib/format";
import { weekKey } from "../lib/pivotjs";
import { CAUSE_LABEL } from "../lib/cause";

export const FIELD_LABEL: Record<string, string> = { service: "เซอร์วิส", month: "เดือน", week: "สัปดาห์", day: "วัน", source: "ที่มา", cause: "ต้นเหตุ" };
const SOURCE_LABEL: Record<string, string> = { ai: "AI", cache: "แคช", human: "แก้โดยคน", error: "ผิดพลาด", unknown_service: "ไม่มีหมวดหมู่", pending: "รอจัด" };

export function fieldLabel(f: string): string {
  return FIELD_LABEL[f] ?? f.slice(4);
}

const dayDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`);
const shortMonth = (ym: string) => thMonth(ym, true).split(" ")[0];

/** "1–4 ต.ค." for week key 2026-10-W1 */
export function weekRange(key: string): string {
  const ym = key.slice(0, 7);
  const n = Number(key.slice(9));
  const offset = (dayDate(`${ym}-01`).getDay() + 6) % 7;
  const last = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  const a = Math.max(1, (n - 1) * 7 - offset + 1);
  const b = Math.min(last, n * 7 - offset);
  return `${a === b ? a : `${a}–${b}`} ${shortMonth(ym)}`;
}

export function valueLabel(field: string, v: string, short = false): string {
  if (field === "month" && /^\d{4}-\d{2}$/.test(v)) return thMonth(v, short);
  if (field === "week" && /^\d{4}-\d{2}-W\d$/.test(v)) return short ? `ส.${v.slice(9)} · ${weekRange(v)}` : `สัปดาห์ ${v.slice(9)} · ${weekRange(v)} ${thMonth(v.slice(0, 7), true).split(" ")[1]}`;
  if (field === "day" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return dayDate(v).toLocaleDateString("th-TH", short ? { weekday: "short", day: "numeric", month: "short" } : { weekday: "short", day: "numeric", month: "short", year: "2-digit" });
  }
  if (field === "source") return SOURCE_LABEL[v] ?? v;
  if (field === "cause") return CAUSE_LABEL[v] ?? v;
  return v;
}

function heat(v: number, max: number): string {
  if (!v || !max) return "";
  const r = v / max;
  return r >= 0.75 ? "h4" : r >= 0.5 ? "h3" : r >= 0.25 ? "h2" : "h1";
}

export function Delta({ prev, cur }: { prev: number; cur: number }) {
  const d = delta(prev, cur);
  if (!d) return <span className="muted">—</span>;
  return d.up
    ? <span className="delta-up" aria-label={`เพิ่มขึ้น ${d.text}`}>▲ {d.text}</span>
    : <span className="delta-down" aria-label={`ลดลง ${d.text}`}>▼ {d.text}</span>;
}

export interface CellRef {
  path: [string, string][];
  col: [string, string] | null;
  label: string;
}

/** one visible column: a month/week group (sum of its parts) or a single key */
interface VCol {
  field: string;
  key: string;
  idx: number[];
  level: number;
  /** group id when it can open */
  toggle?: string;
}
type Depth = "month" | "week" | "day";

/** month › week › day columns for a วัน/สัปดาห์ column field; anything else stays flat */
function timeColumns(col: string, keys: string[], open: Set<string>): VCol[] | null {
  if (col !== "day" && col !== "week") return null;
  const months = new Map<string, Map<string, number[]>>();
  keys.forEach((k, i) => {
    const w = col === "day" ? weekKey(k) : k;
    const m = months.get(k.slice(0, 7)) ?? new Map<string, number[]>();
    months.set(k.slice(0, 7), m);
    m.set(w, [...(m.get(w) ?? []), i]);
  });
  const out: VCol[] = [];
  for (const [m, weeks] of months) {
    const mid = `m:${m}`;
    out.push({ field: "month", key: m, idx: [...weeks.values()].flat(), level: 0, toggle: mid });
    if (!open.has(mid)) continue;
    for (const [w, idx] of weeks) {
      if (col === "week") { out.push({ field: "week", key: w, idx, level: 1 }); continue; }
      const wid = `w:${w}`;
      out.push({ field: "week", key: w, idx, level: 1, toggle: wid });
      if (open.has(wid)) idx.forEach((i) => out.push({ field: "day", key: keys[i], idx: [i], level: 2 }));
    }
  }
  return out;
}

/** every group id up to a depth (เดือน = all closed) */
function openTo(col: string, keys: string[], depth: Depth): Set<string> {
  const s = new Set<string>();
  if (depth === "month") return s;
  for (const k of keys) {
    s.add(`m:${k.slice(0, 7)}`);
    if (depth === "day" && col === "day") s.add(`w:${weekKey(k)}`);
  }
  return s;
}

export function PivotTable({ result, rows, col, value, heatOn, colors, onCell, selected, large }: {
  result: PivotResult;
  rows: string[];
  col: string;
  value: "count" | "share";
  heatOn: boolean;
  /** service colours for the swatch next to service keys */
  colors?: Record<string, string>;
  onCell?: (c: CellRef) => void;
  selected?: CellRef | null;
  large?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const hasCol = !!col;
  const timeCols = useMemo(() => timeColumns(col, result.colKeys, open), [col, result.colKeys, open]);
  const vcols: VCol[] = timeCols ?? result.colKeys.map((k, i) => ({ field: col, key: k, idx: [i], level: 0 }));
  const sum = (vals: number[], idx: number[]) => idx.reduce((a, i) => a + (vals[i] ?? 0), 0);
  // change vs the previous month: plain month columns, or the month groups of a time hierarchy
  const monthCols = timeCols ? timeCols.filter((c) => c.level === 0) : col === "month" ? vcols : [];
  const mom = monthCols.length >= 2 ? [monthCols[monthCols.length - 2].idx, monthCols[monthCols.length - 1].idx] as const : null;
  const fmt = (v: number, c: VCol) => {
    if (value !== "share") return fmtInt(v);
    const g = sum(result.grand, c.idx);
    return `${g ? ((v / g) * 100).toFixed(1) : "0.0"}%`;
  };
  // heatmap scale = the innermost rows, per column level (months are not compared with days)
  const max: number[] = [0, 0, 0];
  const walk = (ns: PivotNode[], depth: number) => ns.forEach((x) => (depth === rows.length - 1
    ? vcols.forEach((c) => { const v = sum(x.values, c.idx); if (v > max[c.level]) max[c.level] = v; })
    : walk(x.children, depth + 1)));
  walk(result.rows, 0);
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const sameSel = (path: [string, string][], c: [string, string] | null) =>
    !!selected && JSON.stringify(selected.path) === JSON.stringify(path) && JSON.stringify(selected.col) === JSON.stringify(c);

  const out: JSX.Element[] = [];
  const render = (nodes: PivotNode[], depth: number, parent: [string, string][]) => {
    for (const node of nodes) {
      const path: [string, string][] = [...parent, [rows[depth], node.key]];
      const id = path.map((p) => p[1]).join("\u0000");
      const leaf = depth === rows.length - 1;
      const isOpen = !collapsed[id];
      const label = valueLabel(rows[depth], node.key);
      out.push(
        <tr key={id} className={leaf ? undefined : depth === 0 ? "group" : "subgroup"}>
          <th scope="row" style={{ paddingLeft: 12 + depth * 22 }}>
            {leaf ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {rows[depth] === "service" && colors?.[node.key] && <span className="swatch" style={{ background: colors[node.key] }} aria-hidden="true" />}
                {label}
              </span>
            ) : (
              <button className="collapse-btn" aria-expanded={isOpen} onClick={() => setCollapsed((c) => ({ ...c, [id]: !c[id] }))}>
                {isOpen ? <ChevronDown size={14} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />}
                {rows[depth] === "service" && colors?.[node.key] && <span className="swatch" style={{ background: colors[node.key] }} aria-hidden="true" />}
                {label}
              </button>
            )}
          </th>
          {vcols.map((vc) => {
            const v = sum(node.values, vc.idx);
            const c: [string, string] | null = hasCol ? [vc.field, vc.key] : null;
            const text = fmt(v, vc);
            return (
              <td key={`${vc.field}:${vc.key}`} className={`cell-btn${vc.toggle && timeCols ? ` colgrp l${vc.level}` : ""} ${leaf && heatOn ? heat(v, max[vc.level]) : ""}`}>
                {onCell && v > 0 ? (
                  <button className={`pv-btn${sameSel(path, c) ? " sel" : ""}`}
                    aria-label={`${path.map((p) => valueLabel(p[0], p[1])).join(" › ")}${c ? ` · ${valueLabel(c[0], c[1])}` : ""}: ${fmtInt(v)} ทิกเก็ต`}
                    onClick={() => onCell({ path, col: c, label: path.map((p) => valueLabel(p[0], p[1])).join(" › ") + (c ? ` · ${valueLabel(c[0], c[1])}` : "") })}>
                    {text}
                  </button>
                ) : <span style={{ padding: "0 10px" }}>{v ? text : <span className="muted">·</span>}</span>}
              </td>
            );
          })}
          {hasCol && <td>{onCell ? <button className={`pv-btn${sameSel(path, null) ? " sel" : ""}`} onClick={() => onCell({ path, col: null, label: path.map((p) => valueLabel(p[0], p[1])).join(" › ") })}>{fmtInt(node.total)}</button> : fmtInt(node.total)}</td>}
          {mom && <td><Delta prev={sum(node.values, mom[0])} cur={sum(node.values, mom[1])} /></td>}
        </tr>,
      );
      if (!leaf && isOpen) render(node.children, depth + 1, path);
    }
  };
  render(result.rows, 0, []);

  const depthNow: Depth | null = !timeCols ? null : timeCols.some((c) => c.level === 2) ? "day" : timeCols.some((c) => c.level === 1) ? "week" : "month";
  const levels: [Depth, string][] = col === "day" ? [["month", "เดือน"], ["week", "สัปดาห์"], ["day", "วัน"]] : [["month", "เดือน"], ["week", "สัปดาห์"]];
  return (
    <>
    {timeCols && (
      <div className="pv-levels" role="group" aria-label="ขยายคอลัมน์ถึงระดับ">
        <span className="muted">ขยายคอลัมน์ถึง</span>
        <div className="seg-tabs sm">
          {levels.map(([d, label]) => (
            <button key={d} aria-pressed={depthNow === d} onClick={() => setOpen(openTo(col, result.colKeys, d))}>{label}</button>
          ))}
        </div>
        <span className="muted">· กด ▸ ที่หัวคอลัมน์เพื่อย่อ/ขยายทีละช่อง</span>
      </div>
    )}
    <table className={`tbl pivot${large ? " large" : ""}`}>
      <thead>
        <tr>
          <th scope="col">{rows.map(fieldLabel).join(" › ")}</th>
          {vcols.map((vc) => {
            const label = hasCol ? valueLabel(vc.field, vc.key, true) : value === "share" ? "สัดส่วน" : "จำนวน";
            const isOpen = !!vc.toggle && open.has(vc.toggle);
            return (
              <th key={`${vc.field}:${vc.key}`} scope="col" className={timeCols ? `l${vc.level}${vc.toggle ? " colgrp" : ""}` : undefined}>
                {vc.toggle ? (
                  <button className="collapse-btn" aria-expanded={isOpen} onClick={() => toggle(vc.toggle!)}
                    aria-label={`${isOpen ? "ย่อ" : "ขยาย"} ${valueLabel(vc.field, vc.key)}`}>
                    {isOpen ? <ChevronDown size={13} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />}
                    {isOpen ? `รวม ${label}` : label}
                  </button>
                ) : label}
              </th>
            );
          })}
          {hasCol && <th scope="col">รวม</th>}
          {mom && <th scope="col">เทียบเดือนก่อน</th>}
        </tr>
      </thead>
      <tbody>
        {out}
        <tr className="grand">
          <th scope="row">รวมทั้งหมด</th>
          {vcols.map((vc) => <td key={`${vc.field}:${vc.key}`} className={vc.toggle && timeCols ? `colgrp l${vc.level}` : undefined}>{value === "share" ? "100%" : fmtInt(sum(result.grand, vc.idx))}</td>)}
          {hasCol && <td>{fmtInt(result.grandTotal)}</td>}
          {mom && <td><Delta prev={sum(result.grand, mom[0])} cur={sum(result.grand, mom[1])} /></td>}
        </tr>
      </tbody>
    </table>
    </>
  );
}
