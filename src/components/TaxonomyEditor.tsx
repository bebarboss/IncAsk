// ตั้งค่าโปรเจกต์ › เซอร์วิสและหมวดหมู่ (SPEC §7, canvas 5): service list on the left, the selected
// service's category table on the right, editable in place.
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { Project, RowInput, Service, TaxonomyRow } from "../lib/types";
import { SERVICE_COLORS, SERVICE_COLOR_NAMES } from "../lib/gateway";
import { fmtInt } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { EmptyState, ErrorState, Modal, SkeletonList } from "./ui";
import { TaxonomyImportDialog, downloadTemplate } from "./TaxonomyImportDialog";

const DEFAULT_COLUMNS = ["หัวข้อหลัก", "หัวข้อย่อย"];

export function TaxonomyEditor({ project }: { project: Project }) {
  const app = useApp();
  const [services, setServices] = useState<Service[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [rows, setRows] = useState<TaxonomyRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "add" | "rename" | "columns" | "import" | "deleteService">(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [deleting, setDeleting] = useState<TaxonomyRow | null>(null);

  const loadServices = useCallback(async (select?: string) => {
    try {
      const s = await api.listServices(project.id);
      setServices(s);
      setSel((cur) => select ?? (cur && s.some((x) => x.id === cur) ? cur : s[0]?.id ?? null));
      const pairs = await Promise.all(s.map((x) => api.listTaxonomy(project.id, x.id).then((r) => [x.id, r.length] as const)));
      setCounts(Object.fromEntries(pairs));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [project.id]);
  const loadRows = useCallback(async () => {
    if (!sel) { setRows(null); return; }
    try {
      const r = await api.listTaxonomy(project.id, sel);
      setRows(r);
      setCounts((c) => ({ ...c, [sel]: r.length }));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [project.id, sel]);
  useEffect(() => { loadServices(); }, [loadServices]);
  useEffect(() => { setRows(null); setEditing(null); loadRows(); }, [loadRows]);

  const svc = services?.find((s) => s.id === sel) ?? null;
  const recolor = async (c: string) => {
    if (!svc) return;
    try { await api.updateService(project.id, svc.id, { color: c }); await loadServices(); } catch (e) { app.toast(errMsg(e)); }
  };

  if (error) return <ErrorState message={error} onRetry={() => { setError(null); loadServices(); }} />;
  if (!services) return <SkeletonList rows={4} />;

  const dialogs = (
    <>
      {dialog === "add" && <ServiceDialog projectId={project.id} onClose={() => setDialog(null)} onSaved={(s) => loadServices(s.id)} />}
      {dialog === "rename" && svc && <ServiceDialog projectId={project.id} service={svc} onClose={() => setDialog(null)} onSaved={() => loadServices()} />}
      {dialog === "columns" && svc && <ColumnsDialog projectId={project.id} service={svc} onClose={() => setDialog(null)} onSaved={() => { loadServices(); loadRows(); }} />}
      {dialog === "import" && (
        <TaxonomyImportDialog projectId={project.id} service={svc} onClose={() => setDialog(null)} onDone={(done) => { loadServices(done[0]?.id); }} />
      )}
      {dialog === "deleteService" && svc && (
        <Modal title={`ลบเซอร์วิส ${svc.name}?`} onClose={() => setDialog(null)} width={460}>
          <p style={{ lineHeight: 1.7, color: "var(--text-2)" }}>หมวดหมู่ {fmtInt(counts[svc.id] ?? 0)} หมวดของเซอร์วิสนี้จะถูกลบ ทิกเก็ตเดิมยังอยู่ แต่จะขึ้นเป็น "ไม่มีหมวดหมู่" และไม่ถูกส่งให้ AI จนกว่าจะเพิ่มเซอร์วิสชื่อเดิมกลับมา</p>
          <div className="modal-actions">
            <button className="btn btn-lg" onClick={() => setDialog(null)}>{th.cancel}</button>
            <button className="btn btn-lg btn-danger-solid" onClick={async () => { await api.deleteService(project.id, svc.id); setDialog(null); setSel(null); loadServices(); }}>ลบเซอร์วิส</button>
          </div>
        </Modal>
      )}
      {deleting && rows && svc && (
        <DeleteRowDialog projectId={project.id} row={deleting} rows={rows} service={svc} onClose={() => setDeleting(null)} onDone={loadRows} />
      )}
    </>
  );

  if (services.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={<Upload size={34} strokeWidth={1.6} aria-hidden="true" />}
          title="ยังไม่มีเซอร์วิส"
          body="เพิ่มเซอร์วิสแล้วนำเข้าตารางหมวดหมู่จาก Excel เพื่อให้ AI เลือกหมวดได้"
          action={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              <button className="btn btn-lg btn-primary" onClick={() => setDialog("import")}>นำเข้าจาก Excel</button>
              <button className="btn btn-lg" onClick={() => setDialog("add")}>+ เพิ่มเซอร์วิสเอง</button>
              <button className="btn btn-lg btn-ghost" onClick={() => downloadTemplate(app.toast)}>ดาวน์โหลดเทมเพลต</button>
            </div>
          }
        />
        {dialogs}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 240px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
      <section className="card" aria-labelledby="svc-h" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 6px 8px" }}>
          <h2 id="svc-h">เซอร์วิส</h2>
          <button className="btn" onClick={() => setDialog("add")}>+ เพิ่ม</button>
        </div>
        {services.map((s) => (
          <button key={s.id} className="svc-btn" aria-pressed={s.id === sel} onClick={() => setSel(s.id)}>
            <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
            <span style={{ flex: 1 }} className="ellipsis">{s.name}</span>
            <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{counts[s.id] ?? "…"} หัวข้อ</span>
          </button>
        ))}
      </section>
      {svc && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <section className="card" aria-labelledby="tax-h" style={{ overflow: "hidden" }}>
            <div className="card-head">
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <h2 id="tax-h">หมวดหมู่ของ {svc.name}</h2>
                  <button className="icon-btn" aria-label={`เปลี่ยนชื่อเซอร์วิส ${svc.name}`} onClick={() => setDialog("rename")}><Pencil size={15} strokeWidth={1.8} /></button>
                  <button className="icon-btn" aria-label={`ลบเซอร์วิส ${svc.name}`} onClick={() => setDialog("deleteService")} style={{ color: "var(--err-text)" }}><Trash2 size={15} strokeWidth={1.8} /></button>
                </div>
                <span className="muted" style={{ fontSize: 12 }}>คอลัมน์ที่กำหนดเอง: {[...svc.columns, "คำอธิบาย", "ตัวอย่าง"].join(" · ")}</span>
              </div>
              <div className="toolbar">
                <button className="btn" onClick={() => setDialog("columns")}>จัดการคอลัมน์</button>
                <button className="btn" onClick={() => downloadTemplate(app.toast)}>ดาวน์โหลดเทมเพลต</button>
                <button className="btn" onClick={() => setDialog("import")}><Upload size={15} strokeWidth={1.9} aria-hidden="true" />นำเข้าจาก Excel</button>
                <button className="btn btn-primary" disabled={editing === "new"} onClick={() => setEditing("new")}><Plus size={15} strokeWidth={2} aria-hidden="true" />เพิ่มหัวข้อ</button>
              </div>
            </div>
            {!rows ? <div style={{ padding: 16 }}><SkeletonList rows={4} h={36} /></div> : (
              <div className="table-wrap" style={{ maxHeight: "calc(100vh - 360px)", minHeight: 160 }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: 56 }}>code</th>
                      {svc.columns.map((c) => <th key={c} scope="col">{c}</th>)}
                      <th scope="col">คำอธิบาย (AI ใช้ตัดสินใจ)</th>
                      <th scope="col">ตัวอย่าง</th>
                      <th scope="col" style={{ width: 84 }}><span className="sr-only">จัดการ</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && editing !== "new" && (
                      <tr><td colSpan={svc.columns.length + 4} className="muted" style={{ padding: 20, textAlign: "center" }}>ยังไม่มีหมวด — กด "เพิ่มหัวข้อ" หรือนำเข้าจาก Excel</td></tr>
                    )}
                    {rows.map((r) => editing === r.id ? (
                      <RowEditor key={r.id} projectId={project.id} service={svc} row={r} onDone={(saved) => { setEditing(null); if (saved) loadRows(); }} />
                    ) : (
                      <tr key={r.id}>
                        <td className="mono muted" style={{ fontSize: 12 }}>{r.code}</td>
                        {svc.columns.map((c) => <td key={c}>{r.values[c] || <span className="muted">—</span>}</td>)}
                        <td style={{ color: r.description ? "var(--text-2)" : "var(--warn-text)" }}>{r.description || "ยังไม่มีคำอธิบาย"}</td>
                        <td className="muted">{r.examples}</td>
                        <td style={{ whiteSpace: "nowrap", padding: "2px 6px" }}>
                          <button className="icon-btn" aria-label={`แก้ไข ${r.code}`} onClick={() => setEditing(r.id)}><Pencil size={15} strokeWidth={1.8} /></button>
                          <button className="icon-btn" aria-label={`ลบ ${r.code}`} onClick={() => setDeleting(r)}><Trash2 size={15} strokeWidth={1.8} /></button>
                        </td>
                      </tr>
                    ))}
                    {editing === "new" && <RowEditor projectId={project.id} service={svc} row={null} onDone={(saved) => { setEditing(null); if (saved) loadRows(); }} />}
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
            <div className="color-swatches" role="radiogroup" aria-label={`สีประจำ ${svc.name}`}>
              {SERVICE_COLORS.map((c) => (
                <button key={c} role="radio" style={{ background: c }} aria-label={SERVICE_COLOR_NAMES[c]} aria-checked={c === svc.color.toUpperCase()} aria-pressed={c === svc.color.toUpperCase()} onClick={() => recolor(c)} />
              ))}
            </div>
          </section>
        </div>
      )}
      {dialogs}
    </div>
  );
}

function RowEditor({ projectId, service, row, onDone }: { projectId: string; service: Service; row: TaxonomyRow | null; onDone: (saved: boolean) => void }) {
  const [v, setV] = useState<RowInput>({ id: row?.id ?? null, values: { ...(row?.values ?? {}) }, description: row?.description ?? "", examples: row?.examples ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveTaxonomyRow(projectId, service.id, v);
      onDone(true);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.preventDefault(); onDone(false); }
  };
  return (
    <>
      <tr style={{ background: "var(--accent-soft)" }} onKeyDown={key}>
        <td className="mono muted" style={{ fontSize: 12 }}>{row?.code ?? "ใหม่"}</td>
        {service.columns.map((c, i) => (
          <td key={c} style={{ padding: 4 }}>
            <input className="input" style={{ minHeight: 34, padding: "4px 8px", fontSize: 13 }} aria-label={c} autoFocus={i === 0}
              value={v.values[c] ?? ""} onChange={(e) => setV({ ...v, values: { ...v.values, [c]: e.target.value } })} />
          </td>
        ))}
        <td style={{ padding: 4 }}>
          <input className="input" style={{ minHeight: 34, padding: "4px 8px", fontSize: 13 }} aria-label="คำอธิบาย" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        </td>
        <td style={{ padding: 4 }}>
          <input className="input" style={{ minHeight: 34, padding: "4px 8px", fontSize: 13 }} aria-label="ตัวอย่าง" value={v.examples} onChange={(e) => setV({ ...v, examples: e.target.value })} />
        </td>
        <td style={{ whiteSpace: "nowrap", padding: "2px 6px" }}>
          <button className="icon-btn" aria-label={th.save} disabled={busy} onClick={save} style={{ color: "var(--accent)" }}><Check size={17} strokeWidth={2.4} /></button>
          <button className="icon-btn" aria-label={th.cancel} onClick={() => onDone(false)}><X size={17} strokeWidth={2} /></button>
        </td>
      </tr>
      {error && (
        <tr><td colSpan={service.columns.length + 4} style={{ padding: "4px 12px", background: "var(--err-bg)", color: "var(--err-text)", fontSize: 12 }} role="alert">{error}</td></tr>
      )}
    </>
  );
}

function ServiceDialog({ projectId, service, onClose, onSaved }: { projectId: string; service?: Service; onClose: () => void; onSaved: (s: Service) => void }) {
  const [name, setName] = useState(service?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const s = service ? await api.updateService(projectId, service.id, { name }) : await api.createService(projectId, name, DEFAULT_COLUMNS);
      onSaved(s);
      onClose();
    } catch (err) {
      setError(errMsg(err));
    }
  };
  return (
    <Modal title={service ? "เปลี่ยนชื่อเซอร์วิส" : "เพิ่มเซอร์วิส"} onClose={onClose} width={440}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="field">
          <label htmlFor="svc-name">ชื่อเซอร์วิส</label>
          <input id="svc-name" className="input lg" value={name} placeholder="เช่น Internet, IPTV" onChange={(e) => setName(e.target.value)} />
          <span className="field-hint">ต้องตรงกับค่าในคอลัมน์เซอร์วิสของไฟล์ทิกเก็ต{service ? " · ทิกเก็ตเดิมของเซอร์วิสนี้จะเปลี่ยนชื่อตาม" : " · เริ่มด้วยคอลัมน์ หัวข้อหลัก · หัวข้อย่อย ปรับได้ใน จัดการคอลัมน์"}</span>
        </div>
        {error && <div className="err-box" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-lg" onClick={onClose}>{th.cancel}</button>
          <button type="submit" className="btn btn-lg btn-primary" disabled={!name.trim()}>{th.save}</button>
        </div>
      </form>
    </Modal>
  );
}

function ColumnsDialog({ projectId, service, onClose, onSaved }: { projectId: string; service: Service; onClose: () => void; onSaved: () => void }) {
  const [cols, setCols] = useState(service.columns.map((c) => ({ from: c as string | null, name: c })));
  const [error, setError] = useState<string | null>(null);
  const move = (i: number, d: number) => {
    const n = [...cols];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    setCols(n);
  };
  const removed = service.columns.filter((c) => !cols.some((x) => x.from === c));
  const save = async () => {
    try {
      await api.setServiceColumns(projectId, service.id, cols);
      onSaved();
      onClose();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  return (
    <Modal title={`จัดการคอลัมน์ · ${service.name}`} subtitle="ลำดับคอลัมน์ = ลำดับชั้นของหมวด (ซ้ายคือชั้นบนสุด) · คำอธิบาย และ ตัวอย่าง มีเสมอ" onClose={onClose} width={520}>
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {cols.map((c, i) => (
          <li key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className="muted" style={{ width: 20, textAlign: "right", fontSize: 12 }}>{i + 1}</span>
            <input className="input" aria-label={`ชื่อคอลัมน์ที่ ${i + 1}`} value={c.name} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <button className="icon-btn" aria-label="เลื่อนขึ้น" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={16} strokeWidth={1.8} /></button>
            <button className="icon-btn" aria-label="เลื่อนลง" disabled={i === cols.length - 1} onClick={() => move(i, 1)}><ArrowDown size={16} strokeWidth={1.8} /></button>
            <button className="icon-btn" aria-label={`ลบคอลัมน์ ${c.name}`} disabled={cols.length <= 1} onClick={() => setCols(cols.filter((_, j) => j !== i))}><Trash2 size={16} strokeWidth={1.8} /></button>
          </li>
        ))}
      </ol>
      <div><button className="btn" onClick={() => setCols([...cols, { from: null, name: "" }])}>+ เพิ่มคอลัมน์</button></div>
      {removed.length > 0 && <div className="warn-box">ค่าในคอลัมน์ {removed.join(", ")} ของทุกหมวดจะหายไป</div>}
      {cols.some((c) => c.from === null) && <div className="info-box">คอลัมน์ใหม่จะว่างในทุกหมวด — แก้ทีละแถวหรือนำเข้าจาก Excel ใหม่</div>}
      {error && <div className="err-box" role="alert">{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-lg" onClick={onClose}>{th.cancel}</button>
        <button className="btn btn-lg btn-primary" onClick={save}>{th.save}</button>
      </div>
    </Modal>
  );
}

function DeleteRowDialog({ projectId, row, rows, service, onClose, onDone }: {
  projectId: string; row: TaxonomyRow; rows: TaxonomyRow[]; service: Service; onClose: () => void; onDone: () => void;
}) {
  const app = useApp();
  const [usage, setUsage] = useState<number | null>(null);
  const [mode, setMode] = useState<"reclassify" | "move">("reclassify");
  const [target, setTarget] = useState<string>("");
  const others = rows.filter((r) => r.id !== row.id);
  useEffect(() => { api.taxonomyRowUsage(projectId, row.id).then(setUsage).catch(() => setUsage(0)); }, [projectId, row.id]);
  const label = (r: TaxonomyRow) => `${r.code} · ${service.columns.map((c) => r.values[c]).filter(Boolean).join(" › ")}`;
  const del = async () => {
    try {
      const n = await api.deleteTaxonomyRow(projectId, row.id, mode === "move" && target ? target : null);
      app.toast(n ? `ลบหมวดแล้ว · ${mode === "move" ? "ย้าย" : "รอจัดใหม่"} ${fmtInt(n)} ทิกเก็ต` : "ลบหมวดแล้ว");
      onDone();
      onClose();
    } catch (e) {
      app.toast(errMsg(e));
    }
  };
  return (
    <Modal title={`ลบหมวด ${label(row)}?`} onClose={onClose} width={520}>
      {usage === null ? <SkeletonList rows={1} h={40} /> : usage === 0 ? (
        <p className="muted">ยังไม่มีทิกเก็ตอยู่ในหมวดนี้</p>
      ) : (
        <>
          <div className="warn-box">มีทิกเก็ต {fmtInt(usage)} รายการอยู่ในหมวดนี้ เลือกว่าจะทำอย่างไรกับทิกเก็ตเหล่านั้น</div>
          <div role="radiogroup" aria-label="ทิกเก็ตในหมวดนี้" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label className="check"><input type="radio" name="del-mode" checked={mode === "reclassify"} onChange={() => setMode("reclassify")} />จัดทิกเก็ตเหล่านั้นใหม่ (ล้างผลเดิม ให้ AI จัดอีกครั้งตอนกดทำต่อ)</label>
            <label className="check"><input type="radio" name="del-mode" checked={mode === "move"} disabled={!others.length} onChange={() => setMode("move")} />ย้ายไปหมวด…</label>
            {mode === "move" && (
              <select className="select" aria-label="ย้ายไปหมวด" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">เลือกหมวด</option>
                {others.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
              </select>
            )}
          </div>
        </>
      )}
      <div className="modal-actions">
        <button className="btn btn-lg" onClick={onClose}>{th.cancel}</button>
        <button className="btn btn-lg btn-danger-solid" disabled={usage === null || (mode === "move" && !target && !!usage)} onClick={del}>ลบหมวด</button>
      </div>
    </Modal>
  );
}
