import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const STAMP_VERSION = 2;
const STAMP_FILE = ".open-bridge-project-build.json";

function statOrUndefined(file) {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

function isBuildInput(file) {
  const name = path.basename(file).toLowerCase();
  return !name.includes(".test.") && !name.includes(".spec.");
}

function visitBuildInputs(root, current, out) {
  const stat = statOrUndefined(current);
  if (!stat) {
    out.push({ relative: path.relative(root, current), missing: true });
    return;
  }

  if (stat.isDirectory()) {
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      out.push({ relative: path.relative(root, current), missing: true });
      return;
    }
    for (const entry of entries) visitBuildInputs(root, path.join(current, entry.name), out);
    return;
  }

  if (!stat.isFile() || !isBuildInput(current)) return;
  out.push({ relative: path.relative(root, current), file: current });
}

function fingerprintEntries(root, inputs) {
  const entries = [];
  for (const input of inputs) visitBuildInputs(root, input, entries);
  entries.sort((a, b) => a.relative.localeCompare(b.relative));

  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.relative.replaceAll("\\", "/"));
    hash.update("\0");
    if (entry.missing) hash.update("<missing>");
    else hash.update(readFileSync(entry.file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function projectBuildInputs(root) {
  return [
    path.join(root, "src"),
    path.join(root, "ui"),
    path.join(root, "config", "vite.config.ts"),
    path.join(root, "scripts", "clean.mjs"),
    path.join(root, "tsconfig.json"),
    path.join(root, "tsconfig.ui.json"),
    path.join(root, "package.json"),
    path.join(root, "package-lock.json"),
  ];
}

function dependencyInputs(root) {
  return [
    path.join(root, "package.json"),
    path.join(root, "package-lock.json"),
  ];
}

export function projectBuildFingerprint(root) {
  return fingerprintEntries(root, projectBuildInputs(root));
}

export function projectDependencyFingerprint(root) {
  return fingerprintEntries(root, dependencyInputs(root));
}

function stampPath(root) {
  return path.join(root, STAMP_FILE);
}

export function writeProjectBuildStamp(root) {
  const payload = {
    version: STAMP_VERSION,
    fingerprint: projectBuildFingerprint(root),
    dependencies: projectDependencyFingerprint(root),
  };
  writeFileSync(stampPath(root), JSON.stringify(payload) + "\n", "utf8");
  return payload;
}

function readProjectBuildStamp(root) {
  try {
    const parsed = JSON.parse(readFileSync(stampPath(root), "utf8"));
    if (
      parsed?.version !== STAMP_VERSION
      || typeof parsed?.fingerprint !== "string"
      || typeof parsed?.dependencies !== "string"
    ) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function projectDependencyInstallRequired(root) {
  if (!statOrUndefined(path.join(root, "node_modules"))?.isDirectory()) return true;
  const stamp = readProjectBuildStamp(root);
  if (!stamp) return true;
  return stamp.dependencies !== projectDependencyFingerprint(root);
}

/**
 * Does the source-checkout project launcher need a full rebuild?
 *
 * This is content-based, not timestamp-based. Files restored from archives,
 * copied from another checkout, or checked out with older mtimes can still
 * contain different source. The local stamp records the exact production inputs
 * that produced dist; only an exact match is accepted as current.
 */
export function projectBuildRequired(root) {
  const coreOutput = statOrUndefined(path.join(root, "dist", "cli.js"));
  const uiOutput = statOrUndefined(path.join(root, "dist", "ui", "console.html"));
  if (!coreOutput?.isFile() || !uiOutput?.isFile()) return true;

  const stamp = readProjectBuildStamp(root);
  if (!stamp) return true;
  return stamp.fingerprint !== projectBuildFingerprint(root);
}
