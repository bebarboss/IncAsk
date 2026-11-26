// จัดหมวด (SPEC §6.4, canvas 2): %, bar, time left, 4 cards, pause/cancel, recently classified.
// Step 1: follows the mock job's `classify://progress` events; the real job arrives in step 6.
import { useEffect, useState } from "react";
import { ArrowRight, Bell, Pause, Play, Tags } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { ClassifyProgress, Project } from "../lib/types";
import { fmtDuration, fmtInt } from "../lib/format";
import { useApp } from "../state";
import { ProgressBar } from "../components/ProgressBar";
import { StatCard } from "../components/StatCard";
import { GatewayBanner } from "../components/GatewayBanner";
import { ConfirmDialog, EmptyState, ErrorState, SkeletonList } from "../components/ui";

export default function ClassifyPage({ project }: { project: Project }) {
  const app = useApp();
  const [job, setJob] = useState<ClassifyProgress | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    api.classifyStatus(project.id).then(setJob).catch((e) => { setError(errMsg(e)); setJob(null); });
  }, [project.id]);
  const live = app.jobs[project.id];
  const p = live ?? job;

  if (error) return <div className="page"><ErrorState message={error} /></div>;
  if (p === undefined) return <div className="page"><SkeletonList rows={3} h={90} /></div>;
  if (p === null) {
    return (
      <div className="page">
        <GatewayBanner />
        <h1 className="page-title">จัดหมวด</h1>
        <div className="card">
          <EmptyState
            icon={<Tags size={36} strokeWidth={1.6} aria-hidden="true" />}
            title="ยังไม่มีงานจัดหมวด"
            body="นำเข้าไฟล์ทิกเก็ตแล้วกด เริ่มจัดหมวด ความคืบหน้าจะแสดงที่นี่"
            action={<button className="btn btn-lg btn-primary" onClick={() => app.go({ name: "project", tab: "import" })}>นำเข้าไฟล์</button>}
          />
        </div>
      </div>
    );
  }

  const ratio = p.total ? p.done / p.total : 0;
  const active = p.status === "running" || p.status === "paused";
  const statusText = {
    running: p.etaSec != null ? `เหลืออีกประมาณ ${fmtDuration(p.etaSec)}` : "กำลังจัดหมวด…",
    paused: "หยุดชั่วคราว · กดทำต่อเพื่อจัดจากแถวเดิม",
    done: "✓ จัดหมวดเสร็จแล้ว",
    cancelled: "ยกเลิกแล้ว · แถวที่จัดเสร็จยังอยู่ในผลลัพธ์",
    failed: "งานล้มเหลว",
  }[p.status];

  return (
    <div className="page">
      <GatewayBanner />
      <header className="page-head">
        <div className="l">
          <h1 className="page-title">จัดหมวด</h1>
          <p className="muted">{p.fileName}{p.patternName ? ` · รูปแบบ "${p.patternName}"` : ""}</p>
        </div>
        {active && (
          <div style={{ display: "flex", gap: 8 }}>
            {p.status === "running" ? (
              <button className="btn" onClick={() => api.pauseClassify(p.runId)}><Pause size={16} strokeWidth={2} aria-hidden="true" />หยุดชั่วคราว</button>
            ) : (
              <button className="btn btn-primary" onClick={() => api.resumeClassify(p.runId)}><Play size={16} strokeWidth={2} aria-hidden="true" />ทำต่อ</button>
            )}
            <button className="btn btn-danger" onClick={() => setConfirmCancel(true)}>ยกเลิก</button>
          </div>
        )}
      </header>

      <section className="card card-pad" aria-label="ความคืบหน้า">
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span className="num" style={{ fontSize: 32, fontWeight: 700 }}>{Math.floor(ratio * 100)}%</span>
            <span className="muted">{fmtInt(p.done)} จาก {fmtInt(p.total)} แถว</span>
          </div>
          <span className="muted" style={{ fontSize: 13, color: p.status === "done" ? "var(--ok-text)" : undefined }}>
            {statusText}{p.status === "running" ? ` · ส่งพร้อมกัน ${p.concurrency} คำขอ` : ""}
          </span>
        </div>
        <ProgressBar value={ratio} lg label="ความคืบหน้าการจัดหมวด" />
        <div className="stat-grid">
          <StatCard label="AI จัดแล้ว" value={fmtInt(p.ai)} />
          <StatCard label="ใช้ผลจากแคช (ข้อความซ้ำ)" value={fmtInt(p.cached)} />
          <StatCard label="AI ไม่มั่นใจ · ควรตรวจ" value={fmtInt(p.low)} tone="warn" />
          <StatCard label="ผิดพลาด · จะลองใหม่" value={fmtInt(p.error)} tone="err" />
        </div>
        <div className="info-box">
          <Bell size={16} strokeWidth={1.9} aria-hidden="true" style={{ flex: "none" }} />
          ปิดหน้านี้หรือไปทำอย่างอื่นได้ ระบบจะแจ้งเตือนเมื่อจัดหมวดเสร็จ ถ้าหยุดกลางทาง กดทำต่อจากแถวเดิมได้
        </div>
      </section>

      <section className="card" aria-labelledby="recent-h" style={{ overflow: "hidden" }}>
        <div className="card-head">
          <h2 id="recent-h">เพิ่งจัดเสร็จ</h2>
          <button className="link-btn" style={{ fontSize: 13, fontWeight: 600 }} onClick={() => app.go({ name: "project", tab: "results" })}>ดูผลลัพธ์ทั้งหมด</button>
        </div>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {p.recent.length === 0 && <li className="muted" style={{ padding: "14px 18px" }}>ยังไม่มีแถวที่จัดเสร็จ</li>}
          {p.recent.map((r, i) => (
            <li key={`${r.ticketNo}-${i}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px", padding: "12px 18px", borderBottom: "1px solid var(--border-soft)" }}>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--text-2)", width: 100 }}>{r.ticketNo}</span>
              <span className="tag">{r.service}</span>
              <span style={{ flex: "1 1 260px", minWidth: 0, color: "var(--text-2)", fontSize: 13 }}>{r.text}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "var(--accent-ink)" }}>
                <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />{r.category}
              </span>
              {r.low && <span className="chip warn">ไม่มั่นใจ</span>}
              {r.cached && <span className="chip neutral">แคช</span>}
            </li>
          ))}
        </ul>
      </section>

      {confirmCancel && (
        <ConfirmDialog
          title="ยกเลิกการจัดหมวด?"
          body="แถวที่จัดเสร็จแล้วจะยังอยู่ในผลลัพธ์ แถวที่เหลือจะไม่ถูกส่งให้ AI"
          confirmLabel="ยกเลิกงาน"
          danger
          onCancel={() => setConfirmCancel(false)}
          onConfirm={async () => { await api.cancelClassify(p.runId); setConfirmCancel(false); }}
        />
      )}
    </div>
  );
}
