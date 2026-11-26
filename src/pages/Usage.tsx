// การใช้งาน Key (SPEC §11.4 canvas 8): 4 cards, budget bar, per-project share, run history.
// Step 1 renders mock data; runs are recorded in step 6 and this page is finished in step 10.
import { useEffect, useState } from "react";
import { api, errMsg } from "../lib/api";
import type { UsageSummary } from "../lib/types";
import { fmtInt, fmtTokens, money, thDateTime, thMonth } from "../lib/format";
import { ProgressBar } from "../components/ProgressBar";
import { StatCard } from "../components/StatCard";
import { EmptyState, ErrorState, SkeletonList } from "../components/ui";

export default function UsagePage() {
  const [u, setU] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { setError(null); api.usageSummary().then(setU).catch((e) => setError(errMsg(e))); };
  useEffect(load, []);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!u) return <SkeletonList rows={3} h={90} />;
  const ratio = u.spend != null && u.budget ? u.spend / u.budget : null;
  const totalCost = u.byProject.reduce((a, p) => a + p.cost, 0);
  return (
    <>
      <section className="card card-pad" aria-labelledby="mo-h">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <h2 id="mo-h">เดือนนี้ · {thMonth(u.monthLabel)}</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            ข้อมูลจาก LiteLLM{u.budgetResetAt ? ` · งบรีเซ็ต ${new Date(u.budgetResetAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" })}` : ""}
          </span>
        </div>
        <div className="stat-grid">
          <StatCard label="ใช้ไปแล้ว" value={u.spend != null ? money(u.spend) : "—"} />
          <StatCard label="งบของ Key" value={u.budget != null ? money(u.budget) : "ไม่จำกัด"} />
          <StatCard label="โทเคนที่ใช้" value={fmtTokens(u.tokens)} />
          <StatCard label="จำนวนครั้งที่รัน" value={fmtInt(u.runs)} />
        </div>
        {ratio != null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>ใช้ไป {Math.round(ratio * 100)}% ของงบ</span>
              <span className="muted">เตือนเมื่อเกิน 80%</span>
            </div>
            <ProgressBar value={ratio} lg label="สัดส่วนงบที่ใช้ไป" />
          </div>
        )}
      </section>

      <section className="card card-pad" aria-labelledby="pj-h">
        <h2 id="pj-h">แยกตามโปรเจกต์</h2>
        <div style={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", background: "var(--track)" }} aria-hidden="true">
          {u.byProject.map((p) => <div key={p.name} style={{ width: `${totalCost ? (p.cost / totalCost) * 100 : 0}%`, background: p.color }} />)}
        </div>
        <div className="legend">
          {u.byProject.map((p) => (
            <span key={p.name}><span className="swatch" style={{ background: p.color }} />{p.name} · {money(p.cost)} ({totalCost ? Math.round((p.cost / totalCost) * 100) : 0}%)</span>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="hs-h" style={{ overflow: "hidden" }}>
        <div className="card-head"><h2 id="hs-h">ประวัติการรัน</h2></div>
        {u.history.length === 0 ? <EmptyState title="ยังไม่เคยรันจัดหมวด" /> : (
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
                {u.history.map((r) => (
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
