// ต้นเหตุ chip (text + colour, never colour alone) and its picker.
import { CAUSE_HINT, CAUSE_LABEL, CAUSES, NOT_ASSESSED } from "../lib/cause";

export function CauseChip({ cause }: { cause: string | null | undefined }) {
  if (!cause) return <span className="muted" style={{ fontSize: 12 }}>{NOT_ASSESSED}</span>;
  return <span className={`cause-chip cause-${cause}`} title={CAUSE_HINT[cause]}>{CAUSE_LABEL[cause] ?? cause}</span>;
}

/** native select styled as a chip: keyboard and screen readers work as is */
export function CauseSelect({ id, value, onChange, label, compact, placeholder }: {
  id?: string; value: string | null; onChange: (cause: string) => void; label?: string; compact?: boolean; placeholder?: string;
}) {
  return (
    <select id={id} aria-label={label} className={`select${compact ? " cause-sel" : ""}${value ? ` cause-${value}` : ""}`} value={value ?? ""}
      onChange={(e) => e.target.value && onChange(e.target.value)} title={value ? CAUSE_HINT[value] : "ยังไม่ประเมิน — เลือกเพื่อกำหนดเอง"}>
      {!value && <option value="">{placeholder ?? (compact ? "—" : NOT_ASSESSED)}</option>}
      {CAUSES.map((c) => <option key={c} value={c}>{CAUSE_LABEL[c]}</option>)}
    </select>
  );
}
