// From DocAsk components/StatusPill.tsx. Success always carries the ✓ icon (SPEC §11.2 —
// the green accent is close to the "ok" green, so colour alone never signals success).
import { Check, CircleAlert, Loader2 } from "lucide-react";
import type { GatewayStatus } from "../lib/types";
import { th } from "../i18n/th";

export function StatusPill({ status, okText = th.gatewayOk }: { status: GatewayStatus; okText?: string }) {
  if (status.state === "ok") {
    return <span className="ok-badge"><Check size={14} strokeWidth={3} aria-hidden="true" />{okText}</span>;
  }
  if (status.state === "unknown") {
    return <span className="chip neutral"><Loader2 size={14} strokeWidth={1.8} aria-hidden="true" />{th.gatewayChecking}</span>;
  }
  return (
    <span className="chip err" title={status.message ?? undefined}>
      <CircleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
      {status.state === "unreachable" ? th.gatewayDown : th.gatewayError}
    </span>
  );
}
