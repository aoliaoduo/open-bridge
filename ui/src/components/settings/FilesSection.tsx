import type { Act, SettingsState } from "../../api";
import { t } from "../../i18n";
import { Card } from "../Card";
import { DraftField } from "./DraftField";
import { SwitchField } from "./SwitchField";
import { setConfigFor } from "./set-config";

/** The 文件访问 sub-page: which paths the bridge may read and write. */
export function FilesSection({ settings, act }: {
  settings: SettingsState;
  act: Act;
}) {
  const cfg = settings.config;
  const setConfig = setConfigFor(act);

  return (
    <Card
      id="set-files"
      title={t("文件访问", "File access")}
      desc={t(
        "默认允许访问项目根之外的路径（个人本机推荐）；关掉之后只有下面列出的目录可读写。",
        "By default paths outside the project root are allowed (recommended for a personal machine); turn it off and only the directories listed below are readable and writable.",
      )}
    >
      <SwitchField
        label={t("允许访问项目根之外的路径", "Allow paths outside the project root")}
        checked={cfg.unrestrictedFileAccess}
        onChange={next => setConfig("unrestrictedFileAccess", next)}
      />
      {!cfg.unrestrictedFileAccess && (
        <div className="field">
          <span className="field-label">{t("允许的目录", "Allowed directories")}</span>
          <span className="field-control">
            {/* A textarea, not an input: HTML value sanitization strips \n from
                text inputs, so the list silently merged into one bogus path
                the moment the operator edited and blurred the field. */}
            <DraftField
              multiline
              value={cfg.allowedDirectories.join("\n")}
              placeholder={t("每行一个绝对目录，如\nC:\\projects\\shared", "One absolute directory per line, e.g.\nC:\\projects\\shared")}
              onCommit={raw => setConfig("allowedDirectories", raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean))}
            />
          </span>
          <span className="field-hint">{t("每行一个绝对目录；失焦时保存", "One absolute directory per line; saved on blur")}</span>
        </div>
      )}
    </Card>
  );
}
