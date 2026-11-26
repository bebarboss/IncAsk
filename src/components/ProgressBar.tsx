// From DocAsk components/ProgressBar.tsx (+ "lg" size for the classify page).
export function ProgressBar({ value, thin, lg, label }: { value: number; thin?: boolean; lg?: boolean; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className={`progress${thin ? " thin" : ""}${lg ? " lg" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}
