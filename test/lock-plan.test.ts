import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";
import { deriveLockPlan, type LockPlanContext } from "../src/bridge/lock-plan.js";

const ROOT = path.resolve("C:/ws");

/** Fake context: paths resolve under a fixed root, patches declare their targets. */
function ctx(overrides: Partial<LockPlanContext> = {}): LockPlanContext {
  return {
    resolvePath: input => (path.isAbsolute(input) ? path.resolve(input) : path.join(ROOT, input)),
    workspaceRoot: () => ROOT,
    patchTargets: async () => [],
    ...overrides,
  };
}

/** File keys are lowercased on Windows; mirror that in expectations. */
const fk = (p: string): string => {
  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.join(ROOT, p);
  return `file:${process.platform === "win32" ? resolved.toLowerCase() : resolved}`;
};

test("single-path write tools lock exactly that file", async () => {
  for (const tool of ["write_file", "create_directory", "delete_file"]) {
    const plan = await deriveLockPlan(tool, { path: "src/a.ts" }, ctx());
    assert.deepEqual(plan?.keys, [fk("src/a.ts")], tool);
    assert.equal(plan?.mode, "write");
  }
});

test("path casing cannot split one file's lock on Windows", async () => {
  const upper = await deriveLockPlan("write_file", { path: "SRC/A.TS" }, ctx());
  const lower = await deriveLockPlan("write_file", { path: "src/a.ts" }, ctx());
  assert.deepEqual(upper?.keys, lower?.keys);
});

test("pair tools lock both source and destination", async () => {
  const plan = await deriveLockPlan("move_file", { source: "a.ts", destination: "b.ts" }, ctx());
  assert.deepEqual(plan?.keys, [fk("a.ts"), fk("b.ts")].sort());
});

test("edit_block locks the primary path plus every edits[] target", async () => {
  const plan = await deriveLockPlan(
    "edit_block",
    { path: "a.ts", edits: [{ path: "b.ts" }, { path: "c.ts" }] },
    ctx(),
  );
  assert.deepEqual(plan?.keys, [fk("a.ts"), fk("b.ts"), fk("c.ts")].sort());
});

test("read_files takes shared read locks; discovery tools take none", async () => {
  const plan = await deriveLockPlan("read_files", { paths: ["a.ts", "b.ts"] }, ctx());
  assert.equal(plan?.mode, "read");
  assert.deepEqual(plan?.keys, [fk("a.ts"), fk("b.ts")].sort());

  for (const tool of ["search_files", "find_files", "list_directory", "review_changes", "batch", "get_process_snapshot", "read_process_output", "wait_process", "workspace_brief"]) {
    assert.equal(await deriveLockPlan(tool, { path: "a.ts", paths: ["a.ts"] }, ctx()), undefined, tool);
  }
});

test("apply_patch locks the files the patch targets", async () => {
  const plan = await deriveLockPlan("apply_patch", { patch: "*** Update File: src/a.ts" }, ctx({
    patchTargets: async () => [`${ROOT}${path.sep}src${path.sep}a.ts`, `${ROOT}${path.sep}src${path.sep}b.ts`],
  }));
  assert.deepEqual(plan?.keys, [fk(path.join("src", "a.ts")), fk(path.join("src", "b.ts"))].sort());
});

test("an unresolvable patch still serializes against other patches", async () => {
  const plan = await deriveLockPlan("apply_patch", { patch: "garbage" }, ctx({ patchTargets: async () => [] }));
  assert.deepEqual(plan?.keys, [fk(ROOT)]);
});

test("process lifecycle tools serialize per command id", async () => {
  for (const tool of ["force_terminate", "restart_process", "set_process_policy"]) {
    const plan = await deriveLockPlan(tool, { command_id: "abc123" }, ctx());
    assert.deepEqual(plan?.keys, ["cmd:abc123"], tool);
    assert.equal(plan?.handOffToProcess, false);
  }
  assert.equal(await deriveLockPlan("force_terminate", {}, ctx()), undefined, "no id, no lock");
});

test("service lifecycle tools serialize per service, and all_* on the group", async () => {
  for (const tool of ["start_service", "stop_service", "restart_service", "delete_service"]) {
    assert.deepEqual((await deriveLockPlan(tool, { name: "API" }, ctx()))?.keys, ["svc:api"], tool);
  }
  assert.deepEqual((await deriveLockPlan("start_all_services", {}, ctx()))?.keys, ["svc:*"]);
  assert.deepEqual((await deriveLockPlan("stop_all_services", { group: "Web" }, ctx()))?.keys, ["svc:web"]);
});

test("declared resource keys are locked and handed to the process", async () => {
  const plan = await deriveLockPlan("start_process", { command: "npm run dev", resource_keys: ["Port:5173", "  build:dist  "] }, ctx());
  assert.deepEqual(plan?.keys, ["res:build:dist", "res:port:5173"]);
  assert.equal(plan?.handOffToProcess, true);

  const noKeys = await deriveLockPlan("start_process", { command: "npm run dev" }, ctx());
  assert.equal(noKeys, undefined, "an ordinary spawn declares no resources");
});

test("bad resource_keys are ignored rather than throwing", async () => {
  const plan = await deriveLockPlan("run_command", { command: "x", resource_keys: [1, "", "  ", null, "ok"] }, ctx());
  assert.deepEqual(plan?.keys, ["res:ok"]);
});

test("duplicate keys collapse and the label names the owning tool", async () => {
  const plan = await deriveLockPlan("write_file", { path: "a.ts" }, ctx());
  assert.equal(plan?.label, `write_file · ${fk("a.ts")}`);
  const deduped = await deriveLockPlan("read_files", { paths: ["a.ts", "a.ts", "./a.ts"] }, ctx());
  assert.equal(deduped?.keys.length, 1);
});
