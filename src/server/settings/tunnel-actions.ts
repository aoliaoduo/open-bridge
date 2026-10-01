import type { SettingsAction, SettingsActionResult } from "../../bridge/config/settings-model.js";
import {
  autoConfigureTunnel,
  buildTunnelView,
  saveNgrokAuthtoken,
  saveTunnelDomain,
} from "../settings-tunnel.js";
import { buildSettingsState, settingsSuccess } from "./state.js";

export async function handleTunnelSettingsAction(action: SettingsAction): Promise<SettingsActionResult> {
  switch (action.command) {
    case "saveDomain": {
      const outcome = await saveTunnelDomain(action.domain);
      return outcome.ok
        ? settingsSuccess({ info: outcome.info })
        : { ok: false, state: await buildSettingsState(), error: outcome.error };
    }
    case "saveNgrokAuthtoken": {
      const outcome = await saveNgrokAuthtoken(action.token);
      return outcome.ok
        ? settingsSuccess({ info: outcome.info })
        : { ok: false, state: await buildSettingsState(), error: outcome.error };
    }
    case "autoConfigureTunnel": {
      const outcome = await autoConfigureTunnel();
      return outcome.ok
        ? settingsSuccess({ info: outcome.info })
        : { ok: false, state: await buildSettingsState(), error: outcome.error };
    }
    case "refreshTunnelDetect":
      await buildTunnelView(true);
      return settingsSuccess({ info: "已重新检测本机的隧道环境。" });
    default:
      throw new Error(`Tunnel settings handler cannot process ${action.command}.`);
  }
}
