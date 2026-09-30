import type { JsonArgs } from "./json-args.js";

/**
 * Read a required file-tool argument without ever turning absence into the
 * literal path "undefined".
 */
export function requiredFileArg(args: JsonArgs, key: string): string {
  const value = args[key];
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    throw new Error(
      `Missing "${key}". This operation needs an explicit ${key}; pass a workspace-relative path`
      + " (look it up with list_directory or find_files first).",
    );
  }
  return String(value);
}
