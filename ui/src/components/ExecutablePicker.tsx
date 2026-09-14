import { useState } from "react";
import type { ExecutableChoice } from "../api";
import { t } from "../i18n";

/**
 * Pick an executable from what the machine actually has, or type a path.
 *
 * Both settings this replaces (Shell 路径 and ngrok 可执行文件) were a bare text
 * box whose placeholder described what to type. That asks the operator to know
 * where Git Bash installed itself, and punishes a wrong guess much later, as a
 * spawn failure in a log line. The server already knows how to find these
 * binaries — it has to, to pick a default — so the same list is offered here.
 *
 * The text box has not gone away, it moved behind 手动填写: detection covers the
 * common installs, not every install, and a picker with no escape hatch is a
 * worse box than the one it replaced.
 */
export function ExecutablePicker({
  value,
  choices,
  autoValues,
  autoLabel,
  onCommit,
  placeholder,
}: {
  /** Currently stored value. */
  value: string;
  /** What detection found on this machine, best first. */
  choices: ExecutableChoice[];
  /**
   * Stored values that all mean "let the bridge decide"; the first is what
   * gets written when 自动 is chosen. Two entries exist because ngrok's
   * historical default is the literal "ngrok" while an empty string means the
   * same thing — the operator should see one option, not two.
   */
  autoValues: string[];
  /** What 自动 resolves to right now, so the choice is not taken on faith. */
  autoLabel: string;
  onCommit: (next: string) => void;
  placeholder?: string;
}) {
  const isAuto = autoValues.includes(value.trim());
  const known = choices.some(choice => choice.value === value);
  // A stored path detection does not know about is a deliberate choice, not a
  // mistake: open in manual mode rather than silently re-selecting something.
  const [manual, setManual] = useState(!isAuto && !known);
  const [draft, setDraft] = useState(value);

  const selectValue = manual ? "__manual__" : (isAuto ? "__auto__" : value);

  return (
    <>
      <select
        value={selectValue}
        onChange={event => {
          const next = event.target.value;
          if (next === "__manual__") {
            // Seed the box with the current value so switching to manual is an
            // edit of what is there, not a blank slate.
            setDraft(value);
            setManual(true);
            return;
          }
          setManual(false);
          onCommit(next === "__auto__" ? (autoValues[0] ?? "") : next);
        }}
      >
        <option value="__auto__">{t(`自动（${autoLabel}）`, `Automatic (${autoLabel})`)}</option>
        {choices.map(choice => (
          <option key={choice.value} value={choice.value}>{`${choice.label} — ${choice.value}`}</option>
        ))}
        <option value="__manual__">{t("手动填写路径…", "Type a path…")}</option>
      </select>
      {manual && (
        <input
          type="text"
          value={draft}
          placeholder={placeholder}
          onChange={event => setDraft(event.target.value)}
          onBlur={() => { if (draft !== value) onCommit(draft); }}
          onKeyDown={event => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
        />
      )}
    </>
  );
}
