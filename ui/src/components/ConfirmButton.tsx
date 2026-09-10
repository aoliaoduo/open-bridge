import { useState } from "react";

/**
 * Two-step confirm: arms on the first click, fires on the second, disarms when
 * it loses focus. Extracted from TokensTab so the destructive-action pattern has
 * one implementation instead of one per tab.
 */
export function ConfirmButton(
  { label, onConfirm, className = "" }: { label: string; onConfirm: () => void; className?: string },
) {
  const [armed, setArmed] = useState(false);
  if (armed) {
    return (
      <button
        className={`small armed ${className}`}
        onBlur={() => setArmed(false)}
        onClick={() => { setArmed(false); onConfirm(); }}
      >
        确认？
      </button>
    );
  }
  return (
    <button className={`small danger ${className}`} onClick={() => setArmed(true)}>
      {label}
    </button>
  );
}
