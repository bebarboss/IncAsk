// การใช้งาน Key (SPEC §11.4 canvas 8): what the Gateway reports for this key (/key/info) —
// spend, budget, budget bar, reset date and limits. Per the user's decision there is no run history.
import { useEffect, useState } from "react";
import { api, errMsg } from "../lib/api";
import type { KeyUsage } from "../lib/types";
import { fmtInt, money, thMonth } from "../lib/format";
import { ProgressBar } from "../components/ProgressBar";
import { StatCard } from "../components/StatCard";
import { usageTone } from "../components/KeyUsageChip";
import { SkeletonList } from "../components/ui";
import { useApp } from "../state";

const thDay = (iso: string) => new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });

export default function UsagePage() {
  const { gateway } = useApp();
  const [key, setKey] = useState<KeyUsage | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.gatewayKeyUsage().then((k) => { setKey(k); setError(null); }).catch((e) => { setKey(null); setError(errMsg(e)); });
  }, [gateway.state]);

  const spend = key?.spend ?? null;
  const budget = key?.maxBudget ?? null;
  const ratio = spend != null && budget ? Math.min(1, spend / budget) : null;
  const tone = usageTone(ratio);

  return (
    <section className="card card-pad" aria-labelledby="mo-h">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h2 id="mo-h">การใช้งาน Key · {thMonth(new Date().toISOString().slice(0, 7))}</h2>
        <span className="muted" style={{ fontSize: 12 }}>ข้อมูลจาก LiteLLM{key?.budgetResetAt ? ` · งบรีเซ็ต ${thDay(key.budgetResetAt)}` : ""}</span>
      </div>
      {key === undefined ? <SkeletonList rows={1} h={70} /> : key === null ? (
        <div className="info-box">{error ?? "Gateway นี้ไม่รายงานการใช้งานของ Key"}</div>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard label="ใช้ไปแล้ว" value={spend != null ? money(spend) : "—"} />
            <StatCard label="งบของ Key" value={budget != null ? money(budget) : "ไม่จำกัด"} />
            <StatCard label="คำขอต่อนาที (สูงสุด)" value={key.rpmLimit != null ? fmtInt(key.rpmLimit) : "ไม่จำกัด"} />
            <StatCard label="โทเคนต่อนาที (สูงสุด)" value={key.tpmLimit != null ? fmtInt(key.tpmLimit) : "ไม่จำกัด"} />
          </div>
          {ratio != null && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span style={{ color: tone === "err" ? "var(--err-text)" : tone === "warn" ? "var(--warn-text)" : undefined }}>
                  ใช้ไป {Math.round(ratio * 100)}% ของงบ{tone ? " · ใกล้เต็มงบ" : ""}
                </span>
                <span className="muted">เตือนเมื่อเกิน 80%</span>
              </div>
              <ProgressBar value={ratio} lg tone={tone} label="สัดส่วนงบที่ใช้ไป" />
            </div>
          )}
          {(key.keyAlias || key.models.length > 0) && (
            <span className="muted" style={{ fontSize: 12 }}>
              {[key.keyAlias ? `Key: ${key.keyAlias}` : null, key.models.length ? `ใช้ได้ ${key.models.length} โมเดล` : null, key.expires ? `หมดอายุ ${thDay(key.expires)}` : null].filter(Boolean).join(" · ")}
            </span>
          )}
        </>
      )}
    </section>
  );
}
