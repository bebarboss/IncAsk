// "Gateway ต่อไม่ได้" bar shown inside pages that need the Gateway (SPEC §11.5).
// Results and Summary keep working, so they don't show it.
import { th } from "../i18n/th";
import { useApp } from "../state";

export function GatewayBanner() {
  const { gateway, recheckGateway } = useApp();
  if (gateway.state !== "unreachable" && gateway.state !== "error") return null;
  return (
    <div className={`banner${gateway.state === "error" ? " warn" : ""}`} role="alert" style={{ borderRadius: 12, border: "1px solid" }}>
      <span>
        {gateway.state === "unreachable" ? th.err.unreachable : gateway.message ?? th.gatewayError}
        {" · "}ยังดูผลลัพธ์และสรุปผลได้ตามปกติ แต่เริ่มจัดหมวดใหม่ไม่ได้
      </span>
      <button className="btn" onClick={recheckGateway}>{th.tryAgain}</button>
    </div>
  );
}
