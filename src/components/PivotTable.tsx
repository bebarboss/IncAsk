// Pivot table (SPEC §9) — data-only, shared by the app and the offline HTML report.
// Collapsible groups with subtotals, grand total row/column, month-over-month change (arrow +
// colour, never colour alone), 5-level heatmap on the innermost cells, clickable numbers.
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PivotNode, PivotResult } from "../lib/types";
import { delta, fmtInt, thMonth } from "../lib/format";

export const FIELD_LABEL: Record<string, string> = { service: "เซอร์วิส", month: "เดือน", source: "ที่มา" };
const SOURCE_LABEL: Record<string, string> = { ai: "AI", cache: "แคช", human: "แก้โดยคน", error: "ผิดพลาด", unknown_service: "ไม่มีหมวดหมู่", pending: "รอจัด" };

export function fieldLabel(f: string): string {
  return FIELD_LABEL[f] ?? f.slice(4);
}

export function valueLabel(field: string, v: string, short = false): string {
  if (field === "month" && /^\d{4}-\d{2}$/.test(v)) return thMonth(v, short);
  if (field === "source") return SOURCE_LABEL[v] ?? v;
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
  const n = result.colKeys.length;
  const hasCol = !!col;
  const mom = col === "month" && n >= 2;
  const fmt = (v: number, ci: number) => (value === "share" ? `${result.grand[ci] ? ((v / result.grand[ci]) * 100).toFixed(1) : "0.0"}%` : fmtInt(v));
  // heatmap scale = the innermost cells
  let max = 0;
  const walk = (ns: PivotNode[], depth: number) => ns.forEach((x) => (depth === rows.length - 1 ? x.values.forEach((v) => { if (v > max) max = v; }) : walk(x.children, depth + 1)));
  walk(result.rows, 0);
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
          {node.values.map((v, ci) => {
            const c: [string, string] | null = hasCol ? [col, result.colKeys[ci]] : null;
            const text = fmt(v, ci);
            return (
              <td key={ci} className={`cell-btn ${leaf && heatOn ? heat(v, max) : ""}`}>
                {onCell && v > 0 ? (
                  <button className={`pv-btn${sameSel(path, c) ? " sel" : ""}`}
                    aria-label={`${path.map((p) => valueLabel(p[0], p[1])).join(" › ")}${c ? ` · ${valueLabel(col, c[1])}` : ""}: ${fmtInt(v)} ทิกเก็ต`}
                    onClick={() => onCell({ path, col: c, label: path.map((p) => valueLabel(p[0], p[1])).join(" › ") + (c ? ` · ${valueLabel(col, c[1])}` : "") })}>
                    {text}
                  </button>
                ) : <span style={{ padding: "0 10px" }}>{v ? text : <span className="muted">·</span>}</span>}
              </td>
            );
          })}
          {hasCol && <td>{onCell ? <button className={`pv-btn${sameSel(path, null) ? " sel" : ""}`} onClick={() => onCell({ path, col: null, label: path.map((p) => valueLabel(p[0], p[1])).join(" › ") })}>{fmtInt(node.total)}</button> : fmtInt(node.total)}</td>}
          {mom && <td><Delta prev={node.values[n - 2]} cur={node.values[n - 1]} /></td>}
        </tr>,
      );
      if (!leaf && isOpen) render(node.children, depth + 1, path);
    }
  };
  render(result.rows, 0, []);

  return (
    <table className={`tbl pivot${large ? " large" : ""}`}>
      <thead>
        <tr>
          <th scope="col">{rows.map(fieldLabel).join(" › ")}</th>
          {result.colKeys.map((k) => <th key={k} scope="col">{hasCol ? valueLabel(col, k, true) : value === "share" ? "สัดส่วน" : "จำนวน"}</th>)}
          {hasCol && <th scope="col">รวม</th>}
          {mom && <th scope="col">เทียบเดือนก่อน</th>}
        </tr>
      </thead>
      <tbody>
        {out}
        <tr className="grand">
          <th scope="row">รวมทั้งหมด</th>
          {result.grand.map((v, i) => <td key={i}>{value === "share" ? "100%" : fmtInt(v)}</td>)}
          {hasCol && <td>{fmtInt(result.grandTotal)}</td>}
          {mom && <td><Delta prev={result.grand[n - 2]} cur={result.grand[n - 1]} /></td>}
        </tr>
      </tbody>
    </table>
  );
}
