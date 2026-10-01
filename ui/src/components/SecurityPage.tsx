import { useEffect, useState } from "react";
import { api, type Act, type SettingsState } from "../api";
import { EXPOSURE_META } from "../exposure";
import { errorMessage } from "../format";
import { t } from "../i18n";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";
import { Props as PropList } from "./Props";
import { setConfigFor } from "./settings/set-config";
import { Skeleton } from "./Skeleton";
import { SecurityOAuthCard } from "./SecurityOAuthCard";
import { SecurityTokens } from "./SecurityTokens";

interface Props {
  settings: SettingsState;
  act: Act;
  /** Copy feedback goes through the shell toast, like every other copy path. */
  notify?: (text: string, isError?: boolean) => void;
}

/**
 * The 安全 page: everything that answers "who can reach this instance" in one
 * place — the exposure overview, the Bearer gate, personal tokens, and the
 * OAuth 2.1 server. The cards moved here verbatim (体检's exposure card, the
 * old 令牌 page, 设置's OAuth card); only the assembly is new.
 */
export function SecurityPage({ settings, act, notify }: Props) {
  const cfg = settings.config;
  // Only `exposure` is read from this, and /api/status carries it for ~40ms
  // while /api/health costs ~480ms without a tunnel and a full public round
  // trip with one. The overview was waiting on a health check to render one
  // word. Kept as a HealthReport-shaped value so the render below is
  // unchanged; the extra checks it used to carry were never displayed here.
  const [report, setReport] = useState<{ exposure: string } | null>(null);
  const [note, setNote] = useState("");
  const [arming, setArming] = useState(false);
  const [hardening, setHardening] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);

  const exposure = EXPOSURE_META[report?.exposure ?? ""];

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const status = await api.status();
        if (alive) setReport({ exposure: String(status.exposure ?? "local") });
      } catch (error) {
        if (alive) setNote(errorMessage(error));
      }
    };
    void load();
    return () => { alive = false; };
  }, []);

  /**
   * Re-read the exposure. It is derived server-side from auth.enabled
   * (meta-tools.ts), so anything that moves the gate has to call this or the
   * overview keeps describing the state we just left -- and 当前状态 is the
   * line an operator actually acts on.
   */
  const rereadExposure = async () => {
    try {
      const status = await api.status();
      setReport({ exposure: String(status.exposure ?? "local") });
      // Recovery clears the note a failed load wrote — the same rule the
      // sessions page uses. Success used to leave the old failure on screen.
      setNote("");
    } catch (error) {
      setNote(errorMessage(error));
    }
  };

  const arm = async () => {
    if (arming) return;
    setArming(true);
    try {
      const result = await act({ command: "armPublicLock" });
      if (result?.ok) await rereadExposure();
    } finally {
      setArming(false);
    }
  };

  const hardenWorkspace = async () => {
    if (hardening) return;
    setHardening(true);
    try {
      const result = await act({ command: "hardenWorkspace" });
      if (result?.ok) await rereadExposure();
    } finally {
      setHardening(false);
    }
  };

  /** The plain gate switch changes the same fact the one-step button does.
      It gets the same busy guard the others have: two overlapping toggles
      could land out of order and leave the switch contradicting the server. */
  const toggleGate = async (enabled: boolean) => {
    if (gateBusy) return;
    setGateBusy(true);
    try {
      const result = await act({ command: "setAuthEnabled", enabled });
      if (result?.ok) await rereadExposure();
    } finally {
      setGateBusy(false);
    }
  };

  const rotate = async () => {
    if (rotating) return;
    setRotating(true);
    try {
      // A rotation invalidates the console's own injected token, so the shell
      // reloads the page on success — there is nothing to refresh by hand.
      await act({ command: "rotateEndpoint" });
    } finally {
      setRotating(false);
    }
  };

  const setConfig = setConfigFor(act);

  return (
    <>
      <Card
        title={t("总览", "Overview")}
        desc={t(
          "这个实例现在能被谁访问：地址、暴露等级，以及两道门的开关。",
          "Who can reach this instance right now: the address, the exposure level and both gates.",
        )}
      >
        {report === null ? (
          <Skeleton lines={3} />
        ) : (
          <PropList
            items={[
              { label: t("当前状态", "Current state"), value: <Chip tone={exposure?.tone ?? "idle"}>{exposure ? exposure.label() : report.exposure}</Chip> },
              { label: t("含义", "Meaning"), value: exposure?.text() ?? "—" },
              {
                label: t("地址", "Address"),
                value: (
                  <span className="row-actions">
                    <span className="mono">{settings.mcpUrl}</span>
                    <CopyButton
                      value={settings.mcpUrl}
                      label={t("复制地址", "Copy address")}
                      onCopied={() => notify?.(t("MCP 地址已复制。", "MCP URL copied."))}
                    />
                  </span>
                ),
              },
              {
                label: t("Bearer 门禁", "Bearer gate"),
                value: (
                  <Chip tone={settings.authEnabled ? "ok" : "idle"}>
                    {settings.authEnabled ? t("已开启", "On") : t("已关闭", "Off")}
                  </Chip>
                ),
              },
              {
                label: "OAuth 2.1",
                value: (
                  <Chip tone={cfg["oauth.enabled"] ? "ok" : "idle"}>
                    {cfg["oauth.enabled"] ? t("已开启", "On") : t("已关闭", "Off")}
                  </Chip>
                ),
              },
              {
                label: t("操作", "Actions"),
                value: (
                  <button
                    type="button"
                    className="small icon-text"
                    disabled={rotating || !settings.running}
                    onClick={() => void rotate()}
                    title={t(
                      "换掉 MCP 地址里的路由令牌，旧地址立即失效（控制台会自动重载）",
                      "Replace the route token in the MCP URL; the old address stops working immediately (the console reloads itself)",
                    )}
                  >
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M19 5v5h-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M18.4 10a7 7 0 1 0 .2 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                    {rotating ? t("轮换中…", "Rotating…") : t("轮换端点", "Rotate endpoint")}
                  </button>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        title={t("Bearer 门禁", "Bearer gate")}
        desc={t(
          "打开后，/mcp 的每个请求都必须带 Bearer 令牌；只填 URL 连不上。",
          "Once on, every request to /mcp must carry a Bearer token; the URL alone will not connect.",
        )}
      >
        <div className="form-grid">
          <div className="field">
            <span className="field-label">{t("Bearer 门禁", "Bearer gate")}</span>
            <span className="field-control">
              <span className="check-row">
                <input
                  type="checkbox"
                  className="switch"
                  checked={settings.authEnabled}
                  disabled={gateBusy}
                  onChange={e => void toggleGate(e.target.checked)}
                  aria-label={t("Bearer 门禁", "Bearer gate")}
                />
                <span>{settings.authEnabled ? t("已开启（Bearer）", "On (Bearer)") : t("已关闭", "Off")}</span>
              </span>
            </span>
            <span className="field-hint">
              {settings.authEnabled
                ? t("已开启：请求必须带 Bearer 令牌。", "On: requests must carry a Bearer token.")
                : t("已关闭：只填 URL 即可接入。", "Off: the URL alone is enough to connect.")}
            </span>
          </div>
          <div className="field">
            <span className="field-label">{t("一步完成", "One step")}</span>
            <span className="field-control">
              <ConfirmButton
                className="primary"
                disabled={arming}
                label={arming ? t("启用中…", "Enabling…") : t("签发令牌并启用门禁", "Mint a token and enable the gate")}
                onConfirm={() => void arm()}
              />
            </span>
            <span className="field-hint">
              {t("已有可用令牌时会复用，不多发；明文只显示一次。", "Reuses a usable token if there is one; the plaintext is shown once.")}
            </span>
          </div>
        </div>
      </Card>

      <Card
        title={t("安全预设", "Security preset")}
        desc={t(
          "兼容默认保持不变；需要收紧时，一次启用 Bearer 门禁，并把文件访问限制到当前工作区和显式允许目录。",
          "Compatibility defaults stay unchanged. When you want a tighter setup, one action enables the Bearer gate and restricts file access to this workspace plus explicitly allowed directories.",
        )}
      >
        <div className="form-grid">
          <div className="field span2">
            <span className="field-label">{t("工作区收紧", "Harden workspace")}</span>
            <span className="field-control">
              <ConfirmButton
                className="primary"
                disabled={hardening}
                label={hardening ? t("应用中…", "Applying…") : t("应用安全预设", "Apply security preset")}
                onConfirm={() => void hardenWorkspace()}
              />
            </span>
            <span className="field-hint">
              {t(
                "不会改变默认配置；只在你确认后开启门禁并关闭 unrestrictedFileAccess。已有 allowedDirectories 继续有效。",
                "Does not change defaults. Only after confirmation it enables the gate and turns off unrestrictedFileAccess; existing allowedDirectories remain valid.",
              )}
            </span>
          </div>
        </div>
      </Card>

      <SecurityTokens settings={settings} act={act} notify={notify} />

      <SecurityOAuthCard
        enabled={cfg["oauth.enabled"]}
        hosts={cfg["oauth.allowedRedirectHosts"]}
        setConfig={setConfig}
      />

      {note && <div className="card section-note">{note}</div>}
    </>
  );
}
