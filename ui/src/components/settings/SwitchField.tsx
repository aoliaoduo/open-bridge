
/** A switch field: label on top, the switch plus its current state under it. */
export function SwitchField(
  { label, hint, checked, onChange }: {
    label: string;
    hint?: string;
    checked: boolean;
    onChange: (next: boolean) => void;
  },
) {
  return (
    <div className="field">
      {/* The label text is NOT inside the <label>, on purpose. Wrapping it
          makes the whole line a click target, and on a page that is mostly
          labelled rows that means a stray click anywhere near a setting
          silently flips it -- the kind of mistake you only notice later, by
          its consequences. The switch keeps its accessible name through
          aria-label, so a screen reader still announces which setting it is;
          only the pointer target shrinks to the control itself. */}
      <span className="check-row">
        <input
          type="checkbox"
          className="switch"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          aria-label={label}
        />
        <span className="field-label">{label}</span>
      </span>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}
