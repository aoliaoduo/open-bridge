import type { Act, SettingsState } from "../../api";
import { t } from "../../i18n";
import { Card } from "../Card";
import { DraftField } from "./DraftField";
import { Field } from "../Field";
import { NUMBER_BOUNDS, invalidBounds } from "./bounds";
import { setConfigFor } from "./set-config";

/** The 网络 sub-page: the local listen port and the public health-check timeout. */
export function NetworkSection({ settings, act, notify }: {
  settings: SettingsState;
  act: Act;
  notify?: (text: string, isError?: boolean) => void;
}) {
  const cfg = settings.config;
  const setConfig = setConfigFor(act);
  const invalidFor = invalidBounds(notify);

  /**
   * Commit a number the DraftField has already validated against NUMBER_BOUNDS
   * (it reverts and reports the rejection itself, via `invalidFor`). Re-checking
   * here would be a second copy of the same rule that can only ever agree.
   */
  const commitNumber = (key: keyof typeof NUMBER_BOUNDS, raw: string): void => {
    setConfig(key, Number(raw.trim()));
  };

  return (
    <Card
      id="set-network"
      title={t("网络", "Network")}
      desc={t("本机监听端口与公网健康检查的超时。", "The local listen port and the public health-check timeout.")}
    >
      <div className="form-grid">
        <Field
          label={t("本地端口", "Local port")}
          hint={t("0 = 自动选择空闲端口（重启 Bridge 生效）；失焦时保存。", "0 picks a free port automatically (takes effect after a restart); saved on blur.")}
        >
          <DraftField
            type="number"
            min={NUMBER_BOUNDS.port.min}
            max={NUMBER_BOUNDS.port.max}
            value={String(cfg.port)}
            onCommit={raw => commitNumber("port", raw)}
            onInvalid={invalidFor("port")}
          />
        </Field>
        <Field
          label={t("公网健康检查", "Public health check")}
          hint={t("毫秒（3000–120000）；失焦时保存。", "Milliseconds (3000–120000); saved on blur.")}
        >
          <DraftField
            type="number"
            min={NUMBER_BOUNDS.publicHealthTimeoutMs.min}
            max={NUMBER_BOUNDS.publicHealthTimeoutMs.max}
            step={1000}
            value={String(cfg.publicHealthTimeoutMs)}
            onCommit={raw => commitNumber("publicHealthTimeoutMs", raw)}
            onInvalid={invalidFor("publicHealthTimeoutMs")}
          />
        </Field>
      </div>
    </Card>
  );
}
