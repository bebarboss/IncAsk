// ตั้งค่าโปรแกรม (SPEC §11.4 canvas 7) with the การใช้งาน section (canvas 8, pages/Usage.tsx).
// Gateway/model/theme/font save for real; backup arrives in step 10.
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { ConfigProjectDiff, GatewayInfo, UpdateInfo } from "../lib/types";
import { th } from "../i18n/th";
import { useApp, type AppSection } from "../state";
import { StatusPill } from "../components/StatusPill";
import { UpdateDialog } from "../components/UpdateDialog";
import { ConfirmDialog, Modal } from "../components/ui";
import { fmtInt, thDateTime } from "../lib/format";
import UsagePage from "./Usage";

const SECTIONS: [AppSection, string][] = [
  ["gateway", "Gateway และโมเดล"],
  ["usage", "การใช้งาน"],
  ["theme", "ธีม"],
  ["backup", "สำรองและนำเข้าคอนฟิก"],
  ["about", "เกี่ยวกับและอัปเดต"],
];

export default function AppSettingsPage({ section }: { section: AppSection }) {
  const { go } = useApp();
  return (
    <div className="page">
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h1 className="page-title">ตั้งค่าโปรแกรม</h1>
        <p className="muted">ใช้กับทุกโปรเจกต์ในเครื่องนี้</p>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="หมวดการตั้งค่า">
          {SECTIONS.map(([id, label]) => (
            <button key={id} aria-current={section === id ? "page" : undefined} onClick={() => go({ name: "app", section: id })}>{label}</button>
          ))}
        </nav>
        <div className="settings-main">
          {section === "usage" ? <UsagePage /> : (
            <>
              <GatewaySection highlight={section === "gateway"} />
              <ThemeSection />
              <BackupSection />
              <AboutSection />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GatewaySection({ highlight }: { highlight: boolean }) {
  const app = useApp();
  const [info, setInfo] = useState<GatewayInfo | null>(null);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getGateway().then((g) => { setInfo(g); setUrl(g.url); }).catch(() => {});
    api.gatewayModels().then(setModels).catch(() => setModels([]));
  }, []);
  const modelList = models.includes(app.settings.model) ? models : [app.settings.model, ...models];

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try { await fn(); } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  };
  const afterGatewayChange = async (g: GatewayInfo, text: string) => {
    setInfo(g);
    setUrl(g.url);
    await app.refreshSettings();
    setMsg({ ok: true, text });
    setModels(await api.gatewayModels().catch(() => models));
    app.recheckGateway();
  };
  const saveUrl = () => run(async () => afterGatewayChange(await api.setGatewayUrl(url), "บันทึก Gateway URL แล้ว — กดทดสอบอีกครั้ง"));
  const resetUrl = () => run(async () => afterGatewayChange(await api.resetGatewayUrl(), "กลับไปใช้ Gateway URL ค่าเริ่มต้นแล้ว"));
  const saveKey = () => run(async () => {
    const g = await api.saveApiKey(key);
    setKey(""); // the key lives in Credential Manager now, not in this page
    setEditingKey(false);
    await afterGatewayChange(g, "บันทึก API Key ใน Windows Credential Manager แล้ว");
  });
  const removeKey = async () => {
    setInfo(await api.removeApiKey());
    setConfirmRemove(false);
    setMsg({ ok: true, text: "ลบ API Key ออกจากเครื่องแล้ว" });
    app.recheckGateway();
  };
  const test = () => run(async () => {
    const r = await api.testGateway();
    await app.refreshSettings();
    setMsg(r.ok ? { ok: true, text: `เชื่อมต่อสำเร็จ · ${r.model} ตอบใน ${(r.elapsedMs / 1000).toFixed(1)} วิ` } : { ok: false, text: `${r.model}: ${r.error ?? "ทดสอบไม่ผ่าน"}` });
    app.recheckGateway();
  });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const last = app.settings.lastTestAt;

  return (
    <section className="card card-pad" aria-labelledby="gw-h" style={highlight ? { borderColor: "var(--ring)" } : undefined}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 id="gw-h">Gateway และโมเดล</h2>
        <StatusPill status={app.gateway} />
      </div>
      <div className="field">
        <label htmlFor="as-url">Gateway URL</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="as-url" className="input mono" type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn" disabled={busy || !url.trim() || url.trim() === info?.url} onClick={saveUrl}>{th.save}</button>
          {info && info.url !== info.defaultUrl && <button className="btn btn-ghost" disabled={busy} onClick={resetUrl}>ใช้ค่าเริ่มต้น</button>}
        </div>
      </div>
      <div className="field">
        <label htmlFor="as-key">API Key</label>
        <div style={{ display: "flex", gap: 8 }}>
          {editingKey ? (
            <input id="as-key" className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="sk-…" value={key} onChange={(e) => setKey(e.target.value)} />
          ) : (
            <input id="as-key" className="input mono" readOnly value={info?.hasKey ? `sk-••••••••${info.keyLast4 ?? ""}` : "ยังไม่ได้ใส่"} />
          )}
          {editingKey
            ? <button className="btn btn-primary" disabled={busy || !key.trim()} onClick={saveKey}>{th.save}</button>
            : <button className="btn" onClick={() => setEditingKey(true)}>{info?.hasKey ? "เปลี่ยน" : "ใส่ Key"}</button>}
          {editingKey && <button className="btn btn-ghost" onClick={() => { setEditingKey(false); setKey(""); }}>{th.cancel}</button>}
          {!editingKey && info?.hasKey && <button className="btn btn-danger" onClick={() => setConfirmRemove(true)}>ลบ Key</button>}
        </div>
        <span className="field-hint">เก็บใน Windows Credential Manager ของเครื่อง ไม่บันทึกเป็นไฟล์</span>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="as-model">โมเดลที่ใช้จัดหมวด</label>
          <select id="as-model" className="select mono" value={app.settings.model} onChange={(e) => app.updateSettings({ model: e.target.value })}>
            {modelList.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="as-conc">ส่งคำขอพร้อมกัน</label>
          <select id="as-conc" className="select" value={app.settings.concurrency} onChange={(e) => app.updateSettings({ concurrency: Number(e.target.value) as 4 | 8 | 16 })}>
            {[4, 8, 16].map((n) => <option key={n} value={n}>{n} คำขอ</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="as-batch">ทิกเก็ตต่อคำขอ (batch)</label>
          <input id="as-batch" className="input" type="number" min={1} max={25} value={app.settings.batchSize}
            onChange={(e) => app.updateSettings({ batchSize: Math.max(1, Math.min(25, Number(e.target.value) || 10)) })} />
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button className="btn" disabled={busy || (!api.mock && !info?.hasKey)} onClick={test}>{busy ? "กำลังทดสอบ…" : "ทดสอบการเชื่อมต่อ"}</button>
        {msg && (msg.ok
          ? <span className="ok-badge" role="status"><Check size={14} strokeWidth={3} aria-hidden="true" />{msg.text}</span>
          : <span role="alert" style={{ color: "var(--err-text)", fontSize: 13 }}>{msg.text}</span>)}
        {!msg && last != null && (
          <span className="muted" style={{ fontSize: 12 }}>
            ทดสอบล่าสุด {thDateTime(last)}{app.settings.lastTestModel ? ` · ${app.settings.lastTestModel}` : ""} · {app.settings.lastTestOk ? "✓ ผ่าน" : "ไม่ผ่าน"}
          </span>
        )}
      </div>
      {confirmRemove && (
        <ConfirmDialog
          title="ลบ API Key ออกจากเครื่อง?"
          body="Key จะถูกลบจาก Windows Credential Manager จัดหมวดใหม่ไม่ได้จนกว่าจะใส่ Key อีกครั้ง ผลลัพธ์และสรุปผลเดิมยังดูได้ตามปกติ"
          confirmLabel="ลบ Key"
          danger
          onCancel={() => setConfirmRemove(false)}
          onConfirm={removeKey}
        />
      )}
    </section>
  );
}

function ThemeSection() {
  const app = useApp();
  const themes = ["light", "dark", "system"] as const;
  const fonts = [["looped", "Plex Looped"], ["sarabun", "Sarabun"], ["plex", "Plex Sans Thai"], ["system", "ระบบ"]] as const;
  return (
    <section className="card card-pad" aria-labelledby="th-h">
      <h2 id="th-h">ธีม</h2>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span className="field-label" style={{ width: 80 }}>โหมดสี</span>
        <div className="seg-tabs" role="radiogroup" aria-label="โหมดสี">
          {themes.map((t) => <button key={t} role="radio" aria-checked={app.settings.theme === t} onClick={() => app.updateSettings({ theme: t })}>{th.theme[t]}</button>)}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span className="field-label" style={{ width: 80 }}>ฟอนต์</span>
        <div className="seg-tabs" role="radiogroup" aria-label="ฟอนต์">
          {fonts.map(([id, label]) => <button key={id} role="radio" aria-checked={app.settings.font === id} onClick={() => app.updateSettings({ font: id })}>{label}</button>)}
        </div>
      </div>
    </section>
  );
}

function BackupSection() {
  const app = useApp();
  const [scope, setScope] = useState<"current" | "all">(app.activeProject ? "current" : "all");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ path: string; diff: ConfigProjectDiff[] } | null>(null);
  const exportIt = async () => {
    setBusy(true);
    try {
      const name = scope === "current" && app.activeProject ? `incask-config_${app.activeProject.name}.json` : "incask-config.json";
      const path = await api.pickSavePath(name, [{ name: "คอนฟิก IncAsk", extensions: ["json"] }]);
      if (!path) return;
      const n = await api.exportConfig(scope === "current" && app.activeProject ? [app.activeProject.id] : null, path);
      app.toast(`✓ ส่งออกคอนฟิก ${n} โปรเจกต์แล้ว`);
    } catch (e) {
      app.toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const importIt = async () => {
    const path = await api.pickFile([{ name: "คอนฟิก IncAsk", extensions: ["json"] }]);
    if (!path) return;
    try {
      setReview({ path, diff: await api.configDiff(path) });
    } catch (e) {
      app.toast(errMsg(e));
    }
  };
  return (
    <section className="card card-pad" aria-labelledby="bk-h">
      <h2 id="bk-h">สำรองและนำเข้าคอนฟิก</h2>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>รวมเซอร์วิส หมวดหมู่ สี รูปแบบรีพอร์ต และมุมมองที่บันทึกไว้ในไฟล์เดียว ให้เพื่อนในทีมนำเข้าแล้วใช้ชุดเดียวกัน ไม่รวม API key, URL ของ Gateway, ทิกเก็ต และผลจัดหมวด</p>
      <div role="radiogroup" aria-label="ส่งออกคอนฟิกของ" style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <label className="check"><input type="radio" name="bk" checked={scope === "current"} disabled={!app.activeProject} onChange={() => setScope("current")} />เฉพาะ {app.activeProject?.name ?? "โปรเจกต์ที่เลือก"}</label>
        <label className="check"><input type="radio" name="bk" checked={scope === "all"} onChange={() => setScope("all")} />ทุกโปรเจกต์ ({app.projects.length})</label>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" disabled={busy} onClick={exportIt}>ส่งออกคอนฟิก</button>
        <button className="btn" onClick={importIt}>นำเข้าคอนฟิก…</button>
      </div>
      {review && <ConfigImportDialog path={review.path} diff={review.diff} onClose={() => setReview(null)} />}
    </section>
  );
}

function ConfigImportDialog({ path, diff, onClose }: { path: string; diff: ConfigProjectDiff[]; onClose: () => void }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const changed = diff.filter((d) => d.newProject || d.servicesAdded + d.servicesChanged + d.categoriesAdded + d.categoriesChanged + d.categoriesRemoved + d.patternsAdded + d.patternsChanged + d.viewsAdded + d.viewsChanged > 0);
  const affected = diff.reduce((a, d) => a + d.ticketsAffected, 0);
  const line = (n: number, word: string) => (n ? `${word} ${fmtInt(n)}` : null);
  const apply = async () => {
    setBusy(true);
    try {
      await api.configApply(path);
      await app.refreshProjects();
      app.toast(`✓ นำเข้าคอนฟิกแล้ว · ${changed.length} โปรเจกต์`);
      onClose();
    } catch (e) {
      app.toast(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="นำเข้าคอนฟิก" subtitle={path.split(/[\\/]/).pop()} onClose={onClose} width={600}>
      {changed.length === 0 ? <div className="ok-badge" style={{ alignSelf: "flex-start" }}><Check size={14} strokeWidth={3} aria-hidden="true" />ทุกอย่างตรงกับในเครื่องอยู่แล้ว</div> : (
        <div className="kv">
          {changed.map((d) => (
            <div key={d.name} style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
              <span style={{ fontWeight: 600 }}>{d.name}{d.newProject ? <span className="chip" style={{ marginLeft: 8 }}>โปรเจกต์ใหม่</span> : null}</span>
              <span className="muted" style={{ fontSize: 13 }}>
                {[line(d.servicesAdded, "เพิ่มเซอร์วิส"), line(d.servicesChanged, "แก้เซอร์วิส"), line(d.categoriesAdded, "เพิ่มหมวด"), line(d.categoriesChanged, "แก้หมวด"), line(d.categoriesRemoved, "ลบหมวด"),
                  line(d.patternsAdded + d.patternsChanged, "รูปแบบรีพอร์ต"), line(d.viewsAdded + d.viewsChanged, "มุมมอง")].filter(Boolean).join(" · ")}
              </span>
            </div>
          ))}
        </div>
      )}
      {affected > 0 && <div className="warn-box">หมวดที่ถูกลบมีทิกเก็ตใช้อยู่ {fmtInt(affected)} รายการ — ทิกเก็ตเหล่านั้นจะกลับเป็น "รอจัด" และถูกจัดใหม่ในครั้งถัดไป</div>}
      <span className="field-hint">เซอร์วิส รูปแบบรีพอร์ต และมุมมองที่มีแค่ในเครื่องนี้จะไม่ถูกลบ</span>
      <div className="modal-actions">
        <button className="btn btn-lg" onClick={onClose}>{th.cancel}</button>
        <button className="btn btn-lg btn-primary" disabled={busy || changed.length === 0} onClick={apply}>ยืนยันนำเข้า</button>
      </div>
    </Modal>
  );
}

function AboutSection() {
  const app = useApp();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  const check = async () => {
    setState(null);
    try {
      const u = await api.checkUpdate();
      if (u.available) setUpdate(u);
      else setState({ ok: true, text: "เป็นเวอร์ชันล่าสุด" });
    } catch (e) {
      setState({ ok: false, text: errMsg(e) });
    }
  };
  return (
    <section className="card card-pad" aria-labelledby="ab-h">
      <h2 id="ab-h">เกี่ยวกับและอัปเดต</h2>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 600 }}>IncAsk เวอร์ชัน {app.info?.version}</span>
          {state && (state.ok
            ? <span style={{ fontSize: 13, color: "var(--ok-text)" }}>✓ {state.text}</span>
            : <span style={{ fontSize: 13, color: "var(--err-text)" }}>{state.text}</span>)}
          <span className="muted mono" style={{ fontSize: 12 }}>{app.info?.dataDir}</span>
        </div>
        <button className="btn" onClick={check}>ตรวจหาอัปเดต</button>
      </div>
      <label className="check">
        <input type="checkbox" checked={app.settings.autoCheckUpdate} onChange={(e) => app.updateSettings({ autoCheckUpdate: e.target.checked })} />
        ตรวจหาเวอร์ชันใหม่อัตโนมัติเมื่อเปิดแอป
      </label>
      {update && <UpdateDialog info={update} onClose={() => setUpdate(null)} />}
    </section>
  );
}
