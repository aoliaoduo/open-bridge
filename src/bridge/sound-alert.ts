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

/**
 * A preview is a few seconds, not a song.
 *
 * The first version played the file to its natural end, so pressing 试听 on a
 * four-minute track meant four minutes of music with no way to stop it -- and
 * pressing it again while wondering why nothing seemed to happen started a
 * SECOND copy over the first. Both halves of that were design mistakes: an
 * audition should be short by construction, and a player that can be started
 * must be stoppable.
 */
const PREVIEW_MS = 6_000;

/**
 * The one live player, if any.
 *
 * Single-slot on purpose. Alerts overlapping each other is already unpleasant;
 * previews overlapping each other because the operator clicked twice is worse,
 * because the natural reaction to "I heard nothing" is to click again. Starting
 * a sound now stops whatever was playing first.
 */
let current: { child: ReturnType<typeof spawn>; timer: NodeJS.Timeout } | undefined;

/** Stop whatever is playing. Safe to call when nothing is. */
export function stopAlertSound(): boolean {
  if (!current) return false;
  const { child, timer } = current;
  current = undefined;
  clearTimeout(timer);
  try {
    // The PowerShell host owns the audio; killing it is what silences the
    // speaker. tree-kill is not needed -- MediaPlayer runs in-process.
    child.kill();
  } catch { /* already exited */ }
  return true;
}

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
function playerCommand(file: string, maxMs: number): { command: string; args: string[] } | undefined {
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
        + `if ($p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds ([Math]::Min($p.NaturalDuration.TimeSpan.TotalMilliseconds, ${maxMs})) }`
        + `else { Start-Sleep -Milliseconds ([Math]::Min(2000, ${maxMs})) };`
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
export function playAlertSound(file: string, options: { preview?: boolean } = {}): SoundAlertResult {
  const path = file.trim();
  if (!path) return { played: false, reason: "no_file" };

  // Checked at play time as well as at save time: a file that existed when it
  // was configured can be gone by the time it matters, and "the sound silently
  // stopped working" is worse than a line in the log.
  if (!fsSync.existsSync(path)) {
    record("notify", "error", `本机提示音文件不存在：${path}`);
    return { played: false, reason: "missing_file" };
  }

  const limitMs = options.preview ? PREVIEW_MS : PLAY_TIMEOUT_MS;
  const player = playerCommand(path, limitMs);
  if (!player) return { played: false, reason: "unsupported_platform" };

  // Replace, never stack. Clicking 试听 twice used to start a second copy on
  // top of the first, which is precisely what an impatient click does when
  // the first press seemed to do nothing.
  stopAlertSound();

  try {
    const child = spawn(player.command, player.args, {
      stdio: "ignore",
      windowsHide: true,
      // Detached so a bridge shutdown mid-chime does not kill the sound, and
      // unref'd so a playing sound cannot hold the process open.
      detached: false,
    });
    // The backstop is a second past the player's own limit: normally the
    // script ends on its own, and this only fires when PowerShell itself is
    // wedged. Without it, a hung host holds the speaker until the bridge
    // stops -- which is the shape of the bug being fixed here.
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      if (current?.child === child) current = undefined;
    }, limitMs + 1_000);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      if (current?.child === child) current = undefined;
    });
    child.once("error", error => {
      clearTimeout(timer);
      if (current?.child === child) current = undefined;
      record("notify", "error", `本机提示音播放失败：${error.message}`);
    });
    current = { child, timer };
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
