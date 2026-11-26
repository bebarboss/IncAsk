// นำเข้าไฟล์ (SPEC §5, canvas 1): pick a file → role per column (auto from a saved pattern) →
// live summary → remember pattern → commit and start classifying.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { DateOrder, ImportPreview, ImportSummary, Project, Role } from "../lib/types";
import { thDateRange, thMonth, fmtInt } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { EmptyState, ErrorState, SkeletonList } from "../components/ui";
import { GatewayBanner } from "../components/GatewayBanner";
import { useFileDrop } from "../components/useFileDrop";
import { TrialDialog } from "../components/TrialDialog";

const ROLES: Role[] = ["ticket", "date", "problem", "service", "none"];
const SINGLE: Partial<Record<Role, true>> = { ticket: true, date: true, service: true };
const EXT = ["csv", "xlsx", "xls"];

/** choosing a one-column role moves any other column holding it back to "ไม่ใช้" (SPEC §5) */
export function assignRole(roles: Role[], i: number, role: Role): Role[] {
  return roles.map((r, j) => (j === i ? role : SINGLE[role] && r === role ? "none" : r));
}

/** Set by Ctrl+O / the trial dialog so a file can be handed to this page. */
export const importBus = { pick: null as null | (() => void) };

export default function ImportPage({ project }: { project: Project }) {
  const app = useApp();
  const [path, setPath] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [dateOrder, setDateOrder] = useState<DateOrder | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(false);
  const [remember, setRemember] = useState(true);
  const [patternName, setPatternName] = useState("รีพอร์ตอินซิเดนต์รายเดือน");
  const [showInvalid, setShowInvalid] = useState(false);
  const [trial, setTrial] = useState(false);

  const load = useCallback(async (p: string, sh: string | null) => {
    setLoading(true);
    setError(null);
    setSummary(null);
    try {
      const pv = await api.previewImport(project.id, p, sh);
      setPath(p);
      setSheet(pv.sheet);
      setPreview(pv);
      setRoles(pv.roles);
      setDateOrder(pv.dateOrder);
      if (pv.pattern) setPatternName(pv.pattern.name);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  const choose = useCallback(async () => {
    const p = await api.pickFile([{ name: "ไฟล์ทิกเก็ต", extensions: EXT }]);
    if (p) load(p, null);
  }, [load]);
  useEffect(() => { importBus.pick = choose; return () => { importBus.pick = null; }; }, [choose]);
  const hover = useFileDrop((p) => load(p, null), EXT);

  // live summary — debounced so flipping several roles costs one pass over the file
  const seq = useRef(0);
  useEffect(() => {
    if (!path || !preview) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      api.importAnalyze(project.id, path, sheet, roles, dateOrder)
        .then((s) => { if (n === seq.current) { setSummary(s); setSummaryError(null); } })
        .catch((e) => { if (n === seq.current) { setSummary(null); setSummaryError(errMsg(e)); } });
    }, 150);
    return () => clearTimeout(t);
  }, [project.id, path, sheet, preview, roles, dateOrder]);

  const has = (r: Role) => roles.includes(r);
  const rolesReady = has("ticket") && has("date") && has("service") && has("problem");
  const needsOrder = summary?.dateAmbiguous && !dateOrder;
  const ready = rolesReady && !!summary && !needsOrder && summary.newRows + (replace ? summary.duplicates : 0) > 0;
  const gatewayDown = app.gateway.state === "unreachable" || app.gateway.state === "error";
  const sample = useMemo(() => {
    if (!preview) return "";
    return summary?.sample || preview.headers.map((h, i) => (roles[i] === "problem" && preview.rows[0]?.[i] ? `${h}: ${preview.rows[0][i]}` : null)).filter(Boolean).join(", ");
  }, [preview, roles, summary]);

  const start = async () => {
    if (!path) return;
    setBusy(true);
    try {
      const r = await api.importCommit(project.id, path, sheet, roles, dateOrder ?? summary?.dateOrder ?? null, replace, remember ? patternName : null);
      app.toast(`✓ นำเข้า ${fmtInt(r.rowsNew)} ทิกเก็ต${r.rowsDuplicate ? ` · ซ้ำ ${fmtInt(r.rowsDuplicate)}` : ""}${r.unknownService ? ` · ไม่มีหมวดหมู่ ${fmtInt(r.unknownService)}` : ""}`);
      await afterCommit(r.importId);
    } catch (e) {
      app.toast(errMsg(e));
      setBusy(false);
    }
  };
  const afterCommit = async (importId: string) => {
    try {
      await api.startClassify(project.id, importId);
    } catch (e) {
      app.toast(errMsg(e));
    }
    app.go({ name: "project", tab: "classify" });
  };

  return (
    <div className="page">
      <GatewayBanner />
      <header className="page-head">
        <div className="l">
          <h1 className="page-title">นำเข้าไฟล์</h1>
          <p className="muted">อัปโหลดไฟล์ทิกเก็ต แล้วบอกระบบว่าคอลัมน์ไหนคือเลขทิกเก็ต วันที่ ปัญหา และเซอร์วิส</p>
        </div>
      </header>

      {error && <ErrorState message={error} onRetry={choose} />}
      {loading && !preview && <SkeletonList rows={3} h={80} />}
      {!loading && !preview && (
        <div className="card" style={hover ? { borderColor: "var(--accent)" } : undefined}>
          <EmptyState
            icon={<FileSpreadsheet size={36} strokeWidth={1.6} aria-hidden="true" />}
            title="เลือกไฟล์ทิกเก็ตรายเดือน"
            body="ลากไฟล์มาวาง หรือกดเลือกไฟล์ · รองรับ .csv, .xlsx และ .xls · แอปจะจำรูปแบบคอลัมน์ไว้ใช้ครั้งหน้า"
            action={<button className="btn btn-lg btn-primary" onClick={choose}>เลือกไฟล์ (Ctrl+O)</button>}
          />
        </div>
      )}

      {preview && path && (
        <>
          <section className="card" aria-label="ไฟล์ที่เลือก" style={{ padding: "14px 18px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
            <span style={{ width: 40, height: 40, borderRadius: 10, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }} aria-hidden="true">
              <FileSpreadsheet size={22} strokeWidth={1.8} />
            </span>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 200 }}>
              <span style={{ fontWeight: 600 }}>{preview.fileName}</span>
              <span className="muted" style={{ fontSize: 13 }}>
                {preview.sheets.length > 1 ? "" : `ชีต ${preview.sheet} · `}{preview.headers.length} คอลัมน์ · {fmtInt(preview.rowCount)} แถว
              </span>
            </div>
            {preview.sheets.length > 1 && (
              <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <span className="field-label">ชีต</span>
                <select className="select sm" value={sheet ?? ""} onChange={(e) => load(path, e.target.value)}>
                  {preview.sheets.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            )}
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
            <div className="table-wrap" style={{ maxHeight: 460 }}>
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
              {summaryError && rolesReady && <div className="err-box">{summaryError}</div>}
              {summary?.dateAmbiguous && (
                <div className="warn-box" role="group" aria-label="รูปแบบวันที่">
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>วันที่ในไฟล์อ่านได้ทั้ง วัน/เดือน และ เดือน/วัน — ไฟล์นี้ใช้แบบไหน?</div>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                    <label className="check"><input type="radio" name="dord" checked={dateOrder === "dmy"} onChange={() => setDateOrder("dmy")} />วัน/เดือน/ปี (03/04 = 3 เม.ย.)</label>
                    <label className="check"><input type="radio" name="dord" checked={dateOrder === "mdy"} onChange={() => setDateOrder("mdy")} />เดือน/วัน/ปี (03/04 = 4 มี.ค.)</label>
                  </div>
                </div>
              )}
              <div className="form-grid">
                <div className="field">
                  <span className="field-hint">ช่วงข้อมูล (จากคอลัมน์วันที่)</span>
                  {!has("date") ? <span className="muted">ยังไม่ได้เลือกคอลัมน์วันที่</span>
                    : summary?.dateFrom && summary.dateTo
                      ? <span style={{ fontWeight: 600 }}>{thDateRange(summary.dateFrom, summary.dateTo)} · เดือน {summary.months.map((m) => thMonth(m)).join(", ")}</span>
                      : <span className="muted">—</span>}
                </div>
                <div className="field">
                  <span className="field-hint">ทิกเก็ตซ้ำกับที่มีในโปรเจกต์</span>
                  {!has("ticket") ? <span className="muted">ยังไม่ได้เลือกคอลัมน์เลขทิกเก็ต</span> : (
                    <span style={{ fontWeight: 600 }}>{fmtInt(summary?.duplicates ?? 0)} รายการ · {replace ? "จะแทนที่ของเดิม" : "จะข้าม ไม่นับซ้ำ"}</span>
                  )}
                  {!!summary?.duplicates && (
                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 2 }}>
                      <label className="check"><input type="radio" name="dup" checked={!replace} onChange={() => setReplace(false)} />ข้าม</label>
                      <label className="check"><input type="radio" name="dup" checked={replace} onChange={() => setReplace(true)} />แทนที่ของเดิม (ล้างผลจัดหมวดเดิม)</label>
                    </div>
                  )}
                </div>
              </div>
              {!!summary?.invalid && (
                <div className="field">
                  <span className="field-hint">แถวที่นำเข้าไม่ได้</span>
                  <span>
                    <span style={{ fontWeight: 600, color: "var(--warn-text)" }}>{fmtInt(summary.invalid)} แถว</span>{" "}
                    <button className="link-btn" style={{ fontSize: 13 }} onClick={() => setShowInvalid(!showInvalid)}>{showInvalid ? "ซ่อน" : "ดูรายการ"}</button>
                  </span>
                  {showInvalid && (
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, maxHeight: 140, overflowY: "auto" }}>
                      {summary.invalidRows.map((r) => <li key={r.row}>แถว {r.row}: {r.message}</li>)}
                      {summary.invalid > summary.invalidRows.length && <li className="muted">และอีก {fmtInt(summary.invalid - summary.invalidRows.length)} แถว</li>}
                    </ul>
                  )}
                </div>
              )}
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
                      : <span key={s.name} className="chip err" title="แถวเหล่านี้จะไม่ถูกส่งให้ AI">{s.name} · {fmtInt(s.count)} · ไม่มีหมวดหมู่</span>)}
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
            {!rolesReady && <span className="muted" style={{ fontSize: 13 }}>เลือกคอลัมน์ให้ครบทั้งสี่บทบาทก่อน จึงจะเริ่มได้</span>}
            {rolesReady && needsOrder && <span style={{ fontSize: 13, color: "var(--warn-text)" }}>เลือกรูปแบบวันที่ก่อน</span>}
            {ready && gatewayDown && <span style={{ fontSize: 13, color: "var(--err-text)" }}>ต่อ Gateway ไม่ได้ — ยังเริ่มจัดหมวดไม่ได้</span>}
            <button className="btn btn-lg" disabled={!ready || gatewayDown || busy} onClick={() => setTrial(true)}>ลองจัด 20 แถว</button>
            <button className="btn btn-lg btn-primary" disabled={!ready || gatewayDown || busy} onClick={start}>{busy ? "กำลังนำเข้า…" : "เริ่มจัดหมวด"}</button>
          </footer>
          {trial && (
            <TrialDialog projectId={project.id} path={path} sheet={sheet} roles={roles} dateOrder={dateOrder ?? summary?.dateOrder ?? null}
              onClose={() => setTrial(false)} onStart={() => { setTrial(false); start(); }} />
          )}
        </>
      )}
    </div>
  );
}
