// นำเข้าหมวดหมู่จาก Excel (SPEC §7): pick/drop a file → preview per service with errors (red, rows
// left out) and warnings (orange, kept) → confirm. Re-importing a service replaces it (confirmed here).
import { useEffect, useState } from "react";
import { AlertTriangle, Check, CircleAlert, Upload } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { Service, TaxonomyImportPreview } from "../lib/types";
import { fmtInt } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { Modal } from "./ui";
import { useFileDrop } from "./useFileDrop";

const EXT = ["xlsx", "xls", "csv"];

export async function downloadTemplate(toast: (m: string) => void) {
  const path = await api.pickSavePath("IncAsk_หมวดหมู่_เทมเพลต.xlsx", [{ name: "Excel", extensions: ["xlsx"] }]);
  if (!path) return;
  try {
    await api.saveTaxonomyTemplate(path);
    toast("✓ บันทึกเทมเพลตแล้ว");
  } catch (e) {
    toast(errMsg(e));
  }
}

export function TaxonomyImportDialog({ projectId, service, initialPath, onClose, onDone }: {
  projectId: string;
  /** the service a file without a "เซอร์วิส" column goes into */
  service: Service | null;
  initialPath?: string;
  onClose: () => void;
  onDone: (services: Service[]) => void;
}) {
  const app = useApp();
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<TaxonomyImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (p: string) => {
    setBusy(true);
    setError(null);
    setPreview(null);
    setPath(p);
    try {
      setPreview(await api.previewTaxonomyImport(projectId, p, service?.name ?? null));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initialPath) load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const choose = async () => {
    const p = await api.pickFile([{ name: "ตารางหมวดหมู่", extensions: EXT }]);
    if (p) load(p);
  };
  const hover = useFileDrop(load, EXT);
  const apply = async () => {
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api.applyTaxonomyImport(projectId, path, service?.name ?? null);
      app.toast(`✓ นำเข้าหมวดหมู่ ${done.map((s) => s.name).join(", ")} แล้ว`);
      onDone(done);
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  const replacing = preview?.services.filter((s) => s.exists && s.rows.length) ?? [];
  const usable = preview?.services.some((s) => s.rows.length) ?? false;

  return (
    <Modal title="นำเข้าหมวดหมู่จาก Excel" subtitle={'หนึ่งไฟล์ต่อหนึ่งเซอร์วิส หรือไฟล์เดียวที่มีคอลัมน์ "เซอร์วิส"'} onClose={onClose} width={680}>
      {!preview && (
        <div className="dropzone" style={hover ? { borderColor: "var(--accent)" } : undefined}>
          <Upload size={30} strokeWidth={1.8} color="var(--accent)" aria-hidden="true" />
          <span style={{ fontWeight: 600 }}>{busy ? "กำลังอ่านไฟล์…" : "ลากไฟล์ Excel หมวดหมู่มาวางที่นี่"}</span>
          <span className="muted" style={{ fontSize: 13 }}>
            หรือ <button className="link-btn" style={{ fontSize: 13, fontWeight: 600 }} onClick={choose}>เลือกไฟล์</button>
            {" · "}
            <button className="link-btn" style={{ fontSize: 13, fontWeight: 600 }} onClick={() => downloadTemplate(app.toast)}>ดาวน์โหลดเทมเพลต</button>
          </span>
          {service && <span className="field-hint">ไฟล์ที่ไม่มีคอลัมน์ "เซอร์วิส" จะนำเข้าเป็นหมวดหมู่ของ <b>{service.name}</b></span>}
        </div>
      )}
      {error && <div className="err-box" role="alert">{error}</div>}
      {preview && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: "52vh", overflowY: "auto" }}>
          <span className="muted" style={{ fontSize: 13 }}>{preview.fileName}</span>
          {preview.services.map((s) => (
            <section key={s.name} className="card" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700 }}>{s.name}</span>
                {s.exists ? <span className="chip warn">แทนที่ของเดิม {fmtInt(s.existingRows)} หมวด</span> : <span className="chip">เซอร์วิสใหม่</span>}
                <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>{s.columns.join(" · ")}</span>
              </div>
              <span style={{ fontSize: 13, color: "var(--ok-text)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Check size={14} strokeWidth={3} aria-hidden="true" />นำเข้าได้ {fmtInt(s.rows.length)} หมวด
              </span>
              {s.errors.length > 0 && (
                <div className="err-box" style={{ padding: "8px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}><CircleAlert size={14} strokeWidth={2} aria-hidden="true" />ไม่นำเข้า {s.errors.length} แถว</div>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>{s.errors.slice(0, 8).map((e) => <li key={e.row + e.message}>แถว {e.row}: {e.message}</li>)}</ul>
                </div>
              )}
              {s.warnings.length > 0 && (
                <div className="warn-box" style={{ padding: "8px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}><AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />ควรแก้ {s.warnings.length} แถว (นำเข้าได้)</div>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>{s.warnings.slice(0, 8).map((e) => <li key={e.row + e.message}>แถว {e.row}: {e.message}</li>)}</ul>
                </div>
              )}
              {s.rows.length > 0 && (
                <div className="table-wrap" style={{ maxHeight: 160, border: "1px solid var(--border-soft)", borderRadius: 8 }}>
                  <table className="tbl">
                    <thead><tr>{s.columns.map((c) => <th key={c}>{c}</th>)}<th>คำอธิบาย</th></tr></thead>
                    <tbody>
                      {s.rows.slice(0, 6).map((r, i) => (
                        <tr key={i}>{s.columns.map((c) => <td key={c}>{r.values[c]}</td>)}<td className="muted">{r.description || "—"}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
      {replacing.length > 0 && (
        <div className="warn-box">นำเข้าซ้ำจะ<b>แทนที่หมวดหมู่ทั้งหมด</b>ของ {replacing.map((s) => s.name).join(", ")} — ทิกเก็ตที่จัดหมวดไว้แล้วยังอยู่ แต่ครั้งต่อไปจะไม่ใช้ผลจากแคชเดิม</div>
      )}
      <div className="modal-actions">
        {preview && <button className="btn btn-lg btn-ghost" onClick={() => { setPreview(null); setPath(null); }}>เลือกไฟล์อื่น</button>}
        <button className="btn btn-lg" onClick={onClose}>{th.cancel}</button>
        {preview && (
          <button className="btn btn-lg btn-primary" disabled={!usable || busy} onClick={apply}>
            {replacing.length ? "ยืนยัน แทนที่และนำเข้า" : "นำเข้า"}
          </button>
        )}
      </div>
    </Modal>
  );
}
