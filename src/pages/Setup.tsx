// First-run setup, 3 steps (SPEC §11.4 canvas 0 / 0.2 / 0.3).
// Step 1 talks to the real Gateway commands; steps 2–3 are filled in by later build steps.
import { useEffect, useState } from "react";
import { ArrowRight, Check, Upload, Wifi } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { GatewayInfo, Service } from "../lib/types";
import { useApp } from "../state";

const STEPS = ["เชื่อมต่อ Gateway", "นำเข้าหมวดหมู่", "พร้อมใช้งาน"];

export default function SetupPage() {
  const [step, setStep] = useState(0);
  return (
    <div className="setup">
      <div className="setup-inner">
        {step === 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center" }}>
            <div className="logo-mark" style={{ width: 48, height: 48, fontSize: 22, borderRadius: 12 }} aria-hidden="true">I</div>
            <h1 style={{ fontSize: 26, fontWeight: 700 }}>ยินดีต้อนรับสู่ IncAsk</h1>
            <p className="muted">ตั้งค่าสั้นๆ ก่อนเริ่มจัดหมวดอินซิเดนต์ด้วย AI</p>
          </div>
        )}
        <ol className="steps" aria-label="ขั้นตอน">
          {STEPS.map((s, i) => (
            <li key={s} className={`${i <= step ? "on" : ""}${i === step ? " cur" : ""}`} aria-current={i === step ? "step" : undefined}>
              <span aria-hidden="true" />
              <span>{i < step ? `✓ ${s}` : `${i + 1} · ${s}`}</span>
            </li>
          ))}
        </ol>
        {step === 0 && <GatewayStep onNext={() => setStep(1)} />}
        {step === 1 && <CategoriesStep onBack={() => setStep(0)} onNext={() => setStep(2)} />}
        {step === 2 && <ReadyStep onBack={() => setStep(1)} />}
      </div>
    </div>
  );
}

function GatewayStep({ onNext }: { onNext: () => void }) {
  const app = useApp();
  const [name, setName] = useState(app.settings.userName);
  const [url, setUrl] = useState(app.settings.gatewayUrl);
  const [key, setKey] = useState("");
  const [info, setInfo] = useState<GatewayInfo | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState(app.settings.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.getGateway().then((g) => { setInfo(g); setUrl(g.url); }).catch(() => {}); }, []);

  const test = async () => {
    setBusy(true);
    setError(null);
    setModels(null);
    try {
      if (url.trim() !== info?.url) setInfo(await api.setGatewayUrl(url));
      if (key.trim()) {
        setInfo(await api.saveApiKey(key));
        setKey(""); // the key lives in Credential Manager now, not in this page
      }
      const list = await api.gatewayModels();
      const pickModel = list.includes(model) ? model : list[0];
      const r = await api.testGateway(pickModel);
      if (!r.ok) throw { message: r.error ?? "ทดสอบไม่ผ่าน" };
      setModels(list);
      setModel(pickModel);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const next = async () => {
    await app.updateSettings({ userName: name.trim(), model });
    onNext();
  };

  return (
    <>
      <section className="card card-pad" aria-labelledby="gw-h" style={{ padding: 24, gap: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 id="gw-h" style={{ fontSize: 18, fontWeight: 700 }}>เชื่อมต่อ LiteLLM Gateway</h2>
          <p className="muted" style={{ fontSize: 13 }}>ใช้ Gateway ของบริษัท API key จะถูกเก็บใน Windows Credential Manager ของเครื่อง ไม่บันทึกเป็นไฟล์</p>
        </div>
        <div className="field">
          <label htmlFor="su-name">ชื่อของคุณ</label>
          <input id="su-name" className="input lg" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="su-url">Gateway URL</label>
          <input id="su-url" className="input lg mono" type="url" value={url} onChange={(e) => { setUrl(e.target.value); setModels(null); }} />
        </div>
        <div className="field">
          <label htmlFor="su-key">API Key</label>
          <input
            id="su-key"
            className="input lg mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={info?.hasKey ? `บันทึกแล้ว ••••${info.keyLast4 ?? ""} — ใส่ใหม่เพื่อเปลี่ยน` : "sk-…"}
            value={key}
            onChange={(e) => { setKey(e.target.value); setModels(null); }}
          />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <button className="btn btn-lg" onClick={test} disabled={busy || (!key.trim() && !info?.hasKey)}>
            <Wifi size={17} strokeWidth={1.8} aria-hidden="true" />
            {busy ? "กำลังทดสอบ…" : "ทดสอบการเชื่อมต่อ"}
          </button>
          {!models && !error && <span className="muted" style={{ fontSize: 13 }}>ต้องทดสอบผ่านก่อนจึงไปขั้นต่อไปได้</span>}
          {models && (
            <span className="ok-badge" role="status"><Check size={14} strokeWidth={3} aria-hidden="true" />เชื่อมต่อสำเร็จ · พบ {models.length} โมเดล</span>
          )}
        </div>
        {error && <div className="err-box" role="alert">{error}</div>}
        {models && (
          <div className="field">
            <label htmlFor="su-model">โมเดลที่ใช้จัดหมวด</label>
            <select id="su-model" className="select lg mono" value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="field-hint">รายชื่อดึงมาจาก Gateway เปลี่ยนทีหลังได้ในตั้งค่าโปรแกรม</span>
          </div>
        )}
      </section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span className="muted" style={{ fontSize: 13 }}>กลับมาแก้ได้ทุกเมื่อจากเมนูชื่อของคุณ</span>
        <button className="btn btn-lg btn-primary" disabled={!models || !name.trim()} onClick={next}>
          ถัดไป <ArrowRight size={17} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}

function CategoriesStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const app = useApp();
  const [name, setName] = useState(app.projects[0]?.name ?? "");
  const [services, setServices] = useState<Service[]>([]);
  useEffect(() => {
    if (app.projects[0]) api.listServices(app.projects[0].id).then(setServices).catch(() => setServices([]));
  }, [app.projects]);
  return (
    <>
      <section className="card card-pad" aria-labelledby="cat-h" style={{ padding: 24, gap: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 id="cat-h" style={{ fontSize: 20, fontWeight: 700 }}>สร้างโปรเจกต์แรกและนำเข้าหมวดหมู่</h2>
          <p className="muted" style={{ fontSize: 13 }}>ไฟล์ Excel หนึ่งไฟล์ต่อหนึ่งเซอร์วิส หรือไฟล์เดียวที่มีคอลัมน์ "เซอร์วิส" ก็ได้</p>
        </div>
        <div className="field">
          <label htmlFor="su-pname">ชื่อโปรเจกต์</label>
          <input id="su-pname" className="input lg" value={name} placeholder="เช่น Call Center A" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="dropzone">
          <Upload size={30} strokeWidth={1.8} color="var(--accent)" aria-hidden="true" />
          <span style={{ fontWeight: 600 }}>ลากไฟล์ Excel หมวดหมู่มาวางที่นี่</span>
          <span className="muted" style={{ fontSize: 13 }}>
            หรือ <button className="link-btn" style={{ fontSize: 13, fontWeight: 600 }} onClick={() => app.toast("นำเข้าหมวดหมู่ — ทำในขั้นที่ 4")}>เลือกไฟล์</button>
            {" · "}
            <button className="link-btn" style={{ fontSize: 13, fontWeight: 600 }} onClick={() => app.toast("เทมเพลต — ทำในขั้นที่ 4")}>ดาวน์โหลดเทมเพลต</button>
          </span>
        </div>
        {services.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>นำเข้าแล้ว</span>
            {services.map((s) => <ServiceSummaryRow key={s.id} projectId={app.projects[0].id} service={s} />)}
          </div>
        )}
      </section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <button className="btn btn-lg btn-ghost" onClick={onBack}>‹ ย้อนกลับ</button>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-lg" onClick={onNext}>ข้ามไปก่อน</button>
          <button className="btn btn-lg btn-primary" onClick={onNext}>ถัดไป ›</button>
        </div>
      </div>
    </>
  );
}

function ServiceSummaryRow({ projectId, service }: { projectId: string; service: Service }) {
  const [counts, setCounts] = useState<{ main: number; sub: number; missing: number } | null>(null);
  useEffect(() => {
    api.listTaxonomy(projectId, service.id).then((rows) => {
      const mains = new Set(rows.map((r) => r.values[service.columns[0]]));
      setCounts({ main: mains.size, sub: rows.length, missing: rows.filter((r) => !r.description.trim()).length });
    }).catch(() => {});
  }, [projectId, service]);
  if (!counts) return null;
  const warn = counts.missing > 0;
  return (
    <div className={`list-row${warn ? " warn" : ""}`}>
      <span className="swatch" style={{ background: service.color }} aria-hidden="true" />
      <span style={{ flex: 1, fontWeight: 600 }}>{service.name}</span>
      {warn ? (
        <span style={{ fontSize: 12, color: "var(--warn-text)" }}>{counts.missing} หัวข้อย่อยไม่มีคำอธิบาย · AI อาจจัดได้แม่นน้อยลง</span>
      ) : (
        <>
          <span style={{ fontSize: 12, color: "var(--text-2)" }}>{counts.main} หัวข้อหลัก · {counts.sub} หัวข้อย่อย</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ok-text)" }}>✓ ครบ</span>
        </>
      )}
    </div>
  );
}

function ReadyStep({ onBack }: { onBack: () => void }) {
  const app = useApp();
  const finish = async () => {
    await app.updateSettings({ setupDone: true });
    app.go({ name: "project", tab: "import" });
    app.recheckGateway();
  };
  return (
    <>
      <section className="card card-pad" aria-labelledby="rd-h" style={{ padding: 24, gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="ok-badge"><Check size={14} strokeWidth={3} aria-hidden="true" />พร้อมใช้งาน</span>
        </div>
        <h2 id="rd-h" style={{ fontSize: 20, fontWeight: 700 }}>ตั้งค่าเรียบร้อย</h2>
        <div className="kv">
          <div><span className="k">ชื่อ</span><span>{app.settings.userName || "—"}</span></div>
          <div><span className="k">Gateway</span><span className="mono">{app.settings.gatewayUrl}</span></div>
          <div><span className="k">โมเดล</span><span className="mono">{app.settings.model}</span></div>
          <div><span className="k">โปรเจกต์</span><span>{app.projects.length ? app.projects.map((p) => p.name).join(", ") : "ยังไม่มี (สร้างทีหลังได้)"}</span></div>
        </div>
      </section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <button className="btn btn-lg btn-ghost" onClick={onBack}>‹ ย้อนกลับ</button>
        <button className="btn btn-lg btn-primary" onClick={finish}>นำเข้าไฟล์แรก <ArrowRight size={17} strokeWidth={2} aria-hidden="true" /></button>
      </div>
    </>
  );
}
