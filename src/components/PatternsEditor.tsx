// ตั้งค่าโปรเจกต์ › รูปแบบรีพอร์ต (SPEC §11.4 canvas 5): view, rename, edit roles, delete.
import { useCallback, useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { Project, ReportPattern, Role } from "../lib/types";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { assignRole } from "../pages/Import";
import { EmptyState, ErrorState, Modal, SkeletonList } from "./ui";

const ROLES: Role[] = ["ticket", "date", "problem", "service", "none"];

function rolesOf(p: ReportPattern): Role[] {
  return p.headers.map((h) =>
    p.roles.ticket === h ? "ticket" : p.roles.date === h ? "date" : p.roles.service === h ? "service" : p.roles.problem.includes(h) ? "problem" : "none",
  );
}

export function PatternsEditor({ project }: { project: Project }) {
  const app = useApp();
  const [list, setList] = useState<ReportPattern[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ReportPattern | null>(null);
  const load = useCallback(() => {
    api.listPatterns(project.id).then(setList).catch((e) => setError(errMsg(e)));
  }, [project.id]);
  useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!list) return <SkeletonList rows={2} />;
  if (!list.length) {
    return <div className="card"><EmptyState title="ยังไม่มีรูปแบบรีพอร์ต" body={'ติ๊ก "จำรูปแบบรีพอร์ตนี้" ตอนนำเข้าไฟล์ ครั้งหน้าที่เจอไฟล์หัวคอลัมน์เดียวกัน แอปจะเลือกคอลัมน์ให้เอง'} /></div>;
  }
  return (
    <section className="card" aria-label="รูปแบบรีพอร์ต" style={{ overflow: "hidden" }}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {list.map((p) => (
          <li key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--border-soft)" }}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{p.name}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {p.headers.length} คอลัมน์ · เลขทิกเก็ต: {p.roles.ticket ?? "—"} · วันที่: {p.roles.date ?? "—"}{p.dateFormat === "mdy" ? " (เดือน/วัน)" : ""} · เซอร์วิส: {p.roles.service ?? "—"} · ปัญหา: {p.roles.problem.join(", ") || "—"}
              </span>
            </div>
            <button className="icon-btn" aria-label={`แก้ไข ${p.name}`} onClick={() => setEditing(p)}><Pencil size={16} strokeWidth={1.8} /></button>
            <button className="icon-btn" aria-label={`ลบ ${p.name}`} style={{ color: "var(--err-text)" }} onClick={async () => { await api.deletePattern(project.id, p.id); app.toast(`ลบรูปแบบ ${p.name} แล้ว`); load(); }}>
              <Trash2 size={16} strokeWidth={1.8} />
            </button>
          </li>
        ))}
      </ul>
      {editing && <PatternDialog projectId={project.id} pattern={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </section>
  );
}

function PatternDialog({ projectId, pattern, onClose, onSaved }: { projectId: string; pattern: ReportPattern; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(pattern.name);
  const [roles, setRoles] = useState<Role[]>(rolesOf(pattern));
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api.updatePattern(projectId, pattern.id, { name, roles });
      onSaved();
      onClose();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  return (
    <Modal title="แก้ไขรูปแบบรีพอร์ต" onClose={onClose} width={560}>
      <div className="field">
        <label htmlFor="pt-name">ชื่อรูปแบบ</label>
        <input id="pt-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="table-wrap" style={{ maxHeight: "45vh", border: "1px solid var(--border)", borderRadius: 10 }}>
        <table className="tbl">
          <thead><tr><th>หัวคอลัมน์ในไฟล์</th><th>บทบาท</th></tr></thead>
          <tbody>
            {pattern.headers.map((h, i) => (
              <tr key={h}>
                <td>{h}</td>
                <td style={{ padding: 4 }}>
                  <select className="select sm" aria-label={`บทบาทของ ${h}`} value={roles[i]} onChange={(e) => setRoles(assignRole(roles, i, e.target.value as Role))}>
                    {ROLES.map((r) => <option key={r} value={r}>{th.roles[r]}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <div className="err-box" role="alert">{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-lg" onClick={onClose}>{th.cancel}</button>
        <button className="btn btn-lg btn-primary" disabled={!name.trim()} onClick={save}>{th.save}</button>
      </div>
    </Modal>
  );
}
