// การใช้งาน Key (SPEC §11.4 canvas 8): 4 cards, budget bar, per-project share, run history.
// Spend/budget/reset come from the Gateway's /key/info (step 2). Tokens, run count, per-project
// cost and history come from the local `runs` tables (recorded from step 6, page finished in step 10);
// until then those parts show an empty state.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { KeyUsage, UsageSummary } from "../lib/types";
import { fmtInt, fmtTokens, money, thDateTime, thMonth } from "../lib/format";
import { ProgressBar } from "../components/ProgressBar";
import { StatCard } from "../components/StatCard";
import { usageTone } from "../components/KeyUsageChip";
import { EmptyState, SkeletonList } from "../components/ui";
import { useApp } from "../state";

const thDay = (iso: string) => new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });

export default function UsagePage() {
  const { gateway } = useApp();
  const [key, setKey] = useState<KeyUsage | null | undefined>(undefined);
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const [runs, setRuns] = useState<UsageSummary | null | undefined>(undefined);

  useEffect(() => {
    api.gatewayKeyUsage().then((k) => { setKey(k); setKeyErr(null); }).catch((e) => { setKey(null); setKeyErr((e as { message?: string }).message ?? String(e)); });
  }, [gateway.state]);
  useEffect(() => {
    api.usageSummary().then(setRuns).catch(() => setRuns(null));
  }, []);

  const month = new Date().toISOString().slice(0, 7);
  const spend = key?.spend ?? null;
  const budget = key?.maxBudget ?? null;
  const ratio = spend != null && budget ? Math.min(1, spend / budget) : null;
  const totalCost = runs ? runs.byProject.reduce((a, p) => a + p.cost, 0) : 0;

  return (
    <>
      <section className="card card-pad" aria-labelledby="mo-h">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <h2 id="mo-h">เดือนนี้ · {thMonth(month)}</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            ข้อมูลจาก LiteLLM{key?.budgetResetAt ? ` · งบรีเซ็ต ${thDay(key.budgetResetAt)}` : ""}
          </span>
        </div>
        {key === undefined ? <SkeletonList rows={1} h={70} /> : (
          <>
            {key === null && (
              <div className="info-box">{keyErr ?? "Gateway นี้ไม่รายงานยอดใช้ของ Key — ดูได้เฉพาะโทเคนจากการรันในเครื่อง"}</div>
            )}
            <div className="stat-grid">
              <StatCard label="ใช้ไปแล้ว" value={spend != null ? money(spend) : "—"} />
              <StatCard label="งบของ Key" value={budget != null ? money(budget) : key ? "ไม่จำกัด" : "—"} />
              <StatCard label="โทเคนที่ใช้" value={runs ? fmtTokens(runs.tokens) : "—"} />
              <StatCard label="จำนวนครั้งที่รัน" value={runs ? fmtInt(runs.runs) : "—"} />
            </div>
            {ratio != null && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <span style={{ color: usageTone(ratio) === "err" ? "var(--err-text)" : usageTone(ratio) === "warn" ? "var(--warn-text)" : undefined }}>
                    ใช้ไป {Math.round(ratio * 100)}% ของงบ{usageTone(ratio) ? " · ใกล้เต็มงบ" : ""}
                  </span>
                  <span className="muted">เตือนเมื่อเกิน 80%</span>
                </div>
                <ProgressBar value={ratio} lg tone={usageTone(ratio)} label="สัดส่วนงบที่ใช้ไป" />
              </div>
            )}
            {key && (key.rpmLimit != null || key.tpmLimit != null) && (
              <span className="muted" style={{ fontSize: 12 }}>
                ขีดจำกัด: {[key.rpmLimit != null ? `${fmtInt(key.rpmLimit)} ครั้ง/นาที` : null, key.tpmLimit != null ? `${fmtInt(key.tpmLimit)} โทเคน/นาที` : null].filter(Boolean).join(" · ")}
              </span>
            )}
          </>
        )}
      </section>

      <section className="card card-pad" aria-labelledby="pj-h">
        <h2 id="pj-h">แยกตามโปรเจกต์</h2>
        {!runs || runs.byProject.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>ยังไม่มีการรันจัดหมวด</p> : (
          <>
            <div style={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", background: "var(--track)" }} aria-hidden="true">
              {runs.byProject.map((p) => <div key={p.name} style={{ width: `${totalCost ? (p.cost / totalCost) * 100 : 0}%`, background: p.color }} />)}
            </div>
            <div className="legend">
              {runs.byProject.map((p) => (
                <span key={p.name}><span className="swatch" style={{ background: p.color }} />{p.name} · {money(p.cost)} ({totalCost ? Math.round((p.cost / totalCost) * 100) : 0}%)</span>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="hs-h" style={{ overflow: "hidden" }}>
        <div className="card-head"><h2 id="hs-h">ประวัติการรัน</h2></div>
        {runs === undefined ? <div style={{ padding: 16 }}><SkeletonList rows={3} h={32} /></div>
          : !runs || runs.history.length === 0 ? <EmptyState title="ยังไม่เคยรันจัดหมวด" body="ประวัติจะขึ้นที่นี่หลังจัดหมวดครั้งแรก พร้อมจำนวนแถว แคช โทเคน และค่าใช้จ่าย" />
          : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">วันเวลา</th><th scope="col">โปรเจกต์</th><th scope="col">ไฟล์</th>
                  <th scope="col" className="r">แถว</th><th scope="col" className="r">ใช้แคช</th>
                  <th scope="col" className="r">โทเคน</th><th scope="col" className="r">ค่าใช้จ่าย</th>
                </tr>
              </thead>
              <tbody>
                {runs.history.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{thDateTime(r.startedAt)}</td>
                    <td>{r.project}</td>
                    <td className="ellipsis" style={{ maxWidth: 260 }}>{r.fileName}</td>
                    <td className="r">{fmtInt(r.rows)}</td>
                    <td className="r">{fmtInt(r.cached)}</td>
                    <td className="r">{fmtTokens(r.tokens)}</td>
                    <td className="r">{r.cost != null ? money(r.cost) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
