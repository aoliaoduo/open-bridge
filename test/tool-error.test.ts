import assert from "node:assert/strict";
import test from "node:test";
import { describeToolError } from "../src/bridge/tool-error.js";

test("P7 input-error prose has stable typed details", () => {
  assert.deepEqual(
    describeToolError(
      "write_file",
      "Missing one of \"content\" or \"content_base64\". write_file requires a text or Base64 payload.",
    ),
    {
      kind: "missing",
      tool: "write_file",
      fields: ["content", "content_base64"],
      message: "Missing one of \"content\" or \"content_base64\". write_file requires a text or Base64 payload.",
    },
  );

  assert.deepEqual(
    describeToolError(
      "service",
      "Invalid \"action\" value \"explode\" for service. Expected one of: start, stop.",
    ),
    {
      kind: "invalid",
      tool: "service",
      fields: ["action"],
      message: "Invalid \"action\" value \"explode\" for service. Expected one of: start, stop.",
    },
  );

  assert.deepEqual(
    describeToolError(
      "apply_patch",
      "Conflict: provide exactly one of \"patch\" or \"patch_file\". apply_patch needs one patch source.",
    ),
    {
      kind: "conflict",
      tool: "apply_patch",
      fields: ["patch", "patch_file"],
      message: "Conflict: provide exactly one of \"patch\" or \"patch_file\". apply_patch needs one patch source.",
    },
  );
});

test("domain-error prose is deliberately left text-only", () => {
  assert.equal(describeToolError("read_files", "Missing file: notes.txt"), undefined);
});
