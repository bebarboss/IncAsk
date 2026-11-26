// Project create / edit / delete dialogs (step 3). Used from the sidebar ("+ โปรเจกต์ใหม่", "จัดการ")
// and from ตั้งค่าโปรเจกต์ › ชื่อและการแชร์โปรเจกต์.
import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { Project } from "../lib/types";
import { PROJECT_COLORS, PROJECT_COLOR_NAMES } from "../lib/gateway";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { Modal } from "./ui";
import { pickIncask } from "./IncaskDialog";

export function ColorPicker({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  return (
    <div className="color-swatches" role="radiogroup" aria-label={label}>
      {PROJECT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c.toUpperCase() === value.toUpperCase()}
          aria-pressed={c.toUpperCase() === value.toUpperCase()}
          aria-label={PROJECT_COLOR_NAMES[c]}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

/** New project (no `project`) or edit name/colour of an existing one. */
export function ProjectFormDialog({ project, onClose }: { project?: Project; onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState(project?.name ?? "");
  const [color, setColor] = useState<string>(project?.color ?? PROJECT_COLORS[app.projects.length % PROJECT_COLORS.length]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (project) {
        await api.updateProject(project.id, { name, color });
        await app.refreshProjects();
        app.toast(`✓ บันทึก ${name.trim()} แล้ว`);
      } else {
        const p = await api.createProject(name, color);
        await app.refreshProjects();
        app.setActiveProject(p.id);
        app.go({ name: "project", tab: "settings" });
        app.toast(`✓ สร้างโปรเจกต์ ${p.name} แล้ว · เริ่มจากเพิ่มเซอร์วิสและหมวดหมู่`);
      }
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={project ? "แก้ไขโปรเจกต์" : "โปรเจกต์ใหม่"} subtitle={project ? undefined : "แต่ละโปรเจกต์มีเซอร์วิส หมวดหมู่ รูปแบบรีพอร์ต และข้อมูลของตัวเอง"} onClose={onClose} width={480}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="field">
          <label htmlFor="pj-name">ชื่อโปรเจกต์</label>
          <input id="pj-name" className="input lg" value={name} maxLength={80} placeholder="เช่น Call Center A, NOC Incident" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <span className="field-label">สีประจำโปรเจกต์</span>
          <ColorPicker value={color} onChange={setColor} label="สีประจำโปรเจกต์" />
        </div>
        {error && <div className="err-box" role="alert">{error}</div>}
        {!project && (
          <span className="muted" style={{ fontSize: 13 }}>
            มีไฟล์โปรเจกต์จากเพื่อน?{" "}
            <button type="button" className="link-btn" style={{ fontSize: 13, fontWeight: 600 }} onClick={async () => { const f = await pickIncask(); if (f) { app.setIncaskPath(f); onClose(); } }}>นำเข้าไฟล์ .incask…</button>
          </span>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-lg" onClick={onClose}>{th.cancel}</button>
          <button type="submit" className="btn btn-lg btn-primary" disabled={busy || !name.trim()}>{project ? th.save : "สร้างโปรเจกต์"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Deleting removes the project's database for good, so the name must be typed back. */
export function DeleteProjectDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const app = useApp();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const match = typed.trim() === project.name;
  const del = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteProject(project.id);
      await Promise.all([app.refreshProjects(), app.refreshSettings()]);
      app.toast(`ลบโปรเจกต์ ${project.name} แล้ว`);
      onClose();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={`ลบโปรเจกต์ ${project.name}?`} onClose={onClose} width={480}>
      <div className="err-box">
        ทิกเก็ต ผลจัดหมวด หมวดหมู่ รูปแบบรีพอร์ต และมุมมองที่บันทึกของโปรเจกต์นี้จะถูกลบออกจากเครื่องถาวร กู้คืนไม่ได้
        ถ้าต้องการเก็บไว้ ส่งออกเป็นไฟล์ .incask ก่อน
      </div>
      <div className="field">
        <label htmlFor="del-name">พิมพ์ <b>{project.name}</b> เพื่อยืนยัน</label>
        <input id="del-name" className="input" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
      </div>
      {error && <div className="err-box" role="alert">{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-lg" onClick={onClose}>{th.cancel}</button>
        <button className="btn btn-lg btn-danger-solid" disabled={!match || busy} onClick={del}>ลบโปรเจกต์</button>
      </div>
    </Modal>
  );
}

/** Sidebar "จัดการ": every project with rename/colour and delete. */
export function ManageProjectsDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  if (editing) return <ProjectFormDialog project={editing} onClose={() => setEditing(null)} />;
  if (deleting) return <DeleteProjectDialog project={deleting} onClose={() => setDeleting(null)} />;
  if (creating) return <ProjectFormDialog onClose={() => setCreating(false)} />;
  return (
    <Modal title="จัดการโปรเจกต์" onClose={onClose} width={520}>
      {app.projects.length === 0 ? (
        <p className="muted">ยังไม่มีโปรเจกต์</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {app.projects.map((p) => (
            <li key={p.id} className="list-row">
              <span className="swatch" style={{ background: p.color }} aria-hidden="true" />
              <span className="ellipsis" style={{ flex: 1, fontWeight: 600 }}>{p.name}</span>
              <button className="icon-btn" aria-label={`แก้ไข ${p.name}`} onClick={() => setEditing(p)}><Pencil size={16} strokeWidth={1.8} /></button>
              <button className="icon-btn" aria-label={`ลบ ${p.name}`} onClick={() => setDeleting(p)} style={{ color: "var(--err-text)" }}><Trash2 size={16} strokeWidth={1.8} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="modal-actions" style={{ justifyContent: "space-between" }}>
        <button className="btn btn-lg" onClick={() => setCreating(true)}>+ โปรเจกต์ใหม่</button>
        <button className="btn btn-lg btn-primary" onClick={onClose}>เสร็จ</button>
      </div>
    </Modal>
  );
}
