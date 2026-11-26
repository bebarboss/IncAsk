// The pivot engine in TypeScript — same output shape as src-tauri/src/pivot.rs. Used by mock mode
// and by the offline HTML report (which carries the tickets inside the file).
import type { Charts, PivotConfig, PivotNode, PivotResult, TicketRow } from "./types";

export const EMPTY = "(ว่าง)";
export const UNCLASSIFIED = "(ยังไม่มีหมวด)";

export type PivotTicket = Pick<TicketRow, "service" | "month" | "source" | "fields" | "sourceRow">;

const emptyLabel = (field: string) => (field.startsWith("cat:") ? UNCLASSIFIED : EMPTY);

export function fieldValue(t: PivotTicket, field: string): string {
  let v: string | undefined | null;
  if (field === "service") v = t.service;
  else if (field === "month") v = t.month;
  else if (field === "source") v = t.source;
  else if (field.startsWith("cat:")) v = t.fields?.[field.slice(4)];
  else if (field.startsWith("src:")) v = t.sourceRow?.[field.slice(4)];
  return v ? String(v) : emptyLabel(field);
}

export function matches(t: PivotTicket, cfg: Pick<PivotConfig, "from" | "to" | "filters">): boolean {
  if (t.month < cfg.from || t.month > cfg.to) return false;
  return cfg.filters.every((f) => !f.values.length || f.values.includes(fieldValue(t, f.field)));
}

export function pivotJs(tickets: PivotTicket[], cfg: PivotConfig): PivotResult {
  const rows = tickets.filter((t) => matches(t, cfg));
  const hasCol = !!cfg.col;
  let colKeys = hasCol ? [...new Set(rows.map((t) => fieldValue(t, cfg.col)))].sort() : ["รวม"];
  if (!hasCol) colKeys = ["รวม"];
  const idx = new Map(colKeys.map((k, i) => [k, i]));
  const width = colKeys.length;
  const tree: PivotNode[] = [];
  const grand = new Array(width).fill(0);
  for (const t of rows) {
    const ci = hasCol ? idx.get(fieldValue(t, cfg.col))! : 0;
    grand[ci]++;
    let level = tree;
    for (const f of cfg.rows) {
      const key = fieldValue(t, f);
      let node = level.find((n) => n.key === key);
      if (!node) { node = { key, values: new Array(width).fill(0), total: 0, children: [] }; level.push(node); }
      node.values[ci]++;
      node.total++;
      level = node.children;
    }
  }
  const order = (nodes: PivotNode[], fields: string[]) => {
    if (fields[0] === "month") nodes.sort((a, b) => a.key.localeCompare(b.key));
    else nodes.sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
    nodes.forEach((n) => order(n.children, fields.slice(1)));
  };
  order(tree, cfg.rows);
  return { colKeys, rows: tree, grand, grandTotal: grand.reduce((a, b) => a + b, 0) };
}

export function drillJs<T extends PivotTicket>(tickets: T[], cfg: PivotConfig, path: [string, string][], col: [string, string] | null): T[] {
  return tickets.filter((t) => matches(t, cfg) && path.every(([f, v]) => fieldValue(t, f) === v) && (!col || fieldValue(t, col[0]) === col[1]));
}

export function chartsJs(tickets: PivotTicket[], cfg: Pick<PivotConfig, "from" | "to" | "filters">, services: { name: string; color: string; columns: string[] }[]): Charts {
  const rows = tickets.filter((t) => matches(t, cfg));
  const months = [...new Set(rows.map((t) => t.month))].sort();
  const color = (s: string) => services.find((x) => x.name === s)?.color ?? "#5B6270";
  const per: Record<string, number[]> = {};
  const cat: Record<string, number> = {};
  const last = months[months.length - 1];
  for (const t of rows) {
    (per[t.service] ??= new Array(months.length).fill(0))[months.indexOf(t.month)]++;
    const top = services.find((s) => s.name === t.service)?.columns[0];
    const v = top ? t.fields?.[top] : undefined;
    if (t.month === last && v) cat[`${t.service}\u0000${v}`] = (cat[`${t.service}\u0000${v}`] ?? 0) + 1;
  }
  const trend = Object.entries(per).map(([name, values]) => ({ name, color: color(name), values })).sort((a, b) => b.values.reduce((x, y) => x + y, 0) - a.values.reduce((x, y) => x + y, 0));
  const top = Object.entries(cat).map(([k, count]) => { const [service, category] = k.split("\u0000"); return { service, category, count, color: color(service) }; })
    .sort((a, b) => b.count - a.count || a.service.localeCompare(b.service)).slice(0, 5);
  return { months, trend, top };
}

export function fieldValuesJs(tickets: PivotTicket[], field: string, from: string, to: string): string[] {
  return [...new Set(tickets.filter((t) => t.month >= from && t.month <= to).map((t) => fieldValue(t, field)))].sort();
}
