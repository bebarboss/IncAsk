// Hierarchical category picker (SPEC §8): only the categories of the ticket's service; each level
// is filtered by the levels above it.
import { useEffect, useMemo, useState } from "react";
import { api, errMsg } from "../lib/api";
import type { Service, TaxonomyRow } from "../lib/types";
import { th } from "../i18n/th";
import { Modal, SkeletonList } from "./ui";

/** services + their categories of a project, loaded once per mount */
export function useTaxonomy(projectId: string) {
  const [data, setData] = useState<Record<string, { service: Service; rows: TaxonomyRow[] }> | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const services = await api.listServices(projectId);
      const pairs = await Promise.all(services.map(async (s) => [s.name, { service: s, rows: await api.listTaxonomy(projectId, s.id) }] as const));
      if (alive) setData(Object.fromEntries(pairs));
    })().catch(() => alive && setData({}));
    return () => { alive = false; };
  }, [projectId]);
  return data;
}

/** "A › B" in the service's column order (stored fields are a sorted map) */
export function categoryLabel(columns: string[] | undefined, fields: Record<string, string> | null | undefined): string {
  if (!fields) return "";
  const cols = columns ?? Object.keys(fields);
  return cols.map((c) => fields[c]).filter(Boolean).join(" › ");
}

export function CategoryPicker({ projectId, service, columns, rows, current, count, onClose, onSaved }: {
  projectId: string;
  service: string;
  columns: string[];
  rows: TaxonomyRow[];
  current: Record<string, string> | null;
  /** ticket ids to change */
  count: string[];
  onClose: () => void;
  onSaved: (fields: Record<string, string>) => void;
}) {
  const [pick, setPick] = useState<Record<string, string>>(() => ({ ...(current ?? {}) }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = useMemo(() =>
    columns.map((col, i) => {
      const matching = rows.filter((r) => columns.slice(0, i).every((c) => r.values[c] === pick[c]));
      return [...new Set(matching.map((r) => r.values[col]))];
    }), [columns, rows, pick]);
  const chosen = rows.find((r) => columns.every((c) => r.values[c] === pick[c]));
  const set = (i: number, v: string) => {
    const next: Record<string, string> = {};
    columns.forEach((c, j) => { if (j < i) next[c] = pick[c]; });
    next[columns[i]] = v;
    // a single option below → pick it straight away
    for (let j = i + 1; j < columns.length; j++) {
      const opts = [...new Set(rows.filter((r) => columns.slice(0, j).every((c) => r.values[c] === next[c])).map((r) => r.values[columns[j]]))];
      if (opts.length === 1) next[columns[j]] = opts[0];
      else break;
    }
    setPick(next);
  };
  const save = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await api.setCategory(projectId, count, chosen.values);
      onSaved(chosen.values);
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={count.length > 1 ? `ตั้งหมวด ${count.length} ทิกเก็ต` : "แก้หมวด"} subtitle={`เซอร์วิส ${service} · บันทึกเป็น "แก้โดยคน" ผลเดิมของ AI ยังเก็บไว้`} onClose={onClose} width={460}>
      {!rows.length ? <SkeletonList rows={2} h={40} /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {columns.map((col, i) => (
            <div className="field" key={col}>
              <label htmlFor={`cp-${i}`}>{col}</label>
              <select id={`cp-${i}`} className="select" value={pick[col] ?? ""} disabled={i > 0 && !pick[columns[i - 1]]} onChange={(e) => set(i, e.target.value)}>
                <option value="" disabled>เลือก{col}</option>
                {options[i].map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          ))}
          {chosen?.description && <div className="info-box" style={{ display: "block" }}>{chosen.code} · {chosen.description}</div>}
        </div>
      )}
      {error && <div className="err-box" role="alert">{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-lg" onClick={onClose}>{th.cancel}</button>
        <button className="btn btn-lg btn-primary" disabled={!chosen || busy} onClick={save}>{th.save}</button>
      </div>
    </Modal>
  );
}
