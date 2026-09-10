import { createHash } from "node:crypto";

export const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

/** Reject stale writes without exposing the current file content. */
export function assertExpectedHash(content: string, expected: unknown, label: string): void {
  if (expected === undefined || expected === "") return;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error("expected_sha256 must be a 64-character SHA-256 hex digest.");
  }
  if (sha256(content) !== expected.toLowerCase()) {
    throw new Error(`File changed since it was read: ${label}. Read it again before writing.`);
  }
}
