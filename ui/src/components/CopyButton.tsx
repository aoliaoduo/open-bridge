import { useEffect, useRef, useState } from "react";
import { copyText } from "../api";

/**
 * Inline copy affordance with its own confirmation.
 *
 * The console had copy buttons only for the MCP URL and prompts; every other
 * identifier (session id, token id, service port, log path) had to be selected
 * by hand. Putting the button next to the value is what the reference tables
 * do, and the label flips to 已复制 for a moment so the operator does not have
 * to trust a toast to know which row was copied.
 */
export function CopyButton(
  { value, label = "复制", onCopied, disabled = false, title, className = "" }: {
    value: string;
    label?: string;
    /** Optional shell notification; the button confirms itself either way. */
    onCopied?: () => void;
    disabled?: boolean;
    title?: string;
    className?: string;
  },
) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      className={`copy-btn ${done ? "done" : ""} ${className}`.trim()}
      disabled={disabled}
      title={title ?? `${label}：${value}`}
      aria-label={done ? `${label}（已复制）` : label}
      onClick={() => {
        void copyText(value).then(() => {
          setDone(true);
          onCopied?.();
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {done
          ? <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          : <>
            <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
            <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </>}
      </svg>
      {done ? "已复制" : label}
    </button>
  );
}
