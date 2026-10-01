/**
 * Trusted Worker/VM source for run_script.
 *
 * These strings are security-sensitive executable source. Keep them isolated
 * from parent-side orchestration so realm/bootstrap changes are easy to audit.
 */
/**
 * The worker's own source. It is a string on purpose: it must be evaluated with
 * `eval: true` (the same trick `mcp/regex-worker.ts` uses) so no build step has to
 * know about it, and it is the only place that touches `vm`/`worker_threads`.
 *
 * Deliberate omissions inside the context: `require`, `process`, `globalThis`,
 * `fetch`, `XMLHttpRequest`, `WebSocket`, `setTimeout`/`setInterval`, `import`.
 * Waiting is a tool call (`wait`), not a sandbox timer.
 */
export const SCRIPT_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const limits = workerData.limits;
const toolNames = workerData.toolNames;
const pending = new Map();
const byTool = Object.create(null);
const consoleLines = [];
let nextId = 1;
let calls = 0;
let consoleBytes = 0;
let done = false;

function post(message) {
  if (done) return;
  done = true;
  try {
    parentPort.postMessage(message);
  } catch (error) {
    // The envelope itself could not cross the port — the usual cause is a
    // return value structured clone cannot carry (BigInt, function, Symbol).
    // Answer with a plain error envelope; the parent used to receive nothing
    // here and misreport the run as a timeout after the wall clock ran out.
    done = false;
    try {
      parentPort.postMessage({
        type: "done",
        ok: false,
        phase: "return",
        error: {
          name: "UnserializableReturn",
          message: "The script's return value could not be sent back to the bridge ("
            + (error && error.message ? error.message : "not serializable")
            + "). Return plain JSON data: objects, arrays, strings, numbers, booleans, null.",
        },
        calls: calls,
        byTool: byTool,
        console: consoleLines,
      });
    } catch (nested) {
      // Even the plain envelope was refused. Give up; the parent's wall-clock
      // timer is the backstop.
      void nested;
    }
  }
}

function toolError(name, message) {
  const error = new Error(String(message || "tools." + name + " failed"));
  error.name = "ToolError";
  error.tool = name;
  return error;
}

function callTool(name, args) {
  if (calls >= limits.maxCalls) {
    const error = new Error(
      "This script exceeded its tool-call budget (" + limits.maxCalls + " calls). Split the work across several run_script calls or raise max_calls."
    );
    error.name = "CallLimitError";
    return Promise.reject(error);
  }
  calls += 1;
  byTool[name] = (byTool[name] || 0) + 1;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve, reject: reject });
    try {
      parentPort.postMessage({ type: "tool-call", id: id, name: name, args: args === undefined ? {} : args });
    } catch (error) {
      pending.delete(id);
      reject(new Error(
        "The arguments for tools." + name + " cannot cross the sandbox boundary; pass plain JSON data (objects, arrays, strings, numbers, booleans)."
      ));
    }
  });
}

parentPort.on("message", (message) => {
  if (!message || message.type !== "tool-result") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.value);
  else entry.reject(toolError(message.tool, message.error));
});

// Names the tool surface must not answer to: a returned promise checks "then",
// JSON.stringify checks "toJSON", the inspector checks "inspect", and the
// prototype names are how one realm is climbed from another.
const RESERVED = ["then", "catch", "finally", "toJSON", "inspect", "constructor", "prototype", "__proto__"];

// A null-prototype closure, never a method reached through an array: handed a
// real array of strings, a script could call
// toolNames.entries.constructor("return process")() and be back in this realm.
// "entries" is an ordinary own property whose name is not in RESERVED, so no
// name check can catch it.
function makeToolsGate(names) {
  return Object.assign(Object.create(null), {
    has: (name) => names.indexOf(name) >= 0,
  });
}

/**
 * The one thing the sandbox must never be able to hold onto.
 *
 * apply/writeConsole/gate.has are functions defined in THIS realm, so their
 * "constructor" property is this realm's Function. They are delivered as data
 * fields and the bootstrap deletes them before the caller's script is compiled,
 * which is why the deletion order matters more than it looks.
 */
// Plain JavaScript ONLY in this string: the Worker evaluates it with eval:true,
// and Node 22 parses it as JS with no type stripping (Node 24 strips eval'd type
// annotations by default, which once masked this). A stray annotation here is a
// SyntaxError on the declared engine floor and kills every run_script call.
function makeHarness() {
  return Object.assign(Object.create(null), {
    toolNames: toolNames.slice(),
    gate: makeToolsGate(toolNames),
    apply: (name, args) => callTool(name, args),
    writeConsole: (level, text) => capture(level)(text),
  });
}


function capture(level) {
  return function () {
    const parts = Array.prototype.slice.call(arguments);
    const text = parts
      .map(function (part) {
        if (typeof part === "string") return part;
        try {
          return JSON.stringify(part);
        } catch (error) {
          return String(part);
        }
      })
      .join(" ");
    if (consoleBytes >= limits.maxConsoleBytes) return;
    const line = "[" + level + "] " + text;
    consoleBytes += line.length + 1;
    consoleLines.push(line.slice(0, 2000));
    // Stream the line out as it happens: the parent otherwise sees console
    // output only inside the done message, which a wall-clock timeout never
    // sends — every timed-out run reported an empty console precisely when
    // the log was the best clue to what hung.
    try { parentPort.postMessage({ type: "console", line: line.slice(0, 2000) }); } catch (error) { void error; }
  };
}

async function main() {
  // codeGeneration: { strings: false } disables the CONTEXT's Function
  // constructor. runInContext still compiles this trusted bootstrap — the
  // option gates eval/Function at runtime, not the host's own compilation.
  const context = vm.createContext(makeHarness(), { codeGeneration: { strings: false, wasm: false } });
  try {
    // compileFunction + parsingContext, not runInContext: the body must run in
    // the CONTEXT realm so the functions it creates carry that realm's
    // Function. An IIFE evaluated by runInContext would only be *created* there
    // and never invoked unless the completion value were called explicitly.
    vm.compileFunction(workerData.bootstrapSource, [], {
      parsingContext: context,
      filename: "open-bridge-sandbox-bootstrap.js",
    })();
  } catch (error) {
    post({
      type: "done",
      ok: false,
      phase: "worker",
      error: { name: error && error.name, message: error && error.message, stack: error && error.stack },
      calls: calls,
      byTool: byTool,
      console: consoleLines,
    });
    return;
  }
  let script;
  try {
    script = new vm.Script(workerData.wrapped, { filename: workerData.filename, lineOffset: -1 });
  } catch (error) {
    post({ type: "done", ok: false, phase: "compile", error: { name: error.name, message: error.message, stack: error.stack }, calls: calls, byTool: byTool, console: consoleLines });
    return;
  }
  let value;
  try {
    value = await script.runInContext(context, { timeout: workerData.syncTimeoutMs });
  } catch (error) {
    const timedOut = error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
    post({
      type: "done",
      ok: false,
      phase: timedOut ? "timeout" : "run",
      error: { name: error && error.name, message: error && error.message, tool: error && error.tool, stack: error && error.stack },
      calls: calls,
      byTool: byTool,
      console: consoleLines,
    });
    return;
  }
  if (value === undefined) {
    post({
      type: "done",
      ok: false,
      phase: "return",
      error: { name: "NoReturn", message: "The script finished without returning a value. A top-level return is required; console output does not count." },
      calls: calls,
      byTool: byTool,
      console: consoleLines,
    });
    return;
  }
  post({ type: "done", ok: true, result: value, calls: calls, byTool: byTool, console: consoleLines });
}

main();
`;


/**
 * The bootstrap's FUNCTION BODY, compiled with `vm.compileFunction` and
 * `parsingContext: context`. Everything it creates therefore carries the
 * context's own Function as "constructor" — the one thing
 * codeGeneration: { strings: false } disables.
 *
 * It takes no parameters on purpose: it reads the harness off the context's
 * global scope. A parameter would have to be supplied by the host, and the
 * host's argument object lives in this realm.
 *
 * The escape this closes: the tool surface used to be a host-realm object whose
 * values were host-realm arrow functions, so
 * tools.read_files.constructor("return process")() returned the worker's
 * process (and from there getBuiltinModule("node:child_process").execSync) —
 * the whole CLI capability surface, bypassing the dispatcher, resource locks,
 * the audit log and the workspace sandbox. The RESERVED name list could not
 * help: it filters property NAMES on the proxy, while the leak was in the
 * prototype of a value the proxy returned.
 *
 * NOTE for anyone editing this string: it is a String.raw template, so a
 * backtick anywhere inside it — including in a comment — ends it early and
 * produces a wall of unrelated syntax errors.
 */
export const BOOTSTRAP_SOURCE = String.raw`
  'use strict';
  var harness = globalThis;
  var RESERVED = ['then', 'catch', 'finally', 'toJSON', 'inspect', 'constructor', 'prototype', '__proto__'];
  var apply = harness.apply;
  var writeConsole = harness.writeConsole;
  var gate = harness.gate;
  var toolNames = harness.toolNames;
  // Close first, delete second. Up to here these host-realm functions are
  // reachable as globals, and any one of them would hand the script this realm.
  delete harness.apply;
  delete harness.writeConsole;
  delete harness.gate;
  delete harness.toolNames;
  function wrap(name) {
    var fn = function (args) { return apply(name, args); };
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (error) { /* cosmetic */ }
    return fn;
  }
  var tools = new Proxy(Object.create(null), {
    get: function (_target, property) {
      if (typeof property !== 'string' || RESERVED.indexOf(property) >= 0) return undefined;
      // Every other name is wrapped, advertised or not: an unknown name must
      // still reach callTool, which answers with the dispatcher's own
      // "Unknown tool" message and its did-you-mean suggestion. Returning
      // undefined here turned a typo into "tools.read_fil is not a function".
      return wrap(property);
    },
    has: function (_target, property) {
      return typeof property === 'string' && gate.has(property);
    },
    ownKeys: function () { return toolNames.slice(); },
    getOwnPropertyDescriptor: function (_target, property) {
      if (typeof property !== 'string' || !gate.has(property)) return undefined;
      return { value: undefined, enumerable: true, configurable: true, writable: false };
    },
    set: function () { return false; },
  });
  Object.defineProperty(globalThis, 'tools', { value: tools, writable: false, enumerable: false, configurable: false });
  // console.* is defined here for the same reason as tools.*: the previous
  // host-built capture() functions were a second door with the same shape.
  function capture(level) {
    return function () {
      var parts = Array.prototype.slice.call(arguments);
      var text = parts.map(function (part) {
        if (typeof part === 'string') return part;
        try { return JSON.stringify(part); } catch (error) { return String(part); }
      }).join(' ');
      return writeConsole(level, text);
    };
  }
  Object.defineProperty(globalThis, 'console', {
    value: Object.freeze({
      log: capture('log'), info: capture('info'), warn: capture('warn'),
      error: capture('error'), debug: capture('debug'),
    }),
    writable: false, enumerable: false, configurable: false,
  });
`;
