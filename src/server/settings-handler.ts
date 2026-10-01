/**
 * Settings action orchestration.
 *
 * Input validation stays in the shared settings model; page-state assembly and
 * domain actions live under ./settings/. This file is deliberately only the
 * transport-independent dispatcher and common error envelope.
 */
import {
  normalizeSettingsMessage,
  type SettingsAction,
  type SettingsActionResult,
} from "../bridge/config/settings-model.js";
import {
  buildSettingsState,
  fallbackSettingsState,
} from "./settings/state.js";
import { handleGeneralSettingsAction } from "./settings/general-actions.js";
import { handleAuthSettingsAction } from "./settings/auth-actions.js";
import { handleTunnelSettingsAction } from "./settings/tunnel-actions.js";
import { handleNotifySettingsAction } from "./settings/notify-actions.js";

export { buildSettingsState } from "./settings/state.js";

export async function handleSettingsAction(raw: unknown): Promise<SettingsActionResult> {
  const action = normalizeSettingsMessage(raw);
  if (!action) {
    return { ok: false, state: await buildSettingsState(), error: "无法识别的操作。" };
  }

  try {
    return await dispatch(action);
  } catch (error) {
    return {
      ok: false,
      state: await buildSettingsState().catch(() => fallbackSettingsState()),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function dispatch(action: SettingsAction): Promise<SettingsActionResult> {
  switch (action.command) {
    case "clearStats":
    case "copyPrompt":
    case "copyText":
    case "start":
    case "stop":
    case "rotateEndpoint":
    case "setConcurrency":
    case "setConfig":
      return handleGeneralSettingsAction(action);

    case "setAuthEnabled":
    case "setDefaultTtl":
    case "createToken":
    case "armPublicLock":
    case "hardenWorkspace":
    case "rotateToken":
    case "revokeToken":
    case "deleteToken":
    case "purgeTokens":
    case "revokeAll":
      return handleAuthSettingsAction(action);

    case "saveDomain":
    case "saveNgrokAuthtoken":
    case "autoConfigureTunnel":
    case "refreshTunnelDetect":
      return handleTunnelSettingsAction(action);

    case "saveNotifyKey":
    case "testSound":
    case "stopSound":
    case "testNotify":
      return handleNotifySettingsAction(action);
  }

  return assertHandled(action);
}

function assertHandled(action: never): never {
  throw new Error(`Unhandled console action: ${JSON.stringify(action)}`);
}
