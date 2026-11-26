// Drill-down panel (SPEC §9): tickets of a pivot cell → one ticket's detail with every source
// column, the AI's answer and an inline category editor. Read-only when `taxonomy` is absent
// (the HTML report).
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, X } from "lucide-react";
import type { Service, TaxonomyRow, TicketRow } from "../lib/types";
import { fmtInt, thDate } from "../lib/format";
import { th } from "../i18n/th";
import { categoryLabel } from "./CategoryPicker";
import type { CellRef } from "./PivotTable";

export function TicketPanel({ cell, data, taxonomy, onClose, onSave, onSeeAll, emptyText }: {
  cell: CellRef;
  data: { total: number; rows: TicketRow[] } | null;
  taxonomy?: Record<string, { service: Service; rows: TaxonomyRow[] }> | null;
  onClose: () => void;
  /** save a new category for one ticket; resolves when pivot/charts have been refreshed */
  onSave?: (ticket: TicketRow, fields: Record<string, string>) => Promise<void>;
  onSeeAll?: () => void;
  emptyText?: string;
}) {
  const [detailId, setDetailId] = useState<string | null>(null);
  useEffect(() => { setDetailId(null); }, [cell]);
  const detail = data?.rows.find((r) => r.id === detailId) ?? null;
  const cols = (r: TicketRow) => taxonomy?.[r.service]?.service.columns ?? Object.keys(r.fields);

  return (
    <aside className="drill" aria-label="รายละเอียดทิกเก็ต">
      {!detail ? (
        <>
          <div className="drill-head">
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>{cell.label}</h2>
              <span className="muted" style={{ fontSize: 12 }}>{data ? `${fmtInt(data.total)} ทิกเก็ต${data.total > data.rows.length ? ` · แสดง ${fmtInt(data.rows.length)} รายการล่าสุด` : ""}` : "กำลังโหลด…"}</span>
            </div>
            <button className="icon-btn" aria-label="ปิดแผง" onClick={onClose}><X size={18} strokeWidth={1.8} /></button>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {data?.rows.length === 0 && <p className="muted" style={{ padding: 16 }}>{emptyText ?? "ไม่มีทิกเก็ต"}</p>}
            {data?.rows.map((t) => (
              <button key={t.id} className="tk" onClick={() => setDetailId(t.id)}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                  <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{t.ticketNo}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{thDate(t.date)}</span>
                  {t.source === "human" && <span className="chip" style={{ marginLeft: "auto" }}>แก้โดยคน</span>}
                </span>
                <span className="ellipsis" style={{ fontSize: 13, color: "var(--text-2)", width: "100%" }}>{t.problemText}</span>
                <span style={{ fontSize: 12, color: "var(--accent-ink)", fontWeight: 600 }}>{categoryLabel(cols(t), t.fields) || th.source[t.source]}</span>
              </button>
            ))}
          </div>
          {onSeeAll && (
            <div style={{ padding: 12, borderTop: "1px solid var(--border)" }}>
              <button className="btn" style={{ width: "100%" }} onClick={onSeeAll}>ดูทั้งหมดในหน้าผลลัพธ์</button>
            </div>
          )}
        </>
      ) : (
        <Detail ticket={detail} columns={cols(detail)} rows={taxonomy?.[detail.service]?.rows} onBack={() => setDetailId(null)} onClose={onClose} onSave={onSave} />
      )}
    </aside>
  );
}

function Detail({ ticket, columns, rows, onBack, onClose, onSave }: {
  ticket: TicketRow; columns: string[]; rows?: TaxonomyRow[]; onBack: () => void; onClose: () => void;
  onSave?: (ticket: TicketRow, fields: Record<string, string>) => Promise<void>;
}) {
  const [pick, setPick] = useState<Record<string, string>>({ ...ticket.fields });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setPick({ ...ticket.fields }); }, [ticket]);
  const options = useMemo(() => columns.map((col, i) =>
    [...new Set((rows ?? []).filter((r) => columns.slice(0, i).every((c) => r.values[c] === pick[c])).map((r) => r.values[col]))]), [columns, rows, pick]);
  const chosen = rows?.find((r) => columns.every((c) => r.values[c] === pick[c]));
  const changed = !!chosen && columns.some((c) => chosen.values[c] !== ticket.fields[c]);
  const set = (i: number, v: string) => {
    const next: Record<string, string> = {};
    columns.forEach((c, j) => { if (j < i) next[c] = pick[c]; });
    next[columns[i]] = v;
    for (let j = i + 1; j < columns.length; j++) {
      const opts = [...new Set((rows ?? []).filter((r) => columns.slice(0, j).every((c) => r.values[c] === next[c])).map((r) => r.values[columns[j]]))];
      if (opts.length === 1) next[columns[j]] = opts[0];
      else break;
    }
    setPick(next);
  };
  const save = async () => {
    if (!chosen || !onSave) return;
    setBusy(true);
    setError(null);
    try { await onSave(ticket, chosen.values); } catch (e) { setError((e as { message?: string }).message ?? String(e)); } finally { setBusy(false); }
  };
  const aiLabel = categoryLabel(columns, ticket.aiFields);
  return (
    <>
      <div className="drill-head" style={{ alignItems: "center" }}>
        <button className="btn btn-ghost" onClick={onBack}><ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />กลับไปรายการ</button>
        <button className="icon-btn" aria-label="ปิดแผง" onClick={onClose}><X size={18} strokeWidth={1.8} /></button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{ticket.ticketNo}</h2>
          <p style={{ fontSize: 13, lineHeight: 1.7 }}>{ticket.problemText}</p>
        </div>
        <div className="kv">
          {Object.entries(ticket.sourceRow).map(([k, v]) => <div key={k}><span className="k">{k}</span><span style={{ textAlign: "right", wordBreak: "break-word" }}>{String(v)}</span></div>)}
        </div>
        {(ticket.aiFields || ticket.reason) && (
          <div className="info-box" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
            <span className="muted" style={{ fontSize: 12 }}>AI จัดหมวดเป็น · ความมั่นใจ {ticket.confidence != null ? `${Math.round(ticket.confidence * 100)}%` : "—"}</span>
            <span style={{ fontWeight: 600, color: "var(--text)" }}>{aiLabel || "ไม่ตรงหมวดใด"}</span>
            {ticket.reason && <span style={{ fontSize: 12 }}>เหตุผล: {ticket.reason}</span>}
          </div>
        )}
        {ticket.source === "human" && (
          <div className="chip" style={{ whiteSpace: "normal" }}>แก้โดยคน{ticket.editedBy ? ` (${ticket.editedBy})` : ""}{aiLabel ? ` · เดิม AI จัดเป็น ${aiLabel}` : ""}</div>
        )}
        {rows && onSave ? (
          <>
            {columns.map((col, i) => (
              <div className="field" key={col}>
                <label htmlFor={`td-${i}`}>{col}</label>
                <select id={`td-${i}`} className="select" value={pick[col] ?? ""} disabled={i > 0 && !pick[columns[i - 1]]} onChange={(e) => set(i, e.target.value)}>
                  <option value="" disabled>เลือก{col}</option>
                  {options[i].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            ))}
            {error && <div className="err-box" role="alert">{error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn" onClick={onBack}>{th.cancel}</button>
              <button className="btn btn-primary" disabled={!changed || busy} onClick={save}>{busy ? "กำลังบันทึก…" : th.save}</button>
            </div>
          </>
        ) : (
          <div className="kv">{columns.map((c) => <div key={c}><span className="k">{c}</span><span>{ticket.fields[c] ?? "—"}</span></div>)}</div>
        )}
      </div>
    </>
  );
}
