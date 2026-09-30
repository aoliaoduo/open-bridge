/** Cross-platform system clipboard adapter for TUI shortcuts. */
import { spawn } from "node:child_process";

export type ClipboardCommand = {
  file: string;
  args: string[];
};

export type ClipboardRunner = (command: ClipboardCommand, text: string) => Promise<void>;

export function clipboardCommands(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardCommand[] {
  if (platform === "win32") return [{ file: "clip.exe", args: [] }];
  if (platform === "darwin") return [{ file: "pbcopy", args: [] }];
  if (platform === "linux") {
    const commands: ClipboardCommand[] = [];
    if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) commands.push({ file: "clip.exe", args: [] });
    commands.push(
      { file: "wl-copy", args: [] },
      { file: "xclip", args: ["-selection", "clipboard"] },
      { file: "xsel", args: ["--clipboard", "--input"] },
    );
    return commands;
  }
  return [];
}

async function runClipboardCommand(command: ClipboardCommand, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const child = spawn(command.file, command.args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    child.on("error", error => finish(error));
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.on("close", code => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `${command.file} exited with code ${String(code)}`));
    });
    child.stdin?.on("error", error => finish(error));
    child.stdin?.end(text, "utf8");
  });
}

export async function copyTextToClipboard(
  text: string,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    run?: ClipboardRunner;
  } = {},
): Promise<void> {
  if (text === "") throw new Error("Clipboard text is empty.");
  const candidates = clipboardCommands(options.platform ?? process.platform, options.env ?? process.env);
  if (candidates.length === 0) throw new Error("No supported system clipboard command is available on this platform.");
  const run = options.run ?? runClipboardCommand;
  let lastError: unknown;
  for (const command of candidates) {
    try {
      await run(command, text);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to write to the system clipboard.");
}
