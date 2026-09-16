import assert from "node:assert/strict";
import test from "node:test";
import { defaultShellArgs } from "../src/shell/shell-args.js";
import { shellUsageInstructions } from "../src/shell/shell-usage.js";

const BASH = { file: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["-lc"] };
const POWERSHELL = { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] };
type Spec = typeof BASH;

test("the usage line names the resolved interpreter and its invocation verbatim", () => {
  // This is the one fact a connecting model cannot infer for itself; it must
  // be stated, and stated with the exact string the spawner uses.
  for (const spec of [BASH, POWERSHELL] as Spec[]) {
    const text = shellUsageInstructions(spec);
    assert.ok(text.includes(spec.file), `${spec.file} not named in: ${text}`);
    assert.ok(text.includes(spec.args.join(" ")), `args not shown in: ${text}`);
    assert.match(text, /run_command/);
  }
});

test("the coaching matches the interpreter's dialect, not the author's habit", () => {
  assert.match(shellUsageInstructions(BASH), /POSIX shell syntax/);
  // The sentence earns its place by doing this: `2>nul` in bash does not
  // discard errors, it creates a file literally named `nul`.
  assert.match(shellUsageInstructions(BASH), /nul/);
  assert.match(shellUsageInstructions(POWERSHELL), /PowerShell syntax/);
  assert.equal(shellUsageInstructions(POWERSHELL).includes("POSIX shell syntax"), false);
});

test("the dialect classification is the one defaultShellArgs already uses", () => {
  // Two consumers of ONE rule: the args a shell is spawned with, and the
  // dialect the connecting model is coached in. If these ever disagreed, the
  // usage line would lie about the interpreter sitting right beside it.
  for (const file of ["C:/Program Files/Git/bin/bash.exe", "/bin/bash", "/bin/sh", "pwsh.exe", "powershell.exe"]) {
    const spawnedAsPowerShell = defaultShellArgs(file).includes("-Command");
    const coachedAsPowerShell = shellUsageInstructions({ file, args: defaultShellArgs(file) }).includes("PowerShell syntax");
    assert.equal(coachedAsPowerShell, spawnedAsPowerShell, file);
  }
});
