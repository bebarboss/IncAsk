// สรุปวิเคราะห์รายหมวดด้วย AI (Summary page): for the chosen period, every category with tickets —
// its saved analysis (summary, symptoms, root cause, resolution, prevention) or a button to make one.
// Analyses are saved per category + period; the Excel รายงานวิเคราะห์ puts them in "สรุปหารือ".
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Sparkles } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { Insight, InsightCategory, InsightRun } from "../lib/types";
import { fmtInt, money, thMonth } from "../lib/format";
import { useApp } from "../state";
import { ProgressBar } from "./ProgressBar";
import { CauseChip } from "./Cause";

type Cat = InsightCategory;

/** service + category values, independent of key order */
const keyOf = (service: string, values: Record<string, string>) => `${service}\u0000${JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k]]))}`;

export function InsightsPanel({ projectId, from, to }: { projectId: string; from: string; to: string }) {
  const app = useApp();
  const [insights, setInsights] = useState<Insight[] | null>(null);
  /** categories with tickets in the period, largest first */
  const [cats, setCats] = useState<Cat[]>([]);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [last, setLast] = useState<InsightRun | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const SHOW = 8;

  const load = useCallback(() => {
    api.listInsights(projectId, from, to).then(setInsights).catch(() => setInsights([]));
    api.insightCategories(projectId, from, to).then(setCats).catch(() => setCats([]));
  }, [projectId, from, to]);
  useEffect(() => { setInsights(null); load(); }, [load]);
  useEffect(() => {
    let un: (() => void) | undefined;
    api.on("insight://progress", (p) => { if (p.projectId === projectId) setBusy({ done: p.done, total: p.total }); }).then((u) => { un = u; });
    return () => un?.();
  }, [projectId]);

  const byKey = useMemo(() => {
    const m = new Map<string, Insight>();
    (insights ?? []).forEach((i) => m.set(keyOf(i.service, i.values), i));
    return m;
  }, [insights]);
  const missing = cats.filter((c) => !byKey.has(keyOf(c.service, c.values)));

  const analyze = async (only: Cat[] | null, missingOnly: boolean) => {
    const n = only ? only.length : missingOnly ? missing.length : cats.length;
    if (!n) return;
    setBusy({ done: 0, total: n });
    setLast(null);
    try {
      const r = await api.analyzeCategories(projectId, { from, to, service: null }, only ? only.map((c) => ({ service: c.service, values: c.values })) : null, missingOnly);
      setLast(r);
      load();
      app.toast(r.failed ? `วิเคราะห์ได้ ${fmtInt(r.done)} หมวด · ไม่สำเร็จ ${fmtInt(r.failed)}` : `✓ วิเคราะห์ ${fmtInt(r.done)} หมวดแล้ว`);
    } catch (e) {
      app.toast(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const period = from === to ? thMonth(from) : `${thMonth(from)} – ${thMonth(to)}`;
  return (
    <section className="card card-pad" aria-labelledby="ins-h" style={{ gap: 12, flex: "none" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 320px" }}>
          <h2 id="ins-h" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Sparkles size={18} strokeWidth={1.8} aria-hidden="true" color="var(--accent)" />สรุปวิเคราะห์รายหมวดด้วย AI</h2>
          <span className="muted" style={{ fontSize: 13 }}>
            {period} · วิเคราะห์แล้ว {fmtInt(cats.length - missing.length)}/{fmtInt(cats.length)} หมวด · AI อ่านข้อความปัญหาของทิกเก็ตในหมวด (ไม่เกิน 50 ตัวอย่างต่อหมวด) · ผลไปอยู่ในคอลัมน์ "สรุปหารือ" ของ Excel รายงานวิเคราะห์
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {missing.length > 0 && <button className="btn btn-primary" disabled={!!busy} onClick={() => analyze(null, true)}><Sparkles size={15} strokeWidth={2} aria-hidden="true" />วิเคราะห์ {fmtInt(missing.length)} หมวดที่ยังไม่มี</button>}
          {cats.length > missing.length && <button className="btn" disabled={!!busy} onClick={() => analyze(null, false)}><RefreshCw size={15} strokeWidth={2} aria-hidden="true" />วิเคราะห์ใหม่ทั้งหมด</button>}
        </div>
      </div>
      {busy && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }} role="status">
          <span style={{ fontSize: 13 }}>กำลังวิเคราะห์… {fmtInt(busy.done)}/{fmtInt(busy.total)} หมวด</span>
          <ProgressBar value={busy.total ? busy.done / busy.total : 0} label="ความคืบหน้าการวิเคราะห์" />
        </div>
      )}
      {last && (last.failed > 0 || last.errors.length > 0) && (
        <div className="warn-box" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          {last.errors.slice(0, 5).map((e) => <span key={e}>{e}</span>)}
        </div>
      )}
      {last && last.done > 0 && <span className="muted" style={{ fontSize: 12 }}>ใช้โทเคน {fmtInt(last.tokensIn + last.tokensOut)}{last.cost != null ? ` · ${money(last.cost)}` : ""}</span>}
      {cats.length === 0 && <p className="muted">ยังไม่มีทิกเก็ตที่จัดหมวดแล้วในช่วงนี้</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(showAll ? cats : cats.slice(0, SHOW)).map((c) => {
          const k = keyOf(c.service, c.values);
          const ins = byKey.get(k);
          const isOpen = open[k] ?? false;
          return (
            <div key={k} className="ins-card">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button className="collapse-btn" style={{ flex: 1, minWidth: 0, textAlign: "left" }} aria-expanded={isOpen} disabled={!ins} onClick={() => setOpen({ ...open, [k]: !isOpen })}>
                  {ins ? (isOpen ? <ChevronDown size={15} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={15} strokeWidth={2} aria-hidden="true" />) : <span style={{ width: 15 }} />}
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{c.label}</span>
                    {ins ? <span style={{ fontSize: 13, color: "var(--text-2)", fontWeight: 400 }}>{ins.analysis.summary}</span>
                      : <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>ยังไม่ได้วิเคราะห์</span>}
                  </span>
                </button>
                {c.cause && <CauseChip cause={c.cause} />}
                <span className="chip neutral" title="ทิกเก็ตในช่วงนี้">{fmtInt(c.count)}</span>
                <button className="icon-btn" disabled={!!busy} aria-label={`${ins ? "วิเคราะห์ใหม่" : "วิเคราะห์"} ${c.label}`} title={ins ? "วิเคราะห์ใหม่" : "วิเคราะห์หมวดนี้"} onClick={() => analyze([c], false)}>
                  {ins ? <RefreshCw size={15} strokeWidth={1.8} /> : <Sparkles size={15} strokeWidth={1.8} />}
                </button>
              </div>
              {ins && isOpen && (
                <dl className="ins-body">
                  {([["อาการที่พบบ่อย", ins.analysis.symptoms], ["สาเหตุที่น่าจะเป็น", ins.analysis.rootCause], ["การแก้ไข", ins.analysis.resolution], ["ข้อเสนอเพื่อลดเคส", ins.analysis.prevention]] as const)
                    .filter(([, v]) => v.trim()).map(([h, v]) => (
                      <div key={h}><dt>{h}</dt><dd>{v}</dd></div>
                    ))}
                  <div className="muted" style={{ fontSize: 11 }}>
                    วิเคราะห์เมื่อ {new Date(ins.createdAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })} · {ins.model} · จาก {fmtInt(ins.tickets)} ทิกเก็ต
                    {ins.tickets !== c.count && <span style={{ color: "var(--warn-text)" }}> · ตอนนี้มี {fmtInt(c.count)} ทิกเก็ต — กดวิเคราะห์ใหม่ได้</span>}
                  </div>
                </dl>
              )}
            </div>
          );
        })}
      </div>
      {cats.length > SHOW && (
        <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setShowAll(!showAll)}>
          {showAll ? "แสดงเฉพาะ " + SHOW + " หมวดแรก" : `แสดงทั้งหมด ${fmtInt(cats.length)} หมวด`}
        </button>
      )}
    </section>
  );
}
