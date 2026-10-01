import { readdirSync, statSync } from "node:fs";
import path from "node:path";

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

export function newestInputMtimeMs(paths) {
  let newest = 0;

  const visit = current => {
    const stat = statOrUndefined(current);
    if (!stat) return;

    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) visit(path.join(current, entry.name));
      return;
    }

    if (!stat.isFile() || !isBuildInput(current)) return;
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  };

  for (const input of paths) visit(input);
  return newest;
}

function outputMtimeMs(file) {
  const stat = statOrUndefined(file);
  return stat?.isFile() ? stat.mtimeMs : 0;
}

/**
 * Does the source-checkout project launcher need a full rebuild?
 *
 * The old launcher rebuilt on every project restart. That rewrote dist even
 * when source was unchanged, so every other workspace instance using this
 * checkout immediately reported build_stale=true. Compare the build inputs to
 * representative core/UI outputs instead: a normal restart does not mutate
 * dist, while a real source/UI/config change still rebuilds before launch.
 */
export function projectBuildRequired(root) {
  const coreOutput = outputMtimeMs(path.join(root, "dist", "cli.js"));
  const uiOutput = outputMtimeMs(path.join(root, "dist", "ui", "console.html"));
  if (coreOutput === 0 || uiOutput === 0) return true;

  const coreInput = newestInputMtimeMs([
    path.join(root, "src"),
    path.join(root, "tsconfig.json"),
    path.join(root, "package.json"),
  ]);
  const uiInput = newestInputMtimeMs([
    path.join(root, "ui"),
    path.join(root, "config", "vite.config.ts"),
    path.join(root, "tsconfig.ui.json"),
    path.join(root, "package.json"),
  ]);

  return coreInput > coreOutput || uiInput > uiOutput;
}
