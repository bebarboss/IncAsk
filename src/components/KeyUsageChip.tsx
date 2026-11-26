// Compact "การใช้งาน Key" bar (from DocAsk Sidebar KeyUsageWidget): spend/budget + thin bar.
// Orange from 80%, red from 95% (SPEC §11.3). Hidden when there's no key or the Gateway doesn't report usage.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { KeyUsage } from "../lib/types";
import { money } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";

export function useKeyUsage(): KeyUsage | null {
  const { gateway } = useApp();
  const [u, setU] = useState<KeyUsage | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.gatewayKeyUsage().then((r) => alive && setU(r)).catch(() => alive && setU(null));
    load();
    const t = setInterval(load, 180_000);
    return () => { alive = false; clearInterval(t); };
  }, [gateway.state]);
  return u;
}

export function usageTone(ratio: number | null): "" | "warn" | "err" {
  if (ratio == null) return "";
  return ratio >= 0.95 ? "err" : ratio >= 0.8 ? "warn" : "";
}

export function KeyUsageChip() {
  const { go } = useApp();
  const u = useKeyUsage();
  if (!u || (u.spend == null && u.maxBudget == null)) return null;
  const spend = u.spend ?? 0;
  const ratio = u.maxBudget && u.maxBudget > 0 ? Math.min(1, spend / u.maxBudget) : null;
  const tip = [
    u.budgetResetAt ? `งบรีเซ็ต ${new Date(u.budgetResetAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" })}` : null,
    u.rpmLimit != null ? `${u.rpmLimit.toLocaleString("th-TH")} ครั้ง/นาที` : null,
    u.tpmLimit != null ? `${u.tpmLimit.toLocaleString("th-TH")} token/นาที` : null,
  ].filter(Boolean).join(" · ");
  return (
    <button className="usage-chip" title={tip || undefined} onClick={() => go({ name: "app", section: "usage" })} aria-label={`${th.keyUsage} ${money(spend)}${u.maxBudget != null ? ` จาก ${money(u.maxBudget)}` : ""}`}>
      <span className="usage-chip-top">
        <span>{th.keyUsage}</span>
        <span className="usage-chip-val">{money(spend)}{u.maxBudget != null ? ` / ${money(u.maxBudget)}` : ""}</span>
      </span>
      {ratio != null && <span className={`usage-bar ${usageTone(ratio)}`} style={{ display: "block" }}><div style={{ width: `${Math.round(ratio * 100)}%` }} /></span>}
    </button>
  );
}
