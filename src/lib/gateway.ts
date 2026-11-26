// Gateway constants and texts (from DocAsk lib/gateway.ts). Mirrors src-tauri/src/config.rs.
import { th } from "../i18n/th";

export const DEFAULT_GATEWAY_URL = "https://agent-gateway.gosoft.co.th";
export const MODEL_IDS = ["godev1", "godev2", "godev3", "gothink1", "gothink2", "gothink3"] as const;
/** default service colours (SPEC §11.2) — all pass contrast on white */
export const SERVICE_COLORS = ["#2F6FB0", "#7B4FB0", "#C2631A", "#5B6270", "#0E7C74", "#B83E78", "#8A6D1F", "#3F7A2E"] as const;
export const SERVICE_COLOR_NAMES: Record<string, string> = {
  "#2F6FB0": "น้ำเงิน", "#7B4FB0": "ม่วง", "#C2631A": "ส้ม", "#5B6270": "เทา",
  "#0E7C74": "ฟ้าอมเขียว", "#B83E78": "ชมพู", "#8A6D1F": "น้ำตาลทอง", "#3F7A2E": "เขียวใบไม้",
};

/** Gateway error text per DocAsk SPEC §3.3. status 0 = network / VPN. */
export function errorText(status: number, serverMessage: string): string {
  switch (status) {
    case 0: return th.err.unreachable;
    case 401: return th.err.e401;
    case 403: return th.err.e403;
    case 404: return th.err.e404;
    case 429: return th.err.e429;
    default: return `HTTP ${status}: ${redact(serverMessage)}`;
  }
}

/** Defense in depth — the backend already redacts. */
export function redact(s: string): string {
  return s.replace(/sk-[A-Za-z0-9_\-.]{2,}/g, "sk-***");
}
