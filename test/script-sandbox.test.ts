/**
 * Unit tests for `run_script`'s Code Mode sandbox (src/bridge/script-sandbox.ts).
 *
 * These run the real worker and the real `vm` context — a fake tool table stands
 * in for the dispatcher, so what is exercised is the sandbox contract itself:
 * what a script can reach, what it gets back, how a failure is described, and
 * where the hard caps bite. The pure helpers (source normalization, JSON
 * safety, truncation, clamps, hints) are covered directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NON_SCRIPTABLE_TOOLS,
  SCRIPT_LIMITS,
  clampScriptCalls,
  clampScriptTimeout,
  normalizeScriptSource,
  runScriptInSandbox,
  safeJsonText,
  scriptCodePreview,
  scriptFailureHint,
  truncateScriptText,
  type ScriptRunEnvelope,
} from "../src/bridge/script-sandbox.js";

interface Harness {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  run: (source: string, options?: { timeoutMs?: number; maxCalls?: number; limits?: Partial<typeof SCRIPT_LIMITS>; tools?: string[] }) => Promise<ScriptRunEnvelope>;
}

function harness(
  handler: (name: string, args: Record<string, unknown>) => unknown = (name, args) => ({ tool: name, args }),
  tools: string[] = ["read_files", "search_files", "write_file", "run_command"],
): Harness {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    run: (source, options = {}) =>
      runScriptInSandbox({
        source,
        timeoutMs: options.timeoutMs ?? 5_000,
        maxCalls: options.maxCalls,
        ...(options.limits ? { limits: options.limits } : {}),
        allowedTools: new Set(options.tools ?? tools),
        callTool: async (name, args) => {
          calls.push({ name, args });
          return await handler(name, args);
        },
      }),
  };
}

test("a script returns the value of its top-level return", async () => {
  const h = harness();
  const envelope = await h.run('return { hello: "world", n: 41 + 1 };');
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.deepEqual(envelope.result, { hello: "world", n: 42 });
  assert.equal(envelope.calls, 0);
  assert.deepEqual(envelope.by_tool, {});
});

test("composing tools: a loop inside one script replaces N roundtrips", async () => {
  const h = harness();
  const envelope = await h.run(`
    const out = [];
    for (const path of ["a.txt", "b.txt", "c.txt"]) {
      const file = await tools.read_files({ path });
      out.push(file.args.path);
    }
    return out;
  `);
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.deepEqual(envelope.result, ["a.txt", "b.txt", "c.txt"]);
  assert.equal(envelope.calls, 3);
  assert.deepEqual(envelope.by_tool, { read_files: 3 });
  assert.equal(h.calls.length, 3, "every composed call reached the Bridge exactly once");
});

test("Promise.all keeps its call order in the returned value", async () => {
  const h = harness(async (name, args) => {
    await new Promise(resolve => setTimeout(resolve, args.path === "slow" ? 30 : 1));
    return args.path;
  });
  const envelope = await h.run(`
    const [a, b] = await Promise.all([tools.read_files({ path: "slow" }), tools.read_files({ path: "fast" })]);
    return [a, b];
  `);
  assert.deepEqual(envelope.result, ["slow", "fast"], "await order, not completion order");
  assert.equal(envelope.calls, 2);
});

test("console output is captured in the envelope and never replaces the return", async () => {
  const h = harness();
  const withLogs = await h.run('console.log("looking", { at: 1 }); return "done";');
  assert.equal(withLogs.ok, true);
  assert.equal(withLogs.result, "done");
  assert.deepEqual(withLogs.console, ['[log] looking {"at":1}']);

  const noReturn = await h.run('console.log("I did things");');
  assert.equal(noReturn.ok, false);
  assert.equal(noReturn.phase, "return");
  assert.equal(noReturn.error_type, "NoReturn");
  assert.deepEqual(noReturn.console, ["[log] I did things"], "the log is still reported");
  assert.match(String(noReturn.hint), /top-level `return`/);
});

test("each run is a fresh scope, and the failure says so at the right line", async () => {
  const h = harness();
  const first = await h.run("const secret = 7;\nreturn secret;");
  assert.equal(first.result, 7);

  const second = await h.run("const doubled = secret * 2;\nreturn doubled;");
  assert.equal(second.ok, false);
  assert.equal(second.error_type, "ReferenceError");
  assert.equal(second.line, 1, "line numbers are the caller's own coordinates");
  assert.equal(second.column !== undefined, true);
  assert.match(String(second.code_preview?.[0]), /^> 1 \| const doubled = secret \* 2;$/);
  assert.match(String(second.hint), /fresh scope/);
});

test("a failing tool call is catchable, and uncaught it names the tool", async () => {
  const h = harness(name => {
    if (name === "run_command") throw new Error("Exit code 1: nope");
    return "fine";
  });
  const uncaught = await h.run('return await tools.run_command({ command: "false" });');
  assert.equal(uncaught.ok, false);
  assert.equal(uncaught.error_type, "ToolError");
  assert.equal(uncaught.tool, "run_command");
  assert.match(String(uncaught.error), /Exit code 1: nope/);
  assert.match(String(uncaught.hint), /try\/catch/);

  const caught = await h.run(`
    try {
      await tools.run_command({ command: "false" });
      return "unreachable";
    } catch (error) {
      return { handled: true, tool: error.tool, message: String(error.message) };
    }
  `);
  assert.equal(caught.ok, true, JSON.stringify(caught));
  assert.deepEqual(caught.result, { handled: true, tool: "run_command", message: "Exit code 1: nope" });
});

test("only the instance's advertised tools exist, and a typo gets a suggestion", async () => {
  const h = harness();
  const typo = await h.run('return await tools.read_fil({ path: "x" });');
  assert.equal(typo.ok, false);
  assert.match(String(typo.error), /Unknown tool "read_fil"/);
  assert.match(String(typo.error), /read_files/);

  const filtered = await h.run('return await tools.write_file({ path: "x", content: "y" });', { tools: ["read_files"] });
  assert.equal(filtered.ok, false);
  assert.match(String(filtered.error), /Unknown tool "write_file"/, "the session's catalog decides, not a fixed list");
});

test("run_script and batch are not scriptable", async () => {
  const h = harness(undefined, ["read_files", "run_script", "batch"]);
  for (const tool of NON_SCRIPTABLE_TOOLS) {
    const envelope = await h.run(`return await tools.${tool}({});`);
    assert.equal(envelope.ok, false, tool);
    assert.match(String(envelope.error), new RegExp(`${tool} cannot be called from inside a script`));
  }
});

test("the tool-call budget is enforced with a distinct phase", async () => {
  const h = harness();
  const envelope = await h.run(
    `
      const out = [];
      for (let i = 0; i < 5; i += 1) out.push(await tools.read_files({ path: "f" + i }));
      return out.length;
    `,
    { maxCalls: 2 },
  );
  assert.equal(envelope.ok, false);
  assert.equal(envelope.phase, "limit");
  assert.equal(envelope.error_type, "CallLimitError");
  assert.equal(h.calls.length, 2, "the third call never reached the Bridge");
});

test("an endless script is stopped by the wall clock (async hang and sync spin)", async () => {
  const h = harness();
  const hung = await h.run("await new Promise(() => {});", { timeoutMs: 1_000 });
  assert.equal(hung.ok, false);
  assert.equal(hung.phase, "timeout");
  assert.match(String(hung.hint), /wall-clock budget/);

  const spun = await h.run("let n = 0;\nwhile (true) { n += 1; }", { timeoutMs: 1_000 });
  assert.equal(spun.ok, false);
  assert.equal(spun.phase, "timeout");
});

test("the sandbox itself has no filesystem, network, process or timers", async () => {
  const h = harness();
  const envelope = await h.run(`
    const surface = {
      fetch: typeof fetch,
      require: typeof require,
      process: typeof process,
      setTimeout: typeof setTimeout,
      setInterval: typeof setInterval,
      module: typeof module,
    };
    let evalBlocked = false;
    try { eval("1 + 1"); } catch (error) { evalBlocked = true; }
    let functionBlocked = false;
    try { new Function("return 1")(); } catch (error) { functionBlocked = true; }
    let importBlocked = false;
    try { await import("node:fs"); } catch (error) { importBlocked = true; }
    return { ...surface, evalBlocked, functionBlocked, importBlocked };
  `);
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.deepEqual(envelope.result, {
    fetch: "undefined",
    require: "undefined",
    process: "undefined",
    setTimeout: "undefined",
    setInterval: "undefined",
    module: "undefined",
    evalBlocked: true,
    functionBlocked: true,
    importBlocked: true,
  });
});

test("a host function is not reachable through the tool surface's prototype", async () => {
  // The escape this pins: `tools.<name>` used to BE a host-realm arrow function,
  // so `.constructor` was the worker's Function and
  // tools.read_files.constructor("return process")() returned the real
  // `process` — from there getBuiltinModule("node:child_process").execSync ran
  // arbitrary commands, bypassing the dispatcher, the resource locks, the audit
  // log and the workspace sandbox. The RESERVED name list could not stop it:
  // that list filters property NAMES on the proxy, while the leak lived in the
  // prototype of a value the proxy had already returned.
  const h = harness();
  const envelope = await h.run(
    'const realm = {};\n'
    + 'for (const name of ["read_files", "search_files", "write_file", "run_command"]) {\n'
    + '  const fn = tools[name];\n'
    + '  let viaConstructor = "unreached";\n'
    + '  try { viaConstructor = typeof fn.constructor("return process"); }\n'
    + '  catch (error) { viaConstructor = "blocked:" + error.name; }\n'
    + '  realm[name] = { callable: typeof fn, viaConstructor };\n'
    + '}\n'
    + 'let viaConsole = "unreached";\n'
    + 'try { viaConsole = typeof console.log.constructor("return process"); }\n'
    + 'catch (error) { viaConsole = "blocked:" + error.name; }\n'
    + 'let viaArrayIterator = "unreached";\n'
    + 'try { viaArrayIterator = typeof Object.keys(tools).entries.constructor("return process"); }\n'
    + 'catch (error) { viaArrayIterator = "blocked:" + error.name; }\n'
    + 'return { realm, viaConsole, viaArrayIterator };',
  );
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const result = envelope.result as {
    realm: Record<string, { callable: string; viaConstructor: string }>;
    viaConsole: string;
    viaArrayIterator: string;
  };
  for (const name of ["read_files", "search_files", "write_file", "run_command"]) {
    assert.equal(result.realm[name]?.callable, "function", `${name} is still callable`);
    assert.match(
      String(result.realm[name]?.viaConstructor),
      /^blocked:/,
      `tools.${name}.constructor must not reach the host realm: ${result.realm[name]?.viaConstructor}`,
    );
  }
  assert.match(String(result.viaConsole), /^blocked:/, `console.log.constructor leaked: ${result.viaConsole}`);
  assert.match(String(result.viaArrayIterator), /^blocked:/, `an array iterator leaked: ${result.viaArrayIterator}`);
});

test("the tool surface still behaves like the catalogue it replaces", async () => {
  // The hardening must not cost a capability: enumeration, `in`, and the
  // unknown-name path (which reaches the dispatcher so a typo gets its
  // did-you-mean suggestion) keep the shape callers already rely on.
  const h = harness();
  const envelope = await h.run(
    'const seen = [];\n'
    + 'for (const name of Object.keys(tools)) seen.push(name);\n'
    + 'return {\n'
    + '  keys: seen.sort(),\n'
    + '  inOperator: "read_files" in tools,\n'
    + '  reserved: [tools.then, tools.constructor, tools.__proto__, tools.toJSON].map(v => String(v)),\n'
    + '};',
  );
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const result = envelope.result as { keys: string[]; inOperator: boolean; reserved: string[] };
  assert.deepEqual(result.keys, ["read_files", "run_command", "search_files", "write_file"]);
  assert.equal(result.inOperator, true);
  assert.deepEqual(result.reserved, ["undefined", "undefined", "undefined", "undefined"]);
});

test("the returned payload is capped, and the cap is reported", async () => {
  const h = harness();
  const envelope = await h.run('return "x".repeat(20000);', { limits: { MAX_RESULT_BYTES: 1_024 } });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.truncated, true);
  assert.equal(typeof envelope.result, "string");
  assert.ok(Buffer.byteLength(String(envelope.result), "utf8") <= 1_024);
  assert.ok((envelope.result_bytes ?? 0) > 1_024);
  assert.match(String(envelope.hint), /larger than 1024 bytes/);
});

test("BigInt and non-finite numbers come back without quietly becoming null", async () => {
  const h = harness();
  const envelope = await h.run("return { big: 10n, inf: 1 / 0, nan: 0 / 0, ok: 1 };");
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.deepEqual(envelope.result, { big: "10", inf: "Infinity", nan: "NaN", ok: 1 });
});

test("a cyclic return value is reported instead of mangled", async () => {
  const h = harness();
  const envelope = await h.run("const a = {}; a.self = a; return a;");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error_type, "UnserializableReturn");
  assert.match(String(envelope.error), /cycle/);
});

test("a return the worker itself cannot clone is an immediate UnserializableReturn, not a timeout", async () => {
  // A function in the return used to kill postMessage inside the worker, the
  // worker then sent NOTHING, and the parent sat out the whole wall clock
  // before misreporting the run as a timeout. UnserializableReturn existed for
  // this shape and was dead code for it. (A bare BigInt is fine: structured
  // clone carries it; the parent's safeJsonText stringifies it.)
  const h = harness();
  const startedAt = Date.now();
  const envelope = await h.run("return { run: () => 1 };", { timeoutMs: 5_000 });
  const elapsed = Date.now() - startedAt;
  assert.equal(envelope.ok, false, JSON.stringify(envelope));
  assert.equal(envelope.error_type, "UnserializableReturn");
  assert.match(String(envelope.error), /return value/i);
  assert.ok(elapsed < 3_000, `must fail fast, not after the wall clock (took ${elapsed} ms)`);
});

test("a Markdown fence is tolerated and CRLF is normalized", () => {
  assert.equal(normalizeScriptSource('```js\nreturn 1;\n```'), "return 1;");
  assert.equal(normalizeScriptSource("```\r\nreturn 2;\r\n```\r\n"), "return 2;");
  assert.equal(normalizeScriptSource("  return 3;  "), "return 3;");
  assert.throws(() => normalizeScriptSource(""), /non-empty/);
  assert.throws(() => normalizeScriptSource("```js\n```"), /empty after removing/);
  assert.throws(() => normalizeScriptSource("x".repeat(SCRIPT_LIMITS.MAX_SOURCE_BYTES + 1)), /larger than/);
});

test("timeouts and call budgets clamp instead of silently accepting anything", () => {
  assert.equal(clampScriptTimeout(undefined), SCRIPT_LIMITS.DEFAULT_TIMEOUT_MS);
  assert.equal(clampScriptTimeout(0), SCRIPT_LIMITS.DEFAULT_TIMEOUT_MS);
  assert.equal(clampScriptTimeout("5000"), SCRIPT_LIMITS.DEFAULT_TIMEOUT_MS, "strings are not numbers");
  assert.equal(clampScriptTimeout(10), 1_000, "a tiny budget is raised to the floor");
  assert.equal(clampScriptTimeout(10_000_000), SCRIPT_LIMITS.MAX_TIMEOUT_MS);
  assert.equal(clampScriptCalls(undefined), SCRIPT_LIMITS.DEFAULT_MAX_CALLS);
  assert.equal(clampScriptCalls(0), SCRIPT_LIMITS.DEFAULT_MAX_CALLS);
  assert.equal(clampScriptCalls(10_000), SCRIPT_LIMITS.HARD_MAX_CALLS);
});

test("JSON safety, truncation and the hint table behave as documented", () => {
  assert.deepEqual(safeJsonText({ a: 1 }), { ok: true, text: '{"a":1}' });
  assert.equal(safeJsonText(undefined).ok, false);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const failed = safeJsonText(cyclic);
  assert.equal(failed.ok, false);
  assert.match(failed.ok === false ? failed.reason : "", /cycle/);

  const big = "汉字".repeat(10);
  const capped = truncateScriptText(big, 7);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.text, "utf8") <= 7, "the cap is measured in bytes, not characters");
  assert.equal(truncateScriptText("ok", 10).truncated, false);

  const preview = scriptCodePreview("Error: x\n    at main (open-bridge-script.js:2:5)", "a\nb\nc");
  assert.equal(preview.line, 2);
  assert.deepEqual(preview.code_preview, ["  1 | a", "> 2 | b", "  3 | c"]);
  assert.equal(scriptCodePreview(undefined, "a").line, undefined);

  assert.match(scriptFailureHint("compile", "SyntaxError", ""), /did not compile/);
  assert.match(scriptFailureHint("timeout", "ScriptTimeout", ""), /timeout_ms/);
  assert.match(scriptFailureHint("run", "ReferenceError", ""), /fresh scope/);
  assert.match(scriptFailureHint("run", "TypeError", ""), /plain JSON/);
  assert.match(scriptFailureHint("return", "NoReturn", ""), /top-level `return`/);
});
