// From DocAsk components/ProgressBar.tsx (+ "lg" size and warn/err tone for the budget bar).
export function ProgressBar({ value, thin, lg, label, tone }: { value: number; thin?: boolean; lg?: boolean; label?: string; tone?: "" | "warn" | "err" }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className={`progress${thin ? " thin" : ""}${lg ? " lg" : ""}${tone ? ` ${tone}` : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}
