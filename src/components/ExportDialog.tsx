// "ส่งออก" window (SPEC §10, canvas 6): one of three formats + month range + service, then a save
// dialog with `<project>_<yyyy-mm>_<yyyy-mm>.<ext>` as the default name.
import { useEffect, useState } from "react";
import { Check, FolderOpen } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { ExportScope, Service } from "../lib/types";
import { fmtInt, formatBytes, thMonth } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { Modal } from "./ui";

const OPTS = [
  { id: "incask", ext: ".incask", file: "incask", filter: "ไฟล์โปรเจกต์ IncAsk", title: "ไฟล์โปรเจกต์", desc: "ทั้งฐานข้อมูล หมวดหมู่ รูปแบบรีพอร์ต สี และมุมมองที่บันทึก เปิดแล้วเห็นเหมือนเราทุกอย่าง", who: "สำหรับคนที่มีโปรแกรม IncAsk", cta: "บันทึกไฟล์ .incask" },
  { id: "html", ext: "HTML", file: "html", filter: "รายงาน HTML", title: "รายงาน HTML", desc: "ไฟล์เดียว ดับเบิลคลิกเปิดในเบราว์เซอร์ ปรับ pivot และดูรายละเอียดทิกเก็ตได้ แต่แก้หมวดไม่ได้", who: "สำหรับหัวหน้าหรือคนนอกทีม", cta: "บันทึกรายงาน HTML" },
  { id: "csv", ext: "CSV", file: "csv", filter: "CSV (UTF-8)", title: "CSV ดิบ", desc: "ข้อมูลทีละแถวพร้อมหมวดหมู่ เข้ารหัส UTF-8 พร้อม BOM เปิดใน Excel แล้วภาษาไทยไม่เพี้ยน", who: "สำหรับคนที่จะเอาข้อมูลไปทำต่อเอง", cta: "บันทึกไฟล์ CSV" },
] as const;

export function ExportDialog() {
  const app = useApp();
  const project = app.activeProject;
  const [sel, setSel] = useState<(typeof OPTS)[number]["id"]>("incask");
  const [months, setMonths] = useState<string[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [service, setService] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ path: string; text: string } | null>(null);

  useEffect(() => {
    if (!app.exportOpen || !project) return;
    setDone(null);
    setError(null);
    api.projectMonths(project.id).then((m) => { setMonths(m); setFrom(m[0] ?? ""); setTo(m[m.length - 1] ?? ""); }).catch(() => {});
    api.listServices(project.id).then(setServices).catch(() => {});
  }, [app.exportOpen, project]);

  if (!app.exportOpen || !project) return null;
  const close = () => app.setExportOpen(false);
  const cur = OPTS.find((o) => o.id === sel)!;
  const scope: ExportScope = { from, to, service: service || null };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const name = await api.exportDefaultName(project.id, scope, cur.file);
      const path = await api.pickSavePath(name, [{ name: cur.filter, extensions: [cur.file] }]);
      if (!path) { setBusy(false); return; }
      let text = "";
      if (sel === "csv") text = `ส่งออก ${fmtInt(await api.exportCsv(project.id, scope, path))} ทิกเก็ต`;
      if (sel === "incask") text = `ส่งออก ${fmtInt((await api.exportIncask(project.id, scope, path)).tickets)} ทิกเก็ต`;
      if (sel === "html") text = `รายงานขนาด ${formatBytes(await api.exportHtml(project.id, scope, path))}`;
      setDone({ path, text });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Modal title="ส่งออกเรียบร้อย" onClose={close} width={520}>
        <span className="ok-badge" role="status"><Check size={14} strokeWidth={3} aria-hidden="true" />{done.text}</span>
        <span className="mono muted" style={{ fontSize: 12, wordBreak: "break-all" }}>{done.path}</span>
        <div className="modal-actions">
          <button className="btn btn-lg" onClick={() => api.revealFile(done.path).catch((e) => app.toast(errMsg(e)))}><FolderOpen size={16} strokeWidth={1.8} aria-hidden="true" />เปิดโฟลเดอร์</button>
          <button className="btn btn-lg btn-primary" onClick={close}>{th.close}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`ส่งออกโปรเจกต์ ${project.name}`} subtitle="เลือกรูปแบบตามคนที่จะเอาไปใช้ต่อ" onClose={close} width={640}>
      <div role="radiogroup" aria-label="รูปแบบไฟล์" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {OPTS.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={o.id === sel} className="opt-card" onClick={() => setSel(o.id)}>
            <span className="opt-ext">{o.ext}</span>
            <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontWeight: 600 }}>{o.title}</span>
              <span style={{ fontSize: 13, color: "var(--text-2)" }}>{o.desc}</span>
              <span className="muted" style={{ fontSize: 12 }}>{o.who}</span>
            </span>
          </button>
        ))}
      </div>
      {months.length === 0 ? <div className="info-box">ยังไม่มีทิกเก็ตในโปรเจกต์นี้ — ไฟล์จะมีเฉพาะหมวดหมู่และการตั้งค่า</div> : (
        <div className="form-grid">
          <div className="field">
            <label htmlFor="exp-from">ตั้งแต่เดือน</label>
            <select id="exp-from" className="select" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }}>
              {months.map((m) => <option key={m} value={m}>{thMonth(m)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="exp-to">ถึงเดือน</label>
            <select id="exp-to" className="select" value={to} onChange={(e) => { setTo(e.target.value); if (e.target.value < from) setFrom(e.target.value); }}>
              {months.map((m) => <option key={m} value={m}>{thMonth(m)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="exp-svc">เซอร์วิส</label>
            <select id="exp-svc" className="select" value={service} onChange={(e) => setService(e.target.value)}>
              <option value="">ทุกเซอร์วิส</option>
              {services.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
          </div>
        </div>
      )}
      {sel !== "incask" && <span className="field-hint">ไฟล์ไม่มี API key ชื่อ Gateway หรือค่าใช้จ่าย</span>}
      {error && <div className="err-box" role="alert">{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-lg" onClick={close}>{th.cancel}</button>
        <button className="btn btn-lg btn-primary" disabled={busy || (!from && months.length > 0)} onClick={run}>{busy ? "กำลังส่งออก…" : cur.cta}</button>
      </div>
    </Modal>
  );
}
