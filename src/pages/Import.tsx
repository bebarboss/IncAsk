// นำเข้าไฟล์ (SPEC §5, canvas 1). Step 1: layout on mock data — role picking works client-side;
// reading real CSV/XLSX files arrives in step 5.
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { ImportPreview, ImportSummary, Project, Role } from "../lib/types";
import { thDateRange, thMonth, fmtInt } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { EmptyState, ErrorState, SkeletonList } from "../components/ui";
import { GatewayBanner } from "../components/GatewayBanner";

const ROLES: Role[] = ["ticket", "date", "problem", "service", "none"];
const SINGLE: Partial<Record<Role, true>> = { ticket: true, date: true, service: true };

/** choosing a one-column role moves any other column holding it back to "ไม่ใช้" (SPEC §5) */
export function assignRole(roles: Role[], i: number, role: Role): Role[] {
  return roles.map((r, j) => (j === i ? role : SINGLE[role] && r === role ? "none" : r));
}

export default function ImportPage({ project }: { project: Project }) {
  const app = useApp();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(true);
  const [patternName, setPatternName] = useState("รีพอร์ตอินซิเดนต์รายเดือน");

  const load = useCallback(async (path: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const p = await api.previewImport(project.id, path);
      setPreview(p);
      setRoles(p.roles);
      if (p.pattern) setPatternName(p.pattern.name);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  // the mock opens with a sample file already chosen, like the design
  useEffect(() => { if (api.mock) load(null); }, [load]);

  useEffect(() => {
    if (!preview) return;
    api.importSummary(project.id, roles).then(setSummary).catch(() => setSummary(null));
  }, [project.id, preview, roles]);

  const choose = async () => {
    const path = await api.pickFile([{ name: "ไฟล์ทิกเก็ต", extensions: ["csv", "xlsx", "xls"] }]);
    if (path) load(path);
  };

  const has = (r: Role) => roles.includes(r);
  const ready = has("ticket") && has("date") && has("service") && has("problem");
  const gatewayDown = app.gateway.state === "unreachable" || app.gateway.state === "error";
  const sample = useMemo(() => {
    if (!preview) return "";
    return preview.headers.map((h, i) => (roles[i] === "problem" && preview.rows[0]?.[i] ? `${h}: ${preview.rows[0][i]}` : null)).filter(Boolean).join(", ");
  }, [preview, roles]);

  return (
    <div className="page">
      <GatewayBanner />
      <header className="page-head">
        <div className="l">
          <h1 className="page-title">นำเข้าไฟล์</h1>
          <p className="muted">อัปโหลดไฟล์ทิกเก็ต แล้วบอกระบบว่าคอลัมน์ไหนคือเลขทิกเก็ต วันที่ ปัญหา และเซอร์วิส</p>
        </div>
      </header>

      {error && <ErrorState message={error} onRetry={() => load(null)} />}
      {loading && !preview && <SkeletonList rows={3} h={80} />}
      {!loading && !preview && !error && (
        <div className="card">
          <EmptyState
            icon={<FileSpreadsheet size={36} strokeWidth={1.6} aria-hidden="true" />}
            title="เลือกไฟล์ทิกเก็ตรายเดือน"
            body="รองรับ .csv, .xlsx และ .xls · แอปจะจำรูปแบบคอลัมน์ไว้ใช้ครั้งหน้า"
            action={<button className="btn btn-lg btn-primary" onClick={choose}>เลือกไฟล์ (Ctrl+O)</button>}
          />
        </div>
      )}

      {preview && (
        <>
          <section className="card" aria-label="ไฟล์ที่เลือก" style={{ padding: "14px 18px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
            <span style={{ width: 40, height: 40, borderRadius: 10, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }} aria-hidden="true">
              <FileSpreadsheet size={22} strokeWidth={1.8} />
            </span>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 200 }}>
              <span style={{ fontWeight: 600 }}>{preview.fileName}</span>
              <span className="muted" style={{ fontSize: 13 }}>ชีต {preview.sheet} · {preview.headers.length} คอลัมน์ · {fmtInt(preview.rowCount)} แถว</span>
            </div>
            {preview.pattern
              ? <span className="chip">พบรูปแบบ: {preview.pattern.name}</span>
              : <span className="chip warn">รูปแบบใหม่ · ยังไม่เคยตั้งค่า</span>}
            <button className="btn" onClick={choose}>เปลี่ยนไฟล์</button>
          </section>

          <section className="card" aria-labelledby="roles-h" style={{ overflow: "hidden" }}>
            <div className="card-head">
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <h2 id="roles-h">เลือกบทบาทของแต่ละคอลัมน์</h2>
                <span className="muted" style={{ fontSize: 13 }}>ตัวอย่าง {preview.rows.length} แถวแรก · "ปัญหา" เลือกได้หลายคอลัมน์ ที่เหลือเลือกได้อย่างละหนึ่ง</span>
              </div>
              <div className="legend">
                <span><span className="swatch" style={{ background: "var(--accent)" }} />ปัญหา · ส่งให้ AI</span>
                <span><span className="swatch" style={{ background: "var(--role-service)" }} />เซอร์วิส · เลือกชุดหมวด</span>
                <span><span className="swatch" style={{ background: "var(--role-key)" }} />เลขทิกเก็ต / วันที่</span>
              </div>
            </div>
            <div className="table-wrap">
              <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%" }}>
                <thead>
                  <tr>
                    {preview.headers.map((h, i) => (
                      <th key={h + i} scope="col" className={`colhead colhead-${roles[i]}`}>
                        <div>{h}</div>
                        <select className="rolesel" aria-label={`บทบาทของคอลัมน์ ${h}`} value={roles[i]} onChange={(e) => setRoles(assignRole(roles, i, e.target.value as Role))}>
                          {ROLES.map((r) => <option key={r} value={r}>{th.roles[r]}</option>)}
                        </select>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((c, ci) => (
                        <td key={ci} className={`cell cell-${roles[ci]}${roles[ci] === "problem" && c.length > 30 ? " wide" : ""}`}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="two-col">
            <section className="card card-pad" aria-labelledby="sum-h">
              <h2 id="sum-h">สรุปก่อนเริ่ม</h2>
              <div className="form-grid">
                <div className="field">
                  <span className="field-hint">ช่วงข้อมูล (จากคอลัมน์วันที่)</span>
                  {summary?.dateFrom && summary.dateTo
                    ? <span style={{ fontWeight: 600 }}>{thDateRange(summary.dateFrom, summary.dateTo)} · เดือน {summary.months.map((m) => thMonth(m)).join(", ")}</span>
                    : <span className="muted">ยังไม่ได้เลือกคอลัมน์วันที่</span>}
                </div>
                <div className="field">
                  <span className="field-hint">ทิกเก็ตซ้ำกับที่มีในโปรเจกต์</span>
                  {has("ticket")
                    ? <span style={{ fontWeight: 600 }}>{fmtInt(summary?.duplicates ?? 0)} รายการ · จะข้าม ไม่นับซ้ำ</span>
                    : <span className="muted">ยังไม่ได้เลือกคอลัมน์เลขทิกเก็ต</span>}
                </div>
              </div>
              <div className="field">
                <span className="field-hint">ข้อความที่ AI จะได้รับ (แถวแรก)</span>
                {sample
                  ? <div className="info-box" style={{ display: "block", color: "var(--text)" }}>{sample}</div>
                  : <span className="muted">ยังไม่ได้เลือกคอลัมน์ปัญหา</span>}
              </div>
              <div className="field">
                <span className="field-hint">เซอร์วิสที่พบ</span>
                {has("service") && summary ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {summary.services.map((s) => s.known
                      ? <span key={s.name} className="chip neutral">{s.name} · {fmtInt(s.count)}</span>
                      : <span key={s.name} className="chip err">{s.name} · ไม่มีหมวดหมู่</span>)}
                  </div>
                ) : <span className="muted">ยังไม่ได้เลือกคอลัมน์เซอร์วิส</span>}
              </div>
            </section>
            <section className="card card-pad" aria-labelledby="pat-h">
              <h2 id="pat-h">จำรูปแบบรีพอร์ตนี้</h2>
              <div className="field">
                <label htmlFor="pattern">ชื่อรูปแบบ</label>
                <input id="pattern" className="input" value={patternName} disabled={!remember} onChange={(e) => setPatternName(e.target.value)} />
              </div>
              <label className="check">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                ครั้งหน้าเจอไฟล์ที่หัวคอลัมน์ตรงกัน ให้เลือกคอลัมน์ให้อัตโนมัติ
              </label>
            </section>
          </div>

          <footer style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: 10 }}>
            {!ready && <span className="muted" style={{ fontSize: 13 }}>เลือกคอลัมน์ให้ครบทั้งสี่บทบาทก่อน จึงจะเริ่มได้</span>}
            {ready && gatewayDown && <span style={{ fontSize: 13, color: "var(--err-text)" }}>ต่อ Gateway ไม่ได้ — ยังเริ่มจัดหมวดไม่ได้</span>}
            <button className="btn btn-lg" disabled={!ready || gatewayDown} onClick={() => app.toast("ลองจัด 20 แถว — ทำในขั้นที่ 6")}>ลองจัด 20 แถว</button>
            <button className="btn btn-lg btn-primary" disabled={!ready || gatewayDown} onClick={() => app.go({ name: "project", tab: "classify" })}>เริ่มจัดหมวด</button>
          </footer>
        </>
      )}
    </div>
  );
}
