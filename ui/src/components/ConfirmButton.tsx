import { useState } from "react";

/**
 * Two-step confirm: arms on the first click, fires on the second, disarms when
 * it loses focus. Extracted from TokensTab so the destructive-action pattern has
 * one implementation instead of one per tab.
 *
 * `disabled` freezes both states: an in-flight destructive action (arming the
 * public lock, closing a session) used to stay clickable because this component
 * had no way to receive the caller's busy state — the label changed but the
 * button did not.
 */
export function ConfirmButton(
  { label, onConfirm, className = "", disabled = false }: { label: string; onConfirm: () => void; className?: string; disabled?: boolean },
) {
  const [armed, setArmed] = useState(false);
  if (armed) {
    return (
      <button
        className={`small armed ${className}`}
        disabled={disabled}
        onBlur={() => setArmed(false)}
        onClick={() => { setArmed(false); onConfirm(); }}
      >
        确认？
      </button>
    );
  }
  return (
    <button className={`small danger ${className}`} disabled={disabled} onClick={() => setArmed(true)}>
      {label}
    </button>
  );
}
