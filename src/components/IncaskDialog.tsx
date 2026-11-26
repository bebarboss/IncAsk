// Opening a .incask (SPEC §10.2): as a new project, or merged into an existing one by ticket number
// (asking whose ticket wins when both have it).
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { IncaskInspect } from "../lib/types";
import { fmtInt, thMonth } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { Modal, SkeletonList } from "./ui";

export async function pickIncask(): Promise<string | null> {
  return api.pickFile([{ name: "ไฟล์โปรเจกต์ IncAsk", extensions: ["incask"] }]);
}

export function IncaskDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const app = useApp();
  const [info, setInfo] = useState<IncaskInspect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"new" | "merge">("new");
  const [name, setName] = useState("");
  const [target, setTarget] = useState(app.activeProject?.id ?? app.projects[0]?.id ?? "");
  const [conflicts, setConflicts] = useState<number | null>(null);
  const [takeTheirs, setTakeTheirs] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.inspectIncask(path, null).then((i) => { setInfo(i); setName(i.manifest.projectName); }).catch((e) => setError(errMsg(e)));
  }, [path]);
  useEffect(() => {
    if (mode !== "merge" || !target) return;
    setConflicts(null);
    api.inspectIncask(path, target).then((i) => setConflicts(i.conflicts)).catch(() => setConflicts(0));
  }, [mode, target, path]);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "new") {
        const p = await api.importIncask(path, name.trim() || null);
        await app.refreshProjects();
        app.setActiveProject(p.id);
        app.go({ name: "project", tab: "summary" });
        app.toast(`✓ เปิด ${p.name} แล้ว`);
      } else {
        const r = await api.mergeIncask(target, path, takeTheirs);
        app.setActiveProject(target);
        app.go({ name: "project", tab: "summary" });
        app.toast(`✓ รวมแล้ว · เพิ่ม ${fmtInt(r.added)}${r.replaced ? ` · แทนที่ ${fmtInt(r.replaced)}` : ""}${r.kept ? ` · คงของเดิม ${fmtInt(r.kept)}` : ""} ทิกเก็ต`);
      }
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  const fileName = path.split(/[\\/]/).pop();
  return (
    <Modal title="เปิดไฟล์โปรเจกต์ .incask" subtitle={fileName} onClose={onClose} width={560}>
      {!info && !error && <SkeletonList rows={2} h={40} />}
      {info && (
        <div className="kv">
          <div><span className="k">โปรเจกต์</span><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span className="swatch" style={{ background: info.manifest.projectColor }} aria-hidden="true" />{info.manifest.projectName}</span></div>
          <div><span className="k">ทิกเก็ต</span><span>{fmtInt(info.tickets)}{info.months.length ? ` · ${thMonth(info.months[0])} – ${thMonth(info.months[info.months.length - 1])}` : ""}</span></div>
          <div><span className="k">เซอร์วิส</span><span>{info.services.join(", ") || "—"}</span></div>
          <div><span className="k">ส่งออกเมื่อ</span><span>{new Date(info.manifest.exportedAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })} · IncAsk {info.manifest.appVersion}</span></div>
        </div>
      )}
      {info && (
        <div role="radiogroup" aria-label="วิธีเปิด" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label className="check"><input type="radio" name="inc-mode" checked={mode === "new"} onChange={() => setMode("new")} />เปิดเป็นโปรเจกต์ใหม่</label>
          {mode === "new" && (
            <div className="field" style={{ paddingLeft: 24 }}>
              <label htmlFor="inc-name">ชื่อโปรเจกต์</label>
              <input id="inc-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
              <span className="field-hint">ถ้าชื่อซ้ำ จะต่อท้ายด้วย "(นำเข้า)"</span>
            </div>
          )}
          <label className="check"><input type="radio" name="inc-mode" checked={mode === "merge"} disabled={!app.projects.length} onChange={() => setMode("merge")} />รวมเข้าโปรเจกต์ที่มีอยู่ (จับคู่ด้วยเลขทิกเก็ต)</label>
          {mode === "merge" && (
            <div style={{ paddingLeft: 24, display: "flex", flexDirection: "column", gap: 10 }}>
              <select className="select" aria-label="รวมเข้าโปรเจกต์" value={target} onChange={(e) => setTarget(e.target.value)}>
                {app.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {conflicts === null ? <span className="muted" style={{ fontSize: 13 }}>กำลังตรวจทิกเก็ตซ้ำ…</span> : conflicts === 0 ? (
                <span className="ok-badge"><Check size={14} strokeWidth={3} aria-hidden="true" />ไม่มีทิกเก็ตซ้ำ</span>
              ) : (
                <div className="warn-box" role="group" aria-label="ทิกเก็ตซ้ำ">
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>มีทิกเก็ตเลขเดียวกัน {fmtInt(conflicts)} รายการ — เก็บของใคร?</div>
                  <label className="check"><input type="radio" name="inc-clash" checked={!takeTheirs} onChange={() => setTakeTheirs(false)} />เก็บของเรา (ข้ามแถวในไฟล์)</label>
                  <label className="check"><input type="radio" name="inc-clash" checked={takeTheirs} onChange={() => setTakeTheirs(true)} />ใช้ของในไฟล์ (แทนที่ของเรา รวมผลจัดหมวด)</label>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {error && <div className="err-box" role="alert">{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-lg" onClick={onClose}>{th.cancel}</button>
        <button className="btn btn-lg btn-primary" disabled={!info || busy || (mode === "merge" && (!target || conflicts === null))} onClick={go}>
          {busy ? "กำลังเปิด…" : mode === "new" ? "เปิดเป็นโปรเจกต์ใหม่" : "รวมเข้าโปรเจกต์"}
        </button>
      </div>
    </Modal>
  );
}
