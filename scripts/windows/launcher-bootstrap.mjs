import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectBuildRequired } from "./launcher-build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const mode = process.argv[2];

const forwarded = process.argv.slice(3);

if (mode !== "one-click" && mode !== "project") {
  console.error("launcher-bootstrap: expected one-click or project");
  process.exit(2);
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: ROOT,
      stdio: "inherit",
      shell: false,
      ...options,
    });
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
}

async function runNpm(args) {
  if (process.platform === "win32") {
    // npm is a .cmd shim on Windows. This is an intentionally fixed bootstrap
    // command with no user-controlled text; application data never enters cmd.
    return run("cmd.exe", ["/d", "/s", "/c", "npm", ...args]);
  }
  return run("npm", args);
}

if (!existsSync(path.join(ROOT, "node_modules"))) {
  console.log("[open-bridge] installing dependencies (first run)...");
  const code = await runNpm(["install"]);
  if (code !== 0) process.exit(code);
}

const distReady = existsSync(path.join(ROOT, "dist", "cli.js"))
  && existsSync(path.join(ROOT, "dist", "ui", "console.html"));
const buildRequired = !distReady || (mode === "project" && projectBuildRequired(ROOT));
if (buildRequired) {
  console.log("[open-bridge] building CLI and console...");
  const code = await runNpm(["run", "build"]);
  if (code !== 0) process.exit(code);
}

const entry = path.join(ROOT, "bin", "open-bridge.js");
const code = await run(process.execPath, [entry, "windows-launch", mode, ...forwarded]);
process.exit(code);
