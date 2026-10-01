import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultExplorerMenuText,
  explorerInstallPlan,
  installExplorerIntegration,
  uninstallExplorerIntegration,
} from "../src/platform/windows/explorer.js";
import {
  launchExplorerWorkspace,
  normalizeWindowsWorkspace,
  windowsTerminalLaunchArgs,
} from "../src/platform/windows/launcher.js";
import { externalOpenCommand } from "../src/platform/open-external.js";
import type {
  NativeCommandOptions,
  NativeCommandResult,
  NativeProcessAdapter,
} from "../src/platform/windows/native-process.js";

class FakeRunner implements NativeProcessAdapter {
  public runs: Array<{ file: string; args: string[]; options?: NativeCommandOptions }> = [];
  public launches: Array<{ file: string; args: string[]; options?: NativeCommandOptions }> = [];
  public runResult: NativeCommandResult = { code: 0, stdout: "", stderr: "" };
  public runResults: NativeCommandResult[] = [];
  public runError: Error | undefined;

  async run(file: string, args: string[], options?: NativeCommandOptions): Promise<NativeCommandResult> {
    this.runs.push({ file, args, options });
    if (this.runError) throw this.runError;
    return this.runResults.shift() ?? this.runResult;
  }

  async launch(file: string, args: string[], options?: NativeCommandOptions): Promise<void> {
    this.launches.push({ file, args, options });
  }
}

test("Explorer menu language is selected in Node, not PowerShell", () => {
  assert.equal(defaultExplorerMenuText("zh-CN"), "在此启动 Open Bridge");
  assert.equal(defaultExplorerMenuText("en-US"), "Start Open Bridge Here");
});

test("Explorer registration is a reg.exe argv plan with no shell source text", () => {
  const relay = String.raw`C:\Program Files\Open Bridge\scripts\windows\context-menu-launch.vbs`;
  const plan = explorerInstallPlan(relay, "Start Open Bridge Here");
  assert.equal(plan.length, 8);
  assert.ok(plan.every(operation => operation.file === "reg.exe"));
  const text = JSON.stringify(plan);
  assert.match(text, /HKCU\\\\Software\\\\Classes/);
  assert.match(text, /%1\\\\\./);
  assert.match(text, /%V\\\\\./);
  assert.match(text, /wscript\.exe/);
  assert.doesNotMatch(text, /powershell|cmd\.exe/i);
});

test("Explorer install dry-run is side-effect free and keeps the relay path structured", async () => {
  const runner = new FakeRunner();
  const root = String.raw`C:\repo & unicode 中文`;
  const result = await installExplorerIntegration({
    packageRoot: root,
    platform: "win32",
    dryRun: true,
    runner,
    exists: () => true,
  });
  assert.equal(result.changed, false);
  assert.equal(runner.runs.length, 0);
  const relay = String.raw`C:\repo & unicode 中文\scripts\windows\context-menu-launch.vbs`;
  assert.ok(result.operations.some(operation => operation.args.some(value => value.includes(relay))));
});

test("Explorer uninstall skips absent keys but surfaces a real delete failure", async () => {
  const absent = new FakeRunner();
  absent.runResult = { code: 1, stdout: "", stderr: "missing" };
  const absentResult = await uninstallExplorerIntegration({ platform: "win32", runner: absent });
  assert.equal(absentResult.changed, false);
  assert.equal(absent.runs.length, 2, "one existence probe per registry key; no delete is attempted");
  assert.ok(absent.runs.every(call => call.args[0] === "query"));

  const failing = new FakeRunner();
  failing.runResults.push(
    { code: 0, stdout: "exists", stderr: "" },
    { code: 5, stdout: "", stderr: "access denied" },
  );
  await assert.rejects(
    uninstallExplorerIntegration({ platform: "win32", runner: failing }),
    /remove folder registration \(reg\.exe exit 5\)/,
  );
  assert.deepEqual(failing.runs.map(call => call.args[0]), ["query", "delete"]);
});

test("Windows Terminal launch keeps workspace as one argv item and never synthesizes --root", () => {
  const workspace = String.raw`C:\中文 repo & (x) ! 100%`;
  const args = windowsTerminalLaunchArgs(workspace, String.raw`C:\pkg & root`, String.raw`C:\Node\node.exe`);
  assert.equal(args[4], workspace);
  assert.equal(args.includes("--root"), false);
  assert.deepEqual(args.slice(-2), ["launch", "--open-existing"]);
});

test("Explorer launches Windows Terminal visibly so the TUI is actually reachable", async () => {
  const runner = new FakeRunner();
  const workspace = String.raw`C:\work\visible-tui`;
  const result = await launchExplorerWorkspace({
    workspace,
    packageRoot: String.raw`C:\pkg`,
    platform: "win32",
    terminalPath: String.raw`C:\WindowsApps\wt.exe`,
    nodeExecutable: String.raw`C:\Node\node.exe`,
    directoryExists: () => true,
    runner,
  });

  assert.equal(result.mode, "windows-terminal");
  assert.equal(runner.runs.length, 1);
  assert.equal(runner.runs[0]?.options?.windowsHide, false);
  assert.equal(runner.launches.length, 0);
});

test("Explorer launcher falls back to a detached Node console without a shell", async () => {
  const runner = new FakeRunner();
  runner.runResult = { code: 1, stdout: "", stderr: "terminal failed" };
  const workspace = String.raw`C:\中文 repo & (x)`;
  const result = await launchExplorerWorkspace({
    workspace,
    packageRoot: String.raw`C:\pkg`,
    platform: "win32",
    terminalPath: String.raw`C:\WindowsApps\wt.exe`,
    nodeExecutable: String.raw`C:\Node\node.exe`,
    directoryExists: () => true,
    runner,
  });
  assert.equal(result.mode, "console");
  assert.equal(runner.runs.length, 1);
  assert.equal(runner.launches.length, 1);
  assert.deepEqual(runner.launches[0]?.args, [
    String.raw`C:\pkg\bin\open-bridge.js`,
    "launch",
    "--open-existing",
    "--open",
  ]);
  assert.equal(runner.launches[0]?.options?.cwd, workspace);
});

test("Explorer launcher also falls back when Windows Terminal cannot be spawned", async () => {
  const runner = new FakeRunner();
  runner.runError = new Error("ENOENT");
  const workspace = String.raw`C:\中文 repo & (x)`;
  const result = await launchExplorerWorkspace({
    workspace,
    packageRoot: String.raw`C:\pkg`,
    platform: "win32",
    terminalPath: String.raw`C:\WindowsApps\wt.exe`,
    nodeExecutable: String.raw`C:\Node\node.exe`,
    directoryExists: () => true,
    runner,
  });
  assert.equal(result.mode, "console");
  assert.equal(runner.launches.length, 1);
});

test("workspace normalization removes only an outer quote pair", () => {
  assert.equal(
    normalizeWindowsWorkspace('"D:\\work & x"', String.raw`C:\repo`),
    String.raw`D:\work & x`,
  );
});

test("opening a URL on Windows uses explorer.exe instead of cmd start", () => {
  const command = externalOpenCommand("https://example.test/a?x=1&y=2", "win32");
  assert.deepEqual(command, { file: "explorer.exe", args: ["https://example.test/a?x=1&y=2"] });
});
