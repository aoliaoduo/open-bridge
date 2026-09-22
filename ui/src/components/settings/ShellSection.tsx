import type { Act, SettingsState } from "../../api";
import { t } from "../../i18n";
import { Card } from "../Card";
import { ExecutablePicker } from "../ExecutablePicker";
import { DraftField } from "./DraftField";
import { Field } from "../Field";
import { setConfigFor } from "./set-config";

/** The Shell sub-page: which shell commands run through, and with what args. */
export function ShellSection({ settings, act }: {
  settings: SettingsState;
  act: Act;
}) {
  const cfg = settings.config;
  const setConfig = setConfigFor(act);
  // What the server found on this machine. Defaulted because an older server
  // (or a hand-built fixture) may not send it, and a missing list must degrade
  // to "type a path", never to a crashed settings page.
  const shells = settings.detected?.shells ?? [];
  // Name what 自动 will actually do, so choosing it is not an act of faith.
  const autoShellLabel = shells[0]
    ? `${shells[0].label} — ${shells[0].value}`
    : t("按平台猜测", "a per-platform guess");

  return (
    <Card
      id="set-shell"
      title={t("Shell", "Shell")}
      desc={t("命令通过哪个 shell 执行。", "Which shell commands run through.")}
    >
      <div className="form-grid">
        <Field
          label={t("Shell 路径", "Shell path")}
          hint={shells.length
            ? t(
              `已在这台机器上找到 ${shells.length} 个 shell，选一个即可；自动 = 列表里的第一个。`,
              `Found ${shells.length} shells on this machine — pick one, or leave it on automatic (the first in the list).`,
            )
            : t(
              "没有探测到已知的 shell，请手动填写完整路径。",
              "No known shell was detected; type the full path instead.",
            )}
        >
          <ExecutablePicker
            value={cfg.shellPath}
            choices={shells}
            autoValues={[""]}
            autoLabel={autoShellLabel}
            placeholder={t("shell 可执行文件的完整路径", "Full path to a shell executable")}
            onCommit={next => setConfig("shellPath", next)}
          />
        </Field>
        <Field label={t("Shell 参数", "Shell arguments")} hint={t("每行一个参数；含空格的参数无需加引号。留空使用默认参数。", "One argument per line; arguments with spaces need no quoting. Leave empty for the defaults.")}>
          {/* One per line, like allowedDirectories: the old join(" ")/split(/\s+/)
              round-trip could not express an argument containing a space
              ("C:\Program Files\...") or an empty one, and saving once
              permanently split such an argument into two. */}
          <DraftField
            multiline
            value={cfg.shellArgs.join("\n")}
            placeholder={t("留空使用默认参数", "Leave empty for the defaults")}
            onCommit={raw => setConfig("shellArgs", raw.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0))}
          />
        </Field>
      </div>
    </Card>
  );
}
