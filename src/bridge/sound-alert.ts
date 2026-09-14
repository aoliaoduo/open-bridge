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
 * A backstop, not a cap.
 *
 * The window is the stop button, so nothing here limits how long a sound may
 * play -- a two-minute track plays for two minutes. This only bounds a host
 * that has wedged without ever showing its window, which would otherwise hold
 * a handle forever. Half an hour is longer than any alert sound and short
 * enough that a stuck process is eventually cleaned up.
 */
const WEDGED_HOST_MS = 30 * 60_000;

/**
 * Playback runs in a VISIBLE window, and that window is the stop button.
 *
 * The first version hid the player and capped it at a few seconds, which
 * solved "I cannot stop this" by making it too short to need stopping. That
 * is not the same thing. An alert that announces a stalled conversation
 * should keep sounding until someone deals with it, and the honest way to
 * make it stoppable is to give it something the operator can close.
 *
 * So: a console window appears, says what it is, and plays the file to its
 * natural end. Closing it kills the host process and the audio with it --
 * no timer, no cap, no separate stop protocol to get wrong. The window IS
 * the affordance.
 */

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

/**
 * Quote one argv entry for a cmd command line.
 *
 * Going through `shell: true` means the whole thing is re-parsed by cmd, so
 * the careful argv array has to survive being flattened back into a string.
 * The PowerShell script contains spaces, quotes and semicolons; without this
 * cmd would split it and hand PowerShell fragments.
 */
function quoteForCmd(value: string): string {
  // Inner double quotes are escaped for cmd by doubling them; the script
  // itself only ever uses single quotes, so this is belt and braces.
  return `"${value.replace(/"/g, "\"\"")}"`;
}

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
    // Launched through cmd's `start`, which is the part that actually creates
    // a window. Measured, because the obvious approaches do not work: a plain
    // spawn of powershell with stdio "ignore" has no console to attach to and
    // exits immediately (code 0, no window, no sound), and `start` without
    // shell:true is not a program -- it is a cmd builtin. Both were tried
    // here before this shape was settled on.
    return {
      command: "powershell",
      args: [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        "$Host.UI.RawUI.WindowTitle = 'Open Bridge 提示音 — 关闭此窗口即停止';"
        + "Add-Type -AssemblyName presentationCore;"
        + "$p = New-Object System.Windows.Media.MediaPlayer;"
        // Single quotes inside a PowerShell single-quoted string are escaped by
        // doubling. Paths cannot otherwise break out: the value came from the
        // validator, which requires an absolute path with an audio extension.
        + `$p.Open([uri]'${file.replace(/'/g, "''")}');`
        // Open() is asynchronous -- a naive Play() plays nothing. Waiting on
        // NaturalDuration is the documented way to know the file has loaded.
        + "$n = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $n -lt 50) { Start-Sleep -Milliseconds 100; $n++ };"
        + "$p.Play();"
        + "Write-Host '';"
        + `Write-Host '  ${file.replace(/'/g, "''").replace(/\r?\n/g, " ")}';`
        + "Write-Host '';"
        + "Write-Host '  关闭这个窗口即可停止播放（或按 Ctrl+C）。';"
        + "Write-Host '  Close this window to stop the sound (or press Ctrl+C).';"
        // Poll instead of sleeping the whole duration: a Start-Sleep that long
        // ignores Ctrl+C until it returns, so the second documented way out
        // would not actually work.
        + "if ($p.NaturalDuration.HasTimeSpan) {"
        + "  $end = (Get-Date).AddMilliseconds($p.NaturalDuration.TimeSpan.TotalMilliseconds);"
        + "  while ((Get-Date) -lt $end) { Start-Sleep -Milliseconds 200 }"
        + "} else { Start-Sleep -Seconds 3 };"
        + "$p.Stop(); $p.Close()",
      ],
    };
  }
  // afplay and paplay run in the foreground of whatever launched them, so the
  // terminal they open in is the equivalent affordance. Untested here: this
  // project is developed on Windows, so they are attempted, not promised.
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

  // Replace, never stack. Clicking 试听 twice used to start a second copy on
  // top of the first, which is precisely what an impatient click does when
  // the first press seemed to do nothing.
  stopAlertSound();

  try {
    const child = process.platform === "win32"
      // shell:true so cmd expands `start`, which is a builtin rather than an
      // executable. The window it opens is the stop button.
      ? spawn(
        `start "" ${player.command} ${player.args.map(quoteForCmd).join(" ")}`,
        { stdio: "ignore", shell: true, detached: true, windowsHide: false },
      )
      : spawn(player.command, player.args, { stdio: "ignore", detached: true });
    // Not a duration cap. The sound plays as long as the file lasts, and the
    // window is how it gets stopped early. This only reclaims a host that
    // wedged without ever showing a window, which would otherwise leak.
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      if (current?.child === child) current = undefined;
    }, WEDGED_HOST_MS);
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
