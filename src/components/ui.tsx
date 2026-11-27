// Small shared primitives (from DocAsk components/ui.tsx): Modal, ConfirmDialog, Switch, Popover hook,
// Skeleton, ErrorState, EmptyState, Logo. DocAsk's CodeBadge is dropped.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { th } from "../i18n/th";

export function Modal({ title, onClose, children, width, subtitle }: { title: string; onClose: () => void; children: ReactNode; width?: number; subtitle?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, textarea, select, [role=radio], button:not([data-close])");
    first?.focus();
    return () => prev?.focus();
  }, []);
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={width ? { maxWidth: width } : undefined}>
        <div className="modal-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <h2>{title}</h2>
            {subtitle && <span className="muted" style={{ fontSize: 13 }}>{subtitle}</span>}
          </div>
          <button className="icon-btn" data-close aria-label={th.close} onClick={onClose}><X size={18} strokeWidth={1.8} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  title, body, confirmLabel, danger, onConfirm, onCancel, extra,
}: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean;
  onConfirm: () => void | Promise<void>; onCancel: () => void; extra?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onCancel}>
      <div style={{ color: "var(--text-2)", lineHeight: 1.7 }}>{body}</div>
      {extra}
      <div className="modal-actions">
        <button className="btn btn-lg" onClick={onCancel}>{th.cancel}</button>
        <button
          className={`btn btn-lg ${danger ? "btn-danger-solid" : "btn-primary"}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await onConfirm(); } finally { setBusy(false); }
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

/** Closes on outside click / Escape. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  // keep the menu inside the page: a toolbar that wraps can put its button at the left edge, where a
  // right-anchored menu would be cut off (and the other way round)
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const p = ref.current.querySelector<HTMLElement>(":scope > .popover");
    if (!p) return;
    const clip = (ref.current.closest(".page") ?? document.body).getBoundingClientRect();
    const r = p.getBoundingClientRect();
    if (r.left < clip.left + 8) { p.style.left = "0"; p.style.right = "auto"; }
    else if (r.right > clip.right - 8) { p.style.right = "0"; p.style.left = "auto"; }
  }, [open]);
  return { open, setOpen, ref };
}

export function Skeleton({ h = 14, w = "100%", style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} aria-hidden="true" />;
}

export function SkeletonList({ rows = 3, h = 52 }: { rows?: number; h?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-busy="true" aria-label="กำลังโหลด">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={h} style={{ borderRadius: 12 }} />)}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="msg-error" role="alert">
      <span>{message}</span>
      {onRetry && <button className="btn" onClick={onRetry}>{th.tryAgain}</button>}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h2>{title}</h2>
      {body && <p style={{ maxWidth: 440 }}>{body}</p>}
      {action}
    </div>
  );
}

export function Logo({ size = 17, mark = 28 }: { size?: number; mark?: number }) {
  return (
    <div className="logo" style={{ fontSize: size }}>
      <div className="logo-mark" style={{ width: mark, height: mark, fontSize: mark / 2, borderRadius: mark / 4 }} aria-hidden="true">I</div>
      <span>IncAsk</span>
    </div>
  );
}
