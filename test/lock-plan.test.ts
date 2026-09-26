import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";
import { deriveLockPlan, type LockPlanContext } from "../src/bridge/tools/lock-plan.js";

const ROOT = path.resolve("C:/ws");

/** Fake context: paths resolve under a fixed root, patches declare their targets. */
function ctx(overrides: Partial<LockPlanContext> = {}): LockPlanContext {
  return {
    resolvePath: input => (path.isAbsolute(input) ? path.resolve(input) : path.join(ROOT, input)),
    workspaceRoot: () => ROOT,
    patchTargets: async () => [],
    servicesInGroup: () => [],
    ...overrides,
  };
}

/** File keys are lowercased on Windows; mirror that in expectations. */
const fk = (p: string): string => {
  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.join(ROOT, p);
  return `file:${process.platform === "win32" ? resolved.toLowerCase() : resolved}`;
};

test("single-path write tools lock exactly that file", async () => {
  for (const tool of ["write_file"]) {
    const plan = await deriveLockPlan(tool, { path: "src/a.ts" }, ctx());
    assert.deepEqual(plan?.keys, [fk("src/a.ts")], tool);
    assert.equal(plan?.mode, "write");
  }
  // The file system family routes by operation: create/delete are single-path.
  for (const op of ["create_directory", "delete"]) {
    const plan = await deriveLockPlan("file_op", { op, path: "src/a.ts" }, ctx());
    assert.deepEqual(plan?.keys, [fk("src/a.ts")], op);
    assert.equal(plan?.mode, "write");
  }
});

test("path casing follows the platform's file-system semantics", async () => {
  const upper = await deriveLockPlan("write_file", { path: "SRC/A.TS" }, ctx());
  const lower = await deriveLockPlan("write_file", { path: "src/a.ts" }, ctx());
  if (process.platform === "win32") {
    // Windows file systems fold case: the two spellings name one file, so they
    // must not be able to hold two independent locks on it.
    assert.deepEqual(upper?.keys, lower?.keys);
  } else {
    // POSIX keeps them distinct; folding case here would wrongly serialize
    // (and alias) two genuinely different files.
    assert.notDeepEqual(upper?.keys, lower?.keys);
  }
});

test("pair tools lock both source and destination", async () => {
  const plan = await deriveLockPlan("file_op", { op: "move", source: "a.ts", destination: "b.ts" }, ctx());
  assert.deepEqual(plan?.keys, [fk("a.ts"), fk("b.ts")].sort());
});

test("edit_block locks only the primary path — every hunk applies to it", async () => {
  // The planner used to lock edits[].path as well, pinning a contract the
  // handler never had: the handler applies every hunk to args.path and ignores
  // per-edit paths, so a stray path field produced a phantom lock on a file
  // the call never touches. The handler now refuses a mismatched per-edit
  // path, and the planner protects exactly the file that is edited.
  const plan = await deriveLockPlan(
    "edit_block",
    { path: "a.ts", edits: [{ path: "b.ts" }, { path: "c.ts" }] },
    ctx(),
  );
  assert.deepEqual(plan?.keys, [fk("a.ts")]);
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
  for (const tool of ["process_control", "set_process_policy"]) {
    const plan = await deriveLockPlan(tool, { command_id: "abc123" }, ctx());
    assert.deepEqual(plan?.keys, ["cmd:abc123"], tool);
    assert.equal(plan?.handOffToProcess, false);
  }
  assert.equal(await deriveLockPlan("process_control", { action: "terminate" }, ctx()), undefined, "no id, no lock");
});

test("service lifecycle tools serialize per service, and all_* on the group's concrete services", async () => {
  for (const action of ["start", "stop", "restart", "delete"]) {
    assert.deepEqual((await deriveLockPlan("service", { action, name: "API" }, ctx()))?.keys, ["svc:api"], action);
  }
  // all_* expands to the concrete services it will touch (exact-key matching):
  // a literal "svc:*" never conflicted with "svc:<name>", so a stop-all could
  // interleave with an individual start/restart of the same service.
  const all = await deriveLockPlan("service", { action: "start_all" }, ctx({
    servicesInGroup: () => ["api", "web"],
  }));
  assert.deepEqual(all?.keys, ["svc:api", "svc:web"]);
  const web = await deriveLockPlan("service", { action: "stop_all", group: "Web" }, ctx({
    servicesInGroup: group => (group === "web" ? ["api", "web"] : []),
  }));
  assert.deepEqual(web?.keys, ["svc:api", "svc:web"]);
  const empty = await deriveLockPlan("service", { action: "start_all" }, ctx());
  assert.equal(empty, undefined, "no saved services, nothing to serialize");
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
