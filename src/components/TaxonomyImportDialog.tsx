// นำเข้าหมวดหมู่จาก Excel (SPEC §7): pick/drop a file → preview per service with errors (red, rows
// left out) and warnings (orange, kept) → confirm. Re-importing a service replaces it (confirmed here).
import { useEffect, useState } from "react";
import { AlertTriangle, Check, CircleAlert, Upload } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { ImportColumnRole, Service, TaxonomyImportPreview } from "../lib/types";
import { CauseChip } from "./Cause";
import { fmtInt } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { Modal } from "./ui";
import { useFileDrop } from "./useFileDrop";

const EXT = ["xlsx", "xls", "csv"];

const ROLE_LABEL: Record<ImportColumnRole, string> = {
  level: "ชั้นหมวด", service: "เซอร์วิส", description: "คำอธิบาย", examples: "ตัวอย่าง", cause: "ต้นเหตุ (Classification)", ignore: "ไม่ใช้",
};
const ROLE_ORDER: ImportColumnRole[] = ["level", "service", "description", "examples", "cause", "ignore"];

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

  /** roles the user set; null = let IncAsk guess from the headers */
  const [roles, setRoles] = useState<ImportColumnRole[] | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const load = async (p: string, r: ImportColumnRole[] | null = null) => {
    setBusy(true);
    setError(null);
    if (p !== path) setPreview(null);
    setPath(p);
    try {
      const pv = await api.previewTaxonomyImport(projectId, p, service?.name ?? null, r);
      setPreview(pv);
      setHeaders(pv.headers);
      setRoles(pv.roles);
    } catch (e) {
      setError(errMsg(e));
      // keep the column list so a wrong guess can be fixed
      if (!r) setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  const setRole = (i: number, role: ImportColumnRole) => {
    if (!roles || !path) return;
    const next = roles.map((x, j) => (j === i ? role : x));
    setRoles(next);
    load(path, next);
  };
  const levelCount = roles?.filter((r) => r === "level").length ?? 0;
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
      const done = await api.applyTaxonomyImport(projectId, path, service?.name ?? null, roles);
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
      {!preview && !roles && (
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
      {roles && headers.length > 0 && (
        <details className="card" style={{ padding: "10px 14px" }} open={!preview || levelCount === 0 || levelCount > 6}>
          <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 14 }}>
            คอลัมน์ในไฟล์ · ชั้นหมวด {levelCount} คอลัมน์{roles.includes("cause") ? " · มีต้นเหตุ" : ""} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(เดาให้แล้ว แก้ได้)</span>
          </summary>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "6px 12px", marginTop: 10, maxHeight: 220, overflowY: "auto" }}>
            {headers.map((h, i) => (
              <label key={i} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
                <span className="ellipsis" title={h} style={{ fontWeight: 600, color: roles[i] === "ignore" ? "var(--muted)" : "var(--text)" }}>{h || `(คอลัมน์ ${i + 1})`}</span>
                <select className="select sm" value={roles[i]} disabled={busy} onChange={(e) => setRole(i, e.target.value as ImportColumnRole)}>
                  {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              </label>
            ))}
          </div>
          <p className="field-hint" style={{ marginTop: 8 }}>ชั้นหมวดเรียงจากซ้ายไปขวาตามไฟล์ · ช่องชั้นสุดท้ายที่ว่างจะเป็น "ทั่วไป" · ต้นเหตุ: User → ผู้ใช้, Program/Software → โปรแกรม</p>
        </details>
      )}
      {preview && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: "44vh", overflowY: "auto" }}>
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
                    <thead><tr>{s.columns.map((c) => <th key={c}>{c}</th>)}<th>คำอธิบาย</th>{roles?.includes("cause") && <th>ต้นเหตุ</th>}</tr></thead>
                    <tbody>
                      {s.rows.slice(0, 6).map((r, i) => (
                        <tr key={i}>{s.columns.map((c) => <td key={c}>{r.values[c]}</td>)}<td className="muted">{r.description || "—"}</td>
                          {roles?.includes("cause") && <td>{r.cause ? <CauseChip cause={r.cause} /> : <span className="muted">AI ประเมิน</span>}</td>}</tr>
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
        {(preview || roles) && <button className="btn btn-lg btn-ghost" onClick={() => { setPreview(null); setPath(null); setRoles(null); setHeaders([]); setError(null); }}>เลือกไฟล์อื่น</button>}
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
