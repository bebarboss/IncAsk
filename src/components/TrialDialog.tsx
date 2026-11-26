// "ลองจัด 20 แถว" (SPEC §6.4): 20 rows spread over every service, classified but not saved.
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { DateOrder, Role, TrialResult } from "../lib/types";
import { fmtInt, money } from "../lib/format";
import { th } from "../i18n/th";
import { Modal, SkeletonList } from "./ui";

export function TrialDialog({ projectId, path, sheet, roles, dateOrder, onClose, onStart }: {
  projectId: string; path: string; sheet: string | null; roles: Role[]; dateOrder: DateOrder | null; onClose: () => void; onStart: () => void;
}) {
  const [r, setR] = useState<TrialResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.classifyTrial(projectId, path, sheet, roles, dateOrder).then(setR).catch((e) => setError(errMsg(e)));
  }, [projectId, path, sheet, roles, dateOrder]);
  const low = r?.items.filter((i) => i.low).length ?? 0;
  return (
    <Modal title="ลองจัด 20 แถว" subtitle="สุ่มจากทุกเซอร์วิสในไฟล์ · ผลนี้ไม่ถูกบันทึก" onClose={onClose} width={860}>
      {error && <div className="err-box" role="alert">{error}</div>}
      {!r && !error && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }} role="status">
          <span className="muted">กำลังส่งให้ AI จัดหมวด…</span>
          <SkeletonList rows={4} h={36} />
        </div>
      )}
      {r && (
        <>
          <div className="muted" style={{ fontSize: 13 }}>
            {fmtInt(r.items.length)} แถว · ไม่มั่นใจ {fmtInt(low)} · {(r.elapsedMs / 1000).toFixed(1)} วินาที · โทเคน {fmtInt(r.tokensIn + r.tokensOut)}{r.cost != null ? ` · ${money(r.cost)}` : ""}
          </div>
          <div className="table-wrap" style={{ maxHeight: "55vh", border: "1px solid var(--border)", borderRadius: 10 }}>
            <table className="tbl">
              <thead><tr><th>เลขทิกเก็ต</th><th>เซอร์วิส</th><th>ข้อความ</th><th>หมวดที่ AI เลือก</th><th className="r">ความมั่นใจ</th></tr></thead>
              <tbody>
                {r.items.map((i) => (
                  <tr key={i.ticketNo} className={i.error ? "row-err" : i.low ? "row-low" : undefined}>
                    <td className="mono" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{i.ticketNo}</td>
                    <td><span className="tag">{i.service}</span></td>
                    <td style={{ minWidth: 260 }}>{i.text}</td>
                    <td style={{ minWidth: 200 }}>
                      {i.error ? <span style={{ color: "var(--err-text)" }}>{i.error}</span> : (
                        <>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--accent-ink)" }}>
                            <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />{i.category ?? "ไม่ตรงหมวดใด"}
                          </span>
                          {i.reason && <div className="muted" style={{ fontSize: 12 }}>{i.reason}</div>}
                        </>
                      )}
                    </td>
                    <td className="r" style={{ whiteSpace: "nowrap", color: i.low ? "var(--warn-text)" : undefined, fontWeight: i.low ? 600 : undefined }}>
                      {i.confidence != null ? `${i.low ? "ต่ำ · " : ""}${Math.round(i.confidence * 100)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {low > r.items.length / 3 && <div className="warn-box">AI ไม่มั่นใจหลายแถว — ลองเพิ่มคำอธิบายหรือตัวอย่างให้หมวดหมู่ในตั้งค่าโปรเจกต์ก่อนเริ่มจริง</div>}
        </>
      )}
      <div className="modal-actions">
        <button className="btn btn-lg" onClick={onClose}>{th.close}</button>
        <button className="btn btn-lg btn-primary" disabled={!r} onClick={onStart}>เริ่มจัดหมวดทั้งไฟล์</button>
      </div>
    </Modal>
  );
}
