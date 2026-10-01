import { spawn } from "node:child_process";

export interface NativeCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  windowsHide?: boolean;
}

export interface NativeCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface NativeProcessAdapter {
  run(file: string, args: string[], options?: NativeCommandOptions): Promise<NativeCommandResult>;
  launch(file: string, args: string[], options?: NativeCommandOptions): Promise<void>;
}

/**
 * Node's argv-based process boundary. All Windows integration should prefer
 * this over shell command strings: CreateProcess quoting stays in one tested
 * place and user-controlled paths never become PowerShell/cmd source text.
 */
export const nodeNativeProcessAdapter: NativeProcessAdapter = {
  async run(file, args, options = {}) {
    return new Promise<NativeCommandResult>((resolve, reject) => {
      const child = spawn(file, args, {
        cwd: options.cwd,
        windowsHide: options.windowsHide ?? true,
        timeout: options.timeoutMs,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.on("error", fail);
      child.stdout.on("data", chunk => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      child.stderr.on("data", chunk => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      child.on("close", code => {
        if (settled) return;
        settled = true;
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  },

  async launch(file, args, options = {}) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, args, {
        cwd: options.cwd,
        detached: true,
        windowsHide: options.windowsHide ?? false,
        shell: false,
        stdio: "ignore",
      });
      let settled = false;
      child.once("error", error => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve();
      });
    });
  },
};
