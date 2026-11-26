// ตั้งค่าโปรเจกต์ (SPEC §7, canvas 5). Step 1: sub-menu, service list, read-only taxonomy table,
// service colour picker. Editing, column management, Excel import/template arrive in step 4.
import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { Project, Service, TaxonomyRow } from "../lib/types";
import { SERVICE_COLORS, SERVICE_COLOR_NAMES } from "../lib/gateway";
import { useApp } from "../state";
import { EmptyState, ErrorState, SkeletonList } from "../components/ui";

type Section = "taxonomy" | "patterns" | "columns" | "display" | "share";
const SECTIONS: [Section, string][] = [
  ["taxonomy", "เซอร์วิสและหมวดหมู่"],
  ["patterns", "รูปแบบรีพอร์ต"],
  ["columns", "คอลัมน์ผลลัพธ์"],
  ["display", "สีและการแสดงผล"],
  ["share", "ชื่อและการแชร์โปรเจกต์"],
];

export default function ProjectSettingsPage({ project }: { project: Project }) {
  const app = useApp();
  const [section, setSection] = useState<Section>("taxonomy");
  const [services, setServices] = useState<Service[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [rows, setRows] = useState<TaxonomyRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api.listServices(project.id).then((s) => {
      setServices(s);
      setSel((cur) => cur ?? s[0]?.id ?? null);
      Promise.all(s.map((x) => api.listTaxonomy(project.id, x.id).then((r) => [x.id, r.length] as const)))
        .then((pairs) => setCounts(Object.fromEntries(pairs))).catch(() => {});
    }).catch((e) => setError(errMsg(e)));
  };
  useEffect(load, [project.id]);
  useEffect(() => {
    if (!sel) return;
    setRows(null);
    api.listTaxonomy(project.id, sel).then(setRows).catch((e) => setError(errMsg(e)));
  }, [project.id, sel]);

  const svc = services?.find((s) => s.id === sel) ?? null;
  const later = (what: string) => () => app.toast(`${what} — ทำในขั้นที่ 4`);

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
          {error && <ErrorState message={error} onRetry={load} />}
          {section !== "taxonomy" && (
            <div className="card"><EmptyState title={SECTIONS.find(([id]) => id === section)![1]} body="ส่วนนี้จะทำในขั้นถัดไปตาม SPEC ข้อ 17" /></div>
          )}
          {section === "taxonomy" && !services && !error && <SkeletonList rows={4} />}
          {section === "taxonomy" && services && services.length === 0 && (
            <div className="card">
              <EmptyState
                icon={<Upload size={34} strokeWidth={1.6} aria-hidden="true" />}
                title="ยังไม่มีเซอร์วิส"
                body="เพิ่มเซอร์วิสแล้วนำเข้าตารางหมวดหมู่จาก Excel เพื่อให้ AI เลือกหมวดได้"
                action={<button className="btn btn-lg btn-primary" onClick={later("นำเข้าหมวดหมู่")}>นำเข้าจาก Excel</button>}
              />
            </div>
          )}
          {section === "taxonomy" && services && services.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 240px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
              <section className="card" aria-labelledby="svc-h" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 6px 8px" }}>
                  <h2 id="svc-h">เซอร์วิส</h2>
                  <button className="btn" onClick={later("เพิ่มเซอร์วิส")}>+ เพิ่ม</button>
                </div>
                {services.map((s) => (
                  <button key={s.id} className="svc-btn" aria-pressed={s.id === sel} onClick={() => setSel(s.id)}>
                    <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
                    <span style={{ flex: 1 }}>{s.name}</span>
                    <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{counts[s.id] ?? "…"} หัวข้อ</span>
                  </button>
                ))}
              </section>
              {svc && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
                  <section className="card" aria-labelledby="tax-h" style={{ overflow: "hidden" }}>
                    <div className="card-head">
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <h2 id="tax-h">หมวดหมู่ของ {svc.name}</h2>
                        <span className="muted" style={{ fontSize: 12 }}>คอลัมน์ที่กำหนดเอง: {[...svc.columns, "คำอธิบาย", "ตัวอย่าง"].join(" · ")}</span>
                      </div>
                      <div className="toolbar">
                        <button className="btn" onClick={later("จัดการคอลัมน์")}>จัดการคอลัมน์</button>
                        <button className="btn" onClick={later("ดาวน์โหลดเทมเพลต")}>ดาวน์โหลดเทมเพลต</button>
                        <button className="btn" onClick={later("นำเข้าจาก Excel")}><Upload size={15} strokeWidth={1.9} aria-hidden="true" />นำเข้าจาก Excel</button>
                        <button className="btn btn-primary" onClick={later("เพิ่มหัวข้อ")}>+ เพิ่มหัวข้อ</button>
                      </div>
                    </div>
                    {!rows ? <div style={{ padding: 16 }}><SkeletonList rows={4} h={36} /></div> : (
                      <div className="table-wrap">
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th scope="col" style={{ width: 56 }}>code</th>
                              {svc.columns.map((c) => <th key={c} scope="col">{c}</th>)}
                              <th scope="col">คำอธิบาย (AI ใช้ตัดสินใจ)</th>
                              <th scope="col">ตัวอย่าง</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r.id}>
                                <td className="mono muted" style={{ fontSize: 12 }}>{r.code}</td>
                                {svc.columns.map((c) => <td key={c}>{r.values[c]}</td>)}
                                <td style={{ color: r.description ? "var(--text-2)" : "var(--warn-text)" }}>{r.description || "ยังไม่มีคำอธิบาย"}</td>
                                <td className="muted">{r.examples}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                  <section className="card card-pad" aria-labelledby="color-h">
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <h2 id="color-h">สีประจำ {svc.name}</h2>
                      <span className="muted" style={{ fontSize: 13 }}>ใช้ในกราฟและ pivot ทุกที่ และติดไปกับไฟล์ .incask และรายงาน HTML</span>
                    </div>
                    <div className="color-swatches">
                      {SERVICE_COLORS.map((c) => (
                        <button
                          key={c}
                          style={{ background: c }}
                          aria-label={`${SERVICE_COLOR_NAMES[c]}${c === svc.color ? " (เลือกอยู่)" : ""}`}
                          aria-pressed={c === svc.color}
                          onClick={later("เปลี่ยนสีเซอร์วิส")}
                        />
                      ))}
                    </div>
                  </section>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
