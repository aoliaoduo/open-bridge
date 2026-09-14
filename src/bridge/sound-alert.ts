/**
 * Play a sound file on the machine the bridge runs on.
 *
 * The phone channel answers "I am away from the desk". This one answers the
 * other half: sitting right here, tab in the background, and the AI is waiting
 * on an answer it will wait for forever. A push to the phone works for that
 * too, but reaching for a phone to learn something about the screen in front
 * of you is a silly loop, and plenty of people run this without Bark at all.
 *
 * Design constraints, all learned from the notify channel next door:
 *
 *  - Never throws into the caller. A sound is an observer of the work; a
 *    broken speaker, a deleted file or a locked-down PowerShell must not turn
 *    a finished task into a failed tool call.
 *  - Fire and forget, with a hard timeout. A 40-minute podcast in the path
 *    field must not leave a child process running for 40 minutes, and an
 *    alert that outlives the event it announces is noise.
 *  - Only plays a file the operator named in config. The path never comes
 *    from a tool argument, so a model cannot make the machine play arbitrary
 *    audio, and the value is validated when it is saved rather than when it
 *    is used.
 */

import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import { host } from "../host/host.js";
import { record } from "./state.js";

/**
 * How long a player is allowed to live. Long enough for any reasonable alert
 * chime, short enough that a wrong file cannot hold the speaker hostage.
 */
const PLAY_TIMEOUT_MS = 15_000;

/** Extensions the Windows player handles. Checked at save time, not here. */
export const SOUND_EXTENSIONS = [".wav", ".mp3", ".m4a", ".aac", ".wma", ".flac"] as const;

export interface SoundAlertResult {
  played: boolean;
  /** "" when played; otherwise why not, in words the settings page can show. */
  reason: string;
}

/**
 * Build the argv for the current platform, or undefined when there is no
 * player we can rely on.
 *
 * Windows goes through PowerShell's MediaPlayer rather than SoundPlayer:
 * SoundPlayer is WAV-only, and someone who points this at their favourite mp3
 * should not get silence with no explanation. Both were measured on the
 * development machine before this shipped.
 *
 * macOS and Linux get their standard players. They are untested here -- this
 * project is developed on Windows -- so they are attempted rather than
 * promised, and a missing binary reports itself like any other failure.
 */
function playerCommand(file: string): { command: string; args: string[] } | undefined {
  if (process.platform === "win32") {
    // -WindowStyle Hidden keeps a console from flashing on every alert.
    return {
      command: "powershell",
      args: [
        "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
        // The player is asynchronous: Open() returns before the audio is
        // ready, so a naive Play() plays nothing. Waiting on NaturalDuration
        // is the documented way to know it has loaded.
        "Add-Type -AssemblyName presentationCore;"
        + "$p = New-Object System.Windows.Media.MediaPlayer;"
        + `$p.Open([uri]'${file.replace(/'/g, "''")}');`
        + "$n = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $n -lt 50) { Start-Sleep -Milliseconds 100; $n++ };"
        + "$p.Play();"
        + "if ($p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds ([Math]::Min($p.NaturalDuration.TimeSpan.TotalMilliseconds, 12000)) }"
        + "else { Start-Sleep -Milliseconds 2000 };"
        + "$p.Stop(); $p.Close()",
      ],
    };
  }
  if (process.platform === "darwin") return { command: "afplay", args: [file] };
  return { command: "paplay", args: [file] };
}

/**
 * Play the configured alert sound.
 *
 * Returns rather than throws, and the reason strings are the same vocabulary
 * the notify channel uses ("disabled", "no_file", …) so the two channels can
 * be reported side by side without a translation layer.
 */
export function playAlertSound(file: string): SoundAlertResult {
  const path = file.trim();
  if (!path) return { played: false, reason: "no_file" };

  // Checked at play time as well as at save time: a file that existed when it
  // was configured can be gone by the time it matters, and "the sound silently
  // stopped working" is worse than a line in the log.
  if (!fsSync.existsSync(path)) {
    record("notify", "error", `本机提示音文件不存在：${path}`);
    return { played: false, reason: "missing_file" };
  }

  const player = playerCommand(path);
  if (!player) return { played: false, reason: "unsupported_platform" };

  try {
    const child = spawn(player.command, player.args, {
      stdio: "ignore",
      windowsHide: true,
      // Detached so a bridge shutdown mid-chime does not kill the sound, and
      // unref'd so a playing sound cannot hold the process open.
      detached: false,
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
    }, PLAY_TIMEOUT_MS);
    timer.unref?.();
    child.once("exit", () => clearTimeout(timer));
    child.once("error", error => {
      clearTimeout(timer);
      record("notify", "error", `本机提示音播放失败：${error.message}`);
    });
    child.unref();
    return { played: true, reason: "" };
  } catch (error) {
    record("notify", "error", `本机提示音无法启动播放器：${error instanceof Error ? error.message : String(error)}`);
    return { played: false, reason: "player_failed" };
  }
}

/** Resolve the configured path for one event, or "" when this event is silent. */
export function soundFileForEvent(event: "attention" | "waiting" | "finished" | "progress"): string {
  const cfg = host().config;
  if (cfg.get<boolean>("sound.enabled", false) !== true) return "";
  // Only the two blocking events and the end of an exchange can make a noise
  // by default. A chime on every ticked todo is how someone ends up muting
  // the whole feature.
  const key = event === "attention" || event === "waiting"
    ? "sound.fileWaiting"
    : event === "finished" ? "sound.fileFinished" : "";
  if (!key) return "";
  return String(cfg.get<string>(key, "") ?? "").trim();
}
