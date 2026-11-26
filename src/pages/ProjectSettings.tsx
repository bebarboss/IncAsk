// ตั้งค่าโปรเจกต์ (SPEC §7, canvas 5): sub-menu + sections.
import { useEffect, useState } from "react";
import { api, errMsg } from "../lib/api";
import type { Project } from "../lib/types";
import { useApp } from "../state";
import { EmptyState } from "../components/ui";
import { ColorPicker, DeleteProjectDialog } from "../components/ProjectDialogs";
import { TaxonomyEditor } from "../components/TaxonomyEditor";
import { PatternsEditor } from "../components/PatternsEditor";

type Section = "taxonomy" | "patterns" | "columns" | "display" | "share";
const SECTIONS: [Section, string][] = [
  ["taxonomy", "เซอร์วิสและหมวดหมู่"],
  ["patterns", "รูปแบบรีพอร์ต"],
  ["columns", "คอลัมน์ผลลัพธ์"],
  ["display", "สีและการแสดงผล"],
  ["share", "ชื่อและการแชร์โปรเจกต์"],
];

export default function ProjectSettingsPage({ project }: { project: Project }) {
  const [section, setSection] = useState<Section>("taxonomy");
  return (
    <div className="page">
      <h1 className="page-title">ตั้งค่าโปรเจกต์</h1>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="หมวดการตั้งค่า">
          {SECTIONS.map(([id, label]) => (
            <button key={id} aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)}>{label}</button>
          ))}
        </nav>
        <div className="settings-main">
          {section === "taxonomy" && <TaxonomyEditor project={project} />}
          {section === "share" && <ProjectIdentity project={project} />}
          {section === "patterns" && <PatternsEditor project={project} />}
          {section === "display" && <DisplaySettings project={project} />}
          {section === "columns" && (
            <div className="card"><EmptyState title={SECTIONS.find(([id]) => id === section)![1]} body="ส่วนนี้จะทำในขั้นถัดไปตาม SPEC ข้อ 17" /></div>
          )}
        </div>
      </div>
    </div>
  );
}

/** ชื่อและการแชร์โปรเจกต์: rename, colour, share (.incask in step 9), delete. */
function ProjectIdentity({ project }: { project: Project }) {
  const app = useApp();
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(project.color);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dirty = name.trim() !== project.name || color.toUpperCase() !== project.color.toUpperCase();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      const p = await api.updateProject(project.id, { name, color });
      await app.refreshProjects();
      setName(p.name);
      setMsg({ ok: true, text: "✓ บันทึกแล้ว" });
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) });
    }
  };
  return (
    <>
      <form className="card card-pad" aria-labelledby="id-h" onSubmit={save}>
        <h2 id="id-h">ชื่อและสีของโปรเจกต์</h2>
        <div className="field">
          <label htmlFor="ps-name">ชื่อโปรเจกต์</label>
          <input id="ps-name" className="input" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); setMsg(null); }} />
        </div>
        <div className="field">
          <span className="field-label">สีประจำโปรเจกต์</span>
          <ColorPicker value={color} onChange={(c) => { setColor(c); setMsg(null); }} label="สีประจำโปรเจกต์" />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="submit" className="btn btn-primary" disabled={!dirty || !name.trim()}>บันทึก</button>
          {msg && <span role={msg.ok ? "status" : "alert"} style={{ fontSize: 13, color: msg.ok ? "var(--ok-text)" : "var(--err-text)" }}>{msg.text}</span>}
        </div>
      </form>
      <section className="card card-pad" aria-labelledby="share-h">
        <h2 id="share-h">แชร์โปรเจกต์</h2>
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>ส่งออกเป็นไฟล์ .incask ให้เพื่อนที่มี IncAsk เปิดดูได้เหมือนเราทุกอย่าง หรือส่งออกรายงาน HTML ให้คนที่ไม่มีโปรแกรม</p>
        <div><button className="btn" onClick={() => app.setExportOpen(true)}>ส่งออก…</button></div>
      </section>
      <section className="card card-pad" aria-labelledby="danger-h" style={{ borderColor: "var(--err-border)" }}>
        <h2 id="danger-h" style={{ color: "var(--err-text)" }}>ลบโปรเจกต์</h2>
        <p className="muted" style={{ fontSize: 13 }}>ลบฐานข้อมูลของโปรเจกต์นี้ออกจากเครื่องถาวร โปรเจกต์อื่นไม่ได้รับผล</p>
        <div><button className="btn btn-danger" onClick={() => setDeleting(true)}>ลบโปรเจกต์ {project.name}…</button></div>
      </section>
      {deleting && <DeleteProjectDialog project={project} onClose={() => setDeleting(false)} />}
    </>
  );
}

/** สีและการแสดงผล: the "ไม่มั่นใจ" threshold (SPEC §6.2). Service colours live with each service. */
function DisplaySettings({ project }: { project: Project }) {
  const app = useApp();
  const [thr, setThr] = useState<number | null>(null);
  useEffect(() => {
    api.getPref(project.id, "low_threshold").then((v) => setThr(v != null && !Number.isNaN(Number(v)) ? Number(v) : 0.7)).catch(() => setThr(0.7));
  }, [project.id]);
  const save = async (v: number) => {
    setThr(v);
    try { await api.setPref(project.id, "low_threshold", String(v)); } catch (e) { app.toast(errMsg(e)); }
  };
  if (thr == null) return null;
  return (
    <section className="card card-pad" aria-labelledby="disp-h">
      <h2 id="disp-h">เกณฑ์ "ไม่มั่นใจ"</h2>
      <p className="muted" style={{ fontSize: 13 }}>ผลที่ AI ให้ความมั่นใจต่ำกว่าค่านี้จะถูกไฮไลต์ในหน้าผลลัพธ์ และนับเป็น "ไม่มั่นใจ · ควรตรวจ"</p>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <input type="range" min={0.5} max={0.95} step={0.05} value={thr} aria-label="เกณฑ์ความมั่นใจ" style={{ width: 260, accentColor: "var(--accent)" }}
          onChange={(e) => setThr(Number(e.target.value))} onMouseUp={() => save(thr)} onKeyUp={() => save(thr)} onTouchEnd={() => save(thr)} />
        <span className="num" style={{ fontWeight: 700, fontSize: 18 }}>{Math.round(thr * 100)}%</span>
        {thr !== 0.7 && <button className="btn btn-ghost" onClick={() => save(0.7)}>ค่าเริ่มต้น 70%</button>}
      </div>
      <span className="field-hint">สีประจำเซอร์วิสตั้งได้ใน เซอร์วิสและหมวดหมู่ · มีผลกับงานจัดหมวดครั้งถัดไป</span>
    </section>
  );
}
