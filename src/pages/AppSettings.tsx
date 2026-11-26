// ตั้งค่าโปรแกรม (SPEC §11.4 canvas 7) with the การใช้งาน section (canvas 8, pages/Usage.tsx).
// Gateway/model/theme/font save for real; backup arrives in step 10.
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { GatewayInfo, UpdateInfo } from "../lib/types";
import { th } from "../i18n/th";
import { useApp, type AppSection } from "../state";
import { StatusPill } from "../components/StatusPill";
import { UpdateDialog } from "../components/UpdateDialog";
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
  const saveUrl = () => run(async () => { setInfo(await api.setGatewayUrl(url)); setMsg({ ok: true, text: "บันทึก Gateway URL แล้ว" }); });
  const saveKey = () => run(async () => {
    setInfo(await api.saveApiKey(key));
    setKey("");
    setEditingKey(false);
    setMsg({ ok: true, text: "บันทึก API Key ใน Windows Credential Manager แล้ว" });
    setModels(await api.gatewayModels().catch(() => models));
  });
  const test = () => run(async () => {
    const r = await api.testGateway();
    setMsg(r.ok ? { ok: true, text: `เชื่อมต่อสำเร็จ · ${r.model} ตอบใน ${(r.elapsedMs / 1000).toFixed(1)} วิ` } : { ok: false, text: r.error ?? "ทดสอบไม่ผ่าน" });
    app.recheckGateway();
  });

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
      </div>
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
  return (
    <section className="card card-pad" aria-labelledby="bk-h">
      <h2 id="bk-h">สำรองและนำเข้าคอนฟิก</h2>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>รวมหมวดหมู่ รูปแบบรีพอร์ต และสีของทุกโปรเจกต์ไว้ในไฟล์เดียว ให้เพื่อนในทีมนำเข้าแล้วใช้ชุดเดียวกัน ไม่รวม API key และข้อมูลทิกเก็ต</p>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" onClick={() => app.toast("ส่งออกคอนฟิก — ทำในขั้นที่ 10")}>ส่งออกคอนฟิก</button>
        <button className="btn" onClick={() => app.toast("นำเข้าคอนฟิก — ทำในขั้นที่ 10")}>นำเข้าคอนฟิก</button>
      </div>
    </section>
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
