import { useEffect, useRef, useState } from "react";

/**
 * One draft field: edits stay local until blur (or Enter). The previous
 * version called setConfig on EVERY keystroke — each one a config.json write,
 * and intermediate values (a half-typed port, a health timeout below its
 * minimum) fired error toasts on every key.
 *
 * Fields validate on commit: an invalid value is REVERTED to the saved one
 * with a toast, never silently kept — the old behaviour left the input showing
 * a value the config did not hold, and the operator only found out on the next
 * reload.
 *
 * Number fields check the server's bounds. Text fields check `validate` when
 * one is given: that hook exists because the two sound-path fields already
 * passed an onInvalid promising "needs an absolute path to an audio file",
 * and nothing ever called it — the check ran for numbers only, so any string
 * was committed. A mistyped path then failed silently at play time, which is
 * indistinguishable from the feature being switched off.
 */
export function DraftField({
  value,
  onCommit,
  onInvalid,
  validate,
  type = "text",
  min,
  max,
  step,
  placeholder,
  multiline = false,
}: {
  value: string;
  onCommit: (raw: string) => void;
  onInvalid?: () => void;
  /**
   * Accept/reject a non-empty text value. Empty is always allowed and never
   * asked about: clearing a field is how an optional setting is unset, and
   * running a "must be an audio file" check over "" would make it impossible.
   */
  validate?: (raw: string) => boolean;
  type?: "text" | "number";
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** Render a <textarea>: HTML inputs strip newlines from their value, which
   *  silently merged the allowedDirectories list into one bogus path. */
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  // A reply to the previous commit may arrive after the next edit. Only
  // pristine / submitted drafts follow it; newer unsubmitted edits belong to
  // the operator, even when they happen to equal the old saved value.
  const editedSinceCommit = useRef(false);
  useEffect(() => {
    if (!editedSinceCommit.current) setDraft(value);
  }, [value]);
  const change = (next: string): void => {
    editedSinceCommit.current = true;
    setDraft(next);
  };
  const commit = (): void => {
    editedSinceCommit.current = false;
    if (draft === value) return;
    if (type === "number") {
      const n = Number(draft.trim());
      const bad = draft.trim() === ""
        || !Number.isInteger(n)
        || (min !== undefined && n < min)
        || (max !== undefined && n > max);
      if (bad) {
        onInvalid?.();
        setDraft(value);
        return;
      }
    } else if (validate && draft.trim() !== "" && !validate(draft.trim())) {
      onInvalid?.();
      setDraft(value);
      return;
    }
    onCommit(draft);
  };
  if (multiline) {
    return (
      <textarea
        rows={4}
        value={draft}
        placeholder={placeholder}
        onChange={e => change(e.target.value)}
        onBlur={commit}
      />
    );
  }
  return (
    <input
      type={type}
      min={min}
      max={max}
      step={step}
      value={draft}
      placeholder={placeholder}
      onChange={e => change(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}
