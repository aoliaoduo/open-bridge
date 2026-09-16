import { availableChoices, findOnPath, isWindowsStoreAlias, resolveDetectEnv, type DetectEnv, type ExecutableChoice } from "../shell/which.js";

/** What `ngrokExecutable: ""` (or the literal default "ngrok") ends up running. */
export const NGROK_ON_PATH = "ngrok";

/**
 * Where ngrok actually lands on a machine, best first.
 *
 * The setting was a text box with the placeholder "ngrok", which is only
 * useful advice to someone who already put ngrok on PATH. Everyone else
 * downloaded a zip, unpacked it into Downloads or a tools folder, and met the
 * result as `ngrok executable not found` after the tunnel failed to start.
 * Probing the handful of places installers use turns that into a pick-list.
 *
 * PATH is checked first on purpose: if ngrok is on PATH then that is the copy
 * the operator's own terminal runs, and the bridge disagreeing with their
 * terminal is a confusing thing to debug.
 */
export function detectNgrok(given: DetectEnv = {}): ExecutableChoice[] {
  const { platform, env } = resolveDetectEnv(given);
  const home = env.USERPROFILE ?? env.HOME ?? "";
  const onPath = findOnPath(NGROK_ON_PATH, given);
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? (home ? `${home}\\AppData\\Local` : "");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return availableChoices([
      { value: onPath, label: onPath && isWindowsStoreAlias(onPath) ? "PATH（Microsoft Store 版）" : "PATH" },
      // The same directory without PATH: how a machine that has never opened a
      // terminal still ends up with ngrok.
      { value: localAppData ? `${localAppData}\\Microsoft\\WindowsApps\\ngrok.exe` : undefined, label: "Microsoft Store" },
      // Chocolatey, Scoop and winget each have one canonical place.
      { value: "C:\\ProgramData\\chocolatey\\bin\\ngrok.exe", label: "Chocolatey" },
      { value: home ? `${home}\\scoop\\shims\\ngrok.exe` : undefined, label: "Scoop" },
      { value: localAppData ? `${localAppData}\\Microsoft\\WinGet\\Links\\ngrok.exe` : undefined, label: "winget" },
      { value: `${programFiles}\\ngrok\\ngrok.exe`, label: "Program Files" },
      // The zip-into-Downloads path, which is how most people first get it.
      { value: home ? `${home}\\Downloads\\ngrok.exe` : undefined, label: "Downloads" },
    ], given);
  }
  return availableChoices([
    { value: onPath, label: "PATH" },
    { value: "/usr/local/bin/ngrok", label: "/usr/local/bin" },
    { value: "/opt/homebrew/bin/ngrok", label: "Homebrew" },
    { value: "/snap/bin/ngrok", label: "Snap" },
    { value: home ? `${home}/bin/ngrok` : undefined, label: "~/bin" },
  ], given);
}
