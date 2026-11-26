// Formatting helpers: Thai months/dates (พ.ศ.), numbers, money, initials.

const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** "2026-10" → "ต.ค. 2569" (short: "ต.ค. 69") */
export function thMonth(ym: string, short = false): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  const be = y + 543;
  return `${TH_MONTHS[m - 1]} ${short ? String(be).slice(-2) : be}`;
}

/** "2026-10-03" → "03/10/2569" */
export function thDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${Number(y) + 543}`;
}

/** "2026-10-01","2026-10-03" → "1 – 3 ต.ค. 2569" */
export function thDateRange(from: string, to: string): string {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  if (fy === ty && fm === tm) return `${fd} – ${td} ${TH_MONTHS[tm - 1]} ${ty + 543}`;
  return `${fd} ${TH_MONTHS[fm - 1]} ${fy + 543} – ${td} ${TH_MONTHS[tm - 1]} ${ty + 543}`;
}

export function thDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())} ${TH_MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const fmtInt = (n: number) => n.toLocaleString("en-US");

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 && n > 0 ? 4 : 2 })}`;

export const pct = (v: number) => `${Math.round(v * 100)}%`;

/** month-over-month change, or null when there is no previous value */
export function delta(prev: number, cur: number): { up: boolean; text: string } | null {
  if (!prev) return null;
  const p = Math.round(((cur - prev) / prev) * 100);
  return { up: p > 0, text: `${Math.abs(p)}%` };
}

export function initials(name: string): string {
  const n = name.trim();
  if (!n) return "?";
  const parts = n.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return n.slice(0, 1).toUpperCase();
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} วินาที`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} นาที`;
  return `${Math.floor(m / 60)} ชม. ${m % 60} นาที`;
}

/** "A › B" in the service's column order (stored fields are a sorted map) */
export function categoryLabel(columns: string[] | undefined, fields: Record<string, string> | null | undefined): string {
  if (!fields) return "";
  const cols = columns ?? Object.keys(fields);
  return cols.map((c) => fields[c]).filter(Boolean).join(" › ");
}
