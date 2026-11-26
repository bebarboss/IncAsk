export function StatCard({ label, value, tone }: { label: string; value: string; tone?: "warn" | "err" }) {
  return (
    <div className={`stat-card${tone ? ` ${tone}` : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
