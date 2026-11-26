// ผลลัพธ์ (SPEC §8, canvas 3). Step 1: paged table on mock data with the top filters.
// TanStack Table/Virtual, column settings, category editing and bulk edit arrive in step 7.
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Search } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { Project, ResultsPage, Service } from "../lib/types";
import { fmtInt, thDate, thMonth } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { ErrorState, SkeletonList } from "../components/ui";

const PAGE = 50;

export default function ResultsPageView({ project }: { project: Project }) {
  const app = useApp();
  const [services, setServices] = useState<Service[]>([]);
  const [months, setMonths] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [service, setService] = useState("");
  const [month, setMonth] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [errorOnly, setErrorOnly] = useState(false);
  const [dense, setDense] = useState(false);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ResultsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listServices(project.id).then(setServices).catch(() => {});
    api.projectMonths(project.id).then(setMonths).catch(() => {});
  }, [project.id]);

  useEffect(() => { setOffset(0); }, [search, service, month, lowOnly, errorOnly]);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api.queryResults(project.id, { search, service: service || undefined, month: month || undefined, lowOnly, errorOnly, offset, limit: PAGE })
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e) => alive && setError(errMsg(e)));
    }, search ? 200 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [project.id, search, service, month, lowOnly, errorOnly, offset]);

  // category columns merged from every service (empty where a service doesn't use one)
  const catCols = useMemo(() => [...new Set(services.flatMap((s) => s.columns))], [services]);
  const pad = dense ? "5px 12px" : undefined;

  return (
    <div className="page">
      <header className="page-head">
        <div className="l">
          <h1 className="page-title">ผลลัพธ์</h1>
          <p className="muted">
            {data ? `${month ? thMonth(month) : "ทุกเดือน"} · ${fmtInt(data.total)} ทิกเก็ต · ${fmtInt(data.lowCount)} รายการที่ AI ไม่มั่นใจ` : " "}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => app.setExportOpen(true)}><Download size={16} strokeWidth={2} aria-hidden="true" />{th.export}</button>
      </header>

      <div className="toolbar" role="toolbar" aria-label="ตัวกรองตาราง">
        <label style={{ position: "relative", flex: "1 1 260px", maxWidth: 360 }}>
          <span className="sr-only">ค้นหา</span>
          <Search size={16} strokeWidth={1.8} aria-hidden="true" style={{ position: "absolute", left: 10, top: 11, color: "var(--muted)" }} />
          <input className="input" type="search" style={{ paddingLeft: 34, minHeight: 38 }} placeholder="ค้นหาเลขทิกเก็ตหรือข้อความ" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <select className="select sm" aria-label="เซอร์วิส" value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">ทุกเซอร์วิส</option>
          {services.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
        </select>
        <select className="select sm" aria-label="เดือน" value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">ทุกเดือน</option>
          {months.map((m) => <option key={m} value={m}>{thMonth(m)}</option>)}
        </select>
        <button className="btn" aria-pressed={lowOnly} onClick={() => setLowOnly(!lowOnly)}>
          <span className="dot" style={{ background: "var(--role-service)" }} aria-hidden="true" />เฉพาะที่ไม่มั่นใจ
        </button>
        <button className="btn" aria-pressed={errorOnly} onClick={() => setErrorOnly(!errorOnly)}>
          <span className="dot" style={{ background: "var(--err-text)" }} aria-hidden="true" />เฉพาะที่ผิดพลาด
        </button>
        <span className="spacer" />
        <button className="btn" aria-pressed={dense} onClick={() => setDense(!dense)}>{dense ? "แบบแน่น" : "แบบปกติ"}</button>
        <button className="btn" onClick={() => app.toast("ตั้งค่าคอลัมน์ — ทำในขั้นที่ 7")}>คอลัมน์</button>
      </div>

      {error && <ErrorState message={error} />}
      {!data && !error && <SkeletonList rows={6} h={40} />}
      {data && (
        <section className="card" aria-label="ตารางผลลัพธ์" style={{ overflow: "hidden" }}>
          <div className="table-wrap" style={{ maxHeight: "calc(100vh - 330px)", minHeight: 240 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col" className="pin">เลขทิกเก็ต</th>
                  <th scope="col">วันที่</th>
                  <th scope="col">เซอร์วิส</th>
                  <th scope="col">ข้อความปัญหา</th>
                  {catCols.map((c) => <th key={c} scope="col">{c}</th>)}
                  <th scope="col" className="r">ความมั่นใจ</th>
                  <th scope="col">ที่มา</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td colSpan={6 + catCols.length} className="muted" style={{ padding: 24, textAlign: "center" }}>ไม่พบทิกเก็ตตามตัวกรองนี้</td></tr>
                )}
                {data.rows.map((r) => {
                  const low = r.confidence != null && r.confidence < 0.7 && r.source !== "human";
                  return (
                    <tr key={r.id} className={r.source === "error" ? "row-err" : low ? "row-low" : undefined}>
                      <td className="pin mono" style={{ padding: pad, fontSize: 12.5 }}>{r.ticketNo}</td>
                      <td style={{ padding: pad, whiteSpace: "nowrap" }}>{thDate(r.date)}</td>
                      <td style={{ padding: pad }}><span className="tag">{r.service}</span></td>
                      <td style={{ padding: pad, minWidth: 280, maxWidth: 420 }}><span className="ellipsis" style={{ display: "block" }} title={r.problemText}>{r.problemText}</span></td>
                      {catCols.map((c) => (
                        <td key={c} style={{ padding: pad, whiteSpace: "nowrap" }}>
                          {r.fields[c] ? <button className="cat-btn" onClick={() => app.toast("แก้หมวด — ทำในขั้นที่ 7")}>{r.fields[c]}</button> : <span className="muted">—</span>}
                        </td>
                      ))}
                      <td className="r" style={{ padding: pad, whiteSpace: "nowrap" }}>
                        {r.confidence == null ? <span className="muted">—</span> : low
                          ? <span style={{ color: "var(--warn-text)", fontWeight: 600 }}>ต่ำ · {Math.round(r.confidence * 100)}%</span>
                          : `${Math.round(r.confidence * 100)}%`}
                      </td>
                      <td style={{ padding: pad }}>
                        <span className={`chip ${r.source === "human" ? "" : r.source === "error" || r.source === "unknown_service" ? "err" : "neutral"}`}>{th.source[r.source]}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderTop: "1px solid var(--border)", fontSize: 13 }}>
            <span className="muted">แสดง {data.total ? `${fmtInt(offset + 1)}–${fmtInt(Math.min(offset + PAGE, data.total))}` : "0"} จาก {fmtInt(data.total)}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn" aria-label="หน้าก่อน" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}><ChevronLeft size={16} strokeWidth={2} /></button>
              <button className="btn" aria-label="หน้าถัดไป" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}><ChevronRight size={16} strokeWidth={2} /></button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
