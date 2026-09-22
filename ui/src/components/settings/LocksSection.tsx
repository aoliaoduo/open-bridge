import type { Act, SettingsState } from "../../api";
import { t } from "../../i18n";
import { Card } from "../Card";
import { DraftField } from "./DraftField";
import { Field } from "../Field";
import { SwitchField } from "./SwitchField";
import { NUMBER_BOUNDS, invalidBounds } from "./bounds";

/** The 并发锁 sub-page: serialize racing tool calls and their timeouts. */
export function LocksSection({ settings, act, notify }: {
  settings: SettingsState;
  act: Act;
  notify?: (text: string, isError?: boolean) => void;
}) {
  const invalidFor = invalidBounds(notify);

  return (
    <Card
      id="set-locks"
      title={t("并发锁", "Concurrency locks")}
      desc={t(
        "并发写同一个目录时让第二个调用者等待，而不是互相覆盖。",
        "When two calls write the same directory, the second waits instead of the two overwriting each other.",
      )}
    >
      <SwitchField
        label={t("串行化可能产生竞争的工具调用", "Serialize tool calls that could race")}
        checked={settings.concurrency.enabled}
        onChange={next => void act({
          command: "setConcurrency",
          enabled: next,
          holdTimeoutMs: settings.concurrency.holdTimeoutMs,
          waitTimeoutMs: settings.concurrency.waitTimeoutMs,
        })}
      />
      {settings.concurrency.enabled && (
        <div className="form-grid">
          <Field label={t("占用上限", "Hold ceiling")} hint={t("毫秒，0 = 不限；失焦时保存。", "Milliseconds, 0 = unlimited; saved on blur.")}>
            <DraftField
              type="number"
              min={NUMBER_BOUNDS.holdTimeoutMs.min}
              max={NUMBER_BOUNDS.holdTimeoutMs.max}
              value={String(settings.concurrency.holdTimeoutMs)}
              onCommit={raw => void act({
                command: "setConcurrency",
                enabled: true,
                holdTimeoutMs: Number(raw.trim()),
                waitTimeoutMs: settings.concurrency.waitTimeoutMs,
              })}
              onInvalid={invalidFor("holdTimeoutMs")}
            />
          </Field>
          <Field label={t("等待上限", "Wait ceiling")} hint={t("毫秒，0 = 无限等待；失焦时保存。", "Milliseconds, 0 = wait forever; saved on blur.")}>
            <DraftField
              type="number"
              min={NUMBER_BOUNDS.waitTimeoutMs.min}
              max={NUMBER_BOUNDS.waitTimeoutMs.max}
              value={String(settings.concurrency.waitTimeoutMs)}
              onCommit={raw => void act({
                command: "setConcurrency",
                enabled: true,
                holdTimeoutMs: settings.concurrency.holdTimeoutMs,
                waitTimeoutMs: Number(raw.trim()),
              })}
              onInvalid={invalidFor("waitTimeoutMs")}
            />
          </Field>
        </div>
      )}
    </Card>
  );
}
