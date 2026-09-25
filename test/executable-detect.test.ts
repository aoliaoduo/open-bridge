import { test } from "node:test";
import assert from "node:assert/strict";
import { autoShell, detectShells } from "../src/shell/shell-provider.js";
import { detectNgrok } from "../src/bridge/tunnel/ngrok-locate.js";
import { findOnPath } from "../src/shell/which.js";

/**
 * Detection exists so the two "type a path here" settings stop being a quiz.
 * Every case below injects its own filesystem and PATH: asserting against the
 * real machine would make the suite pass or fail on what the runner happens to
 * have installed, which is the opposite of a test.
 */

const win = (present: string[], pathEnv = "") => ({
  platform: "win32" as NodeJS.Platform,
  exists: (file: string) => present.includes(file),
  pathEnv,
  pathExt: ".COM;.EXE;.BAT;.CMD",
  env: { ProgramFiles: "C:\\Program Files", USERPROFILE: "C:\\Users\\dev" },
});

const nix = (present: string[], pathEnv = "") => ({
  platform: "linux" as NodeJS.Platform,
  exists: (file: string) => present.includes(file),
  pathEnv,
  env: { HOME: "/home/dev" },
});

test("PATH lookup applies PATHEXT, because 'ngrok' on Windows is ngrok.exe", () => {
  const env = win(["C:\\tools\\ngrok.exe"], "C:\\nope;C:\\tools");
  assert.equal(findOnPath("ngrok", env), "C:\\tools\\ngrok.exe",
    "the extension is supplied by the lookup, not by the caller");

  // An extension already given is taken literally — no .exe.exe.
  assert.equal(findOnPath("ngrok.exe", env), "C:\\tools\\ngrok.exe");
  // And a miss is undefined rather than an optimistic path.
  assert.equal(findOnPath("pwsh", env), undefined);
});

test("PATH entries that are quoted or empty do not derail the search", () => {
  // Both are common on real Windows machines; an empty entry means "current
  // directory", which is not somewhere to go looking for a system shell.
  const env = win(["C:\\tools\\ngrok.exe"], ';"C:\\tools";');
  assert.equal(findOnPath("ngrok", env), "C:\\tools\\ngrok.exe");
});

test("on Windows the shells are offered in the order an agent wants them", () => {
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const choices = detectShells(win([gitBash, pwsh]));

  assert.deepEqual(choices.map(choice => choice.value), [gitBash, pwsh, "powershell.exe"]);
  assert.deepEqual(choices.map(choice => choice.label),
    ["Git Bash", "PowerShell 7", "Windows PowerShell"]);
  // Agent-written commands are POSIX far more often than not, so Git Bash is
  // what an empty shellPath resolves to when it is installed.
  assert.equal(autoShell(win([gitBash, pwsh])), gitBash);
});

test("a machine without Git Bash still gets a working shell, never an empty list", () => {
  const choices = detectShells(win([]));
  assert.deepEqual(choices.map(choice => choice.value), ["powershell.exe"],
    "Windows PowerShell ships with the OS, so it is always offerable");
  assert.equal(autoShell(win([])), "powershell.exe");
  assert.equal(autoShell(nix([])), "/bin/bash", "and the POSIX fallback is the usual one");
});

test("a shell found only on PATH is still offered under its own name", () => {
  // Git for Windows installed somewhere else entirely: the well-known path
  // misses, PATH does not, and the operator should not have to care which.
  const choices = detectShells(win(["D:\\dev\\git\\bin\\bash.exe"], "D:\\dev\\git\\bin"));
  assert.equal(choices[0]?.value, "D:\\dev\\git\\bin\\bash.exe");
  assert.equal(choices[0]?.label, "Git Bash");
});

test("POSIX shells are listed by preference and deduplicated", () => {
  const choices = detectShells(nix(["/bin/bash", "/bin/sh"], "/bin"));
  assert.deepEqual(choices.map(choice => choice.value), ["/bin/bash", "/bin/sh"],
    "zsh is absent because it is not installed, and /bin/bash appears once");
});

test("ngrok is looked for where installers actually put it", () => {
  const choices = detectNgrok(win(["C:\\ProgramData\\chocolatey\\bin\\ngrok.exe"]));
  assert.deepEqual(choices, [{
    value: "C:\\ProgramData\\chocolatey\\bin\\ngrok.exe",
    label: "Chocolatey",
    available: true,
  }]);

  // The unpacked-zip-in-Downloads case, which is how most people first get it.
  const downloads = detectNgrok(win(["C:\\Users\\dev\\Downloads\\ngrok.exe"]));
  assert.equal(downloads[0]?.label, "Downloads");
});

test("a guessed install path that is not on disk never reaches the picker", () => {
  // The whole point of probing: offering a path that does not exist would just
  // move the spawn failure into the dropdown.
  assert.deepEqual(detectNgrok(win([])), []);
  assert.deepEqual(detectNgrok(nix([])), []);
});

test("PATH wins over the install locations, so the bridge agrees with the terminal", () => {
  const choices = detectNgrok(win(
    ["C:\\tools\\ngrok.exe", "C:\\ProgramData\\chocolatey\\bin\\ngrok.exe"],
    "C:\\tools",
  ));
  assert.equal(choices[0]?.label, "PATH");
  assert.equal(choices[0]?.value, "C:\\tools\\ngrok.exe");
  assert.equal(choices.length, 2, "the other copy is still listed, just not first");
});

test("the same binary reached two ways is one entry, not two", () => {
  // Homebrew's ngrok is on PATH as well; the operator should see one choice.
  const choices = detectNgrok(nix(["/opt/homebrew/bin/ngrok"], "/opt/homebrew/bin"));
  assert.deepEqual(choices.map(choice => choice.value), ["/opt/homebrew/bin/ngrok"]);
  assert.equal(choices[0]?.label, "PATH", "first spelling wins, as declared");
});

/**
 * ngrok installed from the Microsoft Store reaches PATH as an *App Execution
 * Alias*: `…\Microsoft\WindowsApps\ngrok.exe` is a reparse point that the
 * kernel resolves at CreateProcess time, so `existsSync` — which follows the
 * link — answers no for a program the operator runs every day. The card
 * believed `existsSync`, told a machine with a working ngrok to go download
 * ngrok, and never filled the executable path in.
 */
const storeAliasEnv = (alias: string, dir: string) => ({
  platform: "win32" as NodeJS.Platform,
  exists: () => false,                                  // what existsSync says about an alias
  lstat: (file: string) => (file === alias ? { isSymbolicLink: () => true } : null),
  pathEnv: dir,
  pathExt: ".COM;.EXE;.BAT;.CMD",
  env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local", USERPROFILE: "C:\\Users\\dev" },
});

test("a Store app's alias on PATH counts as an installed ngrok", () => {
  const dir = "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps";
  const alias = `${dir}\\ngrok.exe`;

  assert.equal(findOnPath("ngrok", storeAliasEnv(alias, dir)), alias,
    "the name resolves, because CreateProcess resolves it");
  const choices = detectNgrok(storeAliasEnv(alias, dir));
  assert.equal(choices[0]?.value, alias);
  // Labelled, because the path looks like a stub and the operator has to be
  // able to tell it apart from the zip they unpacked themselves.
  assert.equal(choices[0]?.label, "PATH（Microsoft Store 版）");
});

test("POSIX keeps the strict rule: a dangling symlink is not a program", () => {
  const env = {
    platform: "linux" as NodeJS.Platform,
    exists: () => false,
    lstat: () => ({ isSymbolicLink: () => true }),
    pathEnv: "/usr/local/bin",
    env: { HOME: "/home/dev" },
  };
  assert.equal(findOnPath("ngrok", env), undefined);
});

test("a WSL System32 bash.exe never takes the Git Bash slot", () => {
  // WSL ships bash.exe in the Windows system directories; running agent
  // commands through it means Linux PATH, no PATHEXT, silently lost env, and
  // a service-log tee that turns "C:/..." into a RELATIVE path. It must be
  // refused even when it is the only bash on PATH, and the resolver must
  // fall through to PowerShell.
  const system32Bash = "C:\\Windows\\System32\\bash.exe";
  const choices = detectShells(win([system32Bash], "C:\\Windows\\System32"));
  assert.equal(choices.some(choice => choice.label === "Git Bash"), false,
    "System32 bash.exe is WSL, not Git Bash");
  assert.equal(autoShell(win([system32Bash], "C:\\Windows\\System32")), "powershell.exe",
    "without a real bash, the automatic default is PowerShell");
});
