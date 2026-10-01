import { useCallback, useEffect, useState } from "react";
import { api, type Act, type SettingsState, type SettingsTunnelView } from "../../api";
import { t } from "../../i18n";
import { Card } from "../Card";
import { setConfigFor } from "./set-config";
import { TunnelAdvancedSettings } from "./TunnelAdvancedSettings";
import {
  TunnelProviderFields,
  type TunnelConfigKey,
} from "./TunnelProviderFields";
import { TunnelStatusActions } from "./TunnelStatusActions";

/**
 * Tunnel settings composition root.
 *
 * Detection stays here because all three child sections consume the same
 * snapshot. Provider/domain editing, status actions and advanced provider knobs
 * own their own interaction state.
 */
export function TunnelSection({ settings, act }: {
  settings: SettingsState;
  act: Act;
}) {
  const [tunnel, setTunnel] = useState<SettingsTunnelView | null>(null);

  const reloadTunnel = useCallback(async () => {
    try {
      setTunnel(await api.tunnel());
    } catch {
      // Detection is advisory: manual controls remain usable without it.
      setTunnel(null);
    }
  }, []);

  useEffect(() => {
    void reloadTunnel();
  }, [reloadTunnel]);

  const setConfig = setConfigFor(act);
  const setTunnelConfig = async (key: TunnelConfigKey, value: string): Promise<void> => {
    const result = await act({ command: "setConfig", key, value });
    if (result?.ok) await reloadTunnel();
  };

  return (
    <Card
      id="set-tunnel"
      title={t("隧道", "Tunnel")}
      desc={t(
        "隧道让公网上的客户端连到这台机器；不开隧道时只有本机能访问。",
        "A tunnel lets clients on the internet reach this machine; without one, only this machine can.",
      )}
    >
      <div className="form-grid">
        <TunnelProviderFields
          settings={settings}
          act={act}
          tunnel={tunnel}
          onConfig={setTunnelConfig}
          onReload={reloadTunnel}
        />
        <TunnelStatusActions
          settings={settings}
          act={act}
          tunnel={tunnel}
          onReload={reloadTunnel}
        />
        <TunnelAdvancedSettings
          settings={settings}
          act={act}
          tunnel={tunnel}
          onConfig={setTunnelConfig}
          onSetConfig={setConfig}
          onReload={reloadTunnel}
        />
      </div>
    </Card>
  );
}
