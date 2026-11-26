// "ส่งออก" window (SPEC §10, canvas 6): pick one of three formats + month range + service.
// Step 1 is the layout only — saving the file arrives in step 9.
import { useState } from "react";
import { useApp } from "../state";
import { Modal } from "./ui";

const OPTS = [
  { id: "incask", ext: ".incask", title: "ไฟล์โปรเจกต์", desc: "ทั้งฐานข้อมูล หมวดหมู่ รูปแบบรีพอร์ต สี และมุมมองที่บันทึก เปิดแล้วเห็นเหมือนเราทุกอย่าง", who: "สำหรับคนที่มีโปรแกรม IncAsk", cta: "บันทึกไฟล์ .incask" },
  { id: "html", ext: "HTML", title: "รายงาน HTML", desc: "ไฟล์เดียว ดับเบิลคลิกเปิดในเบราว์เซอร์ ปรับ pivot และดูรายละเอียดทิกเก็ตได้ แต่แก้หมวดไม่ได้", who: "สำหรับหัวหน้าหรือคนนอกทีม", cta: "บันทึกรายงาน HTML" },
  { id: "csv", ext: "CSV", title: "CSV ดิบ", desc: "ข้อมูลทีละแถวพร้อมหมวดหมู่ เข้ารหัส UTF-8 พร้อม BOM เปิดใน Excel แล้วภาษาไทยไม่เพี้ยน", who: "สำหรับคนที่จะเอาข้อมูลไปทำต่อเอง", cta: "บันทึกไฟล์ CSV" },
] as const;

export function ExportDialog() {
  const app = useApp();
  const [sel, setSel] = useState<(typeof OPTS)[number]["id"]>("incask");
  if (!app.exportOpen || !app.activeProject) return null;
  const close = () => app.setExportOpen(false);
  const cur = OPTS.find((o) => o.id === sel)!;
  return (
    <Modal title={`ส่งออกโปรเจกต์ ${app.activeProject.name}`} subtitle="เลือกรูปแบบตามคนที่จะเอาไปใช้ต่อ" onClose={close} width={640}>
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
      <div className="form-grid">
        <div className="field">
          <label htmlFor="exp-range">ช่วงเดือน</label>
          <select id="exp-range" className="select"><option>ส.ค. – ต.ค. 2569</option></select>
        </div>
        <div className="field">
          <label htmlFor="exp-svc">เซอร์วิส</label>
          <select id="exp-svc" className="select"><option>ทุกเซอร์วิส</option></select>
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn btn-lg" onClick={close}>ยกเลิก</button>
        <button className="btn btn-lg btn-primary" onClick={() => { app.toast("ส่งออกไฟล์ — ทำในขั้นที่ 9"); close(); }}>{cur.cta}</button>
      </div>
    </Modal>
  );
}
