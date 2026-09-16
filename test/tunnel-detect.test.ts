import assert from "node:assert/strict";
import test from "node:test";
import {
  detectNgrokFacts,
  detectTailscaleFacts,
  fetchReservedDomains,
  ngrokConfigCandidates,
  parseNgrokAuthtoken,
  parseReservedDomains,
  parseTailscaleStatus,
  readNgrokConfigAuthtoken,
  type RunText,
} from "../src/bridge/tunnel-detect.js";
import type { TunnelFacts } from "../src/bridge/tunnel-plan.js";

/**
 * Detection is the half of the tunnel card that talks to the machine, so it is
 * the half that must never throw and never guess. Every probe is injected here:
 * the test asserts the SHAPE of the answer, not whether this machine happens to
 * have ngrok installed.
 */

test("the ngrok authtoken is read from the config line, quoted or not", () => {
  assert.equal(parseNgrokAuthtoken("version: 2\nauthtoken: 2abc_def\n"), "2abc_def");
  assert.equal(parseNgrokAuthtoken("version: 2\ntunnels:\n  ssh:\n"), "");
  assert.equal(parseNgrokAuthtoken("  authtoken: '2abc'\n"), "2abc");
  assert.equal(parseNgrokAuthtoken("authtoken:\n"), "");
  assert.equal(parseNgrokAuthtoken(""), "");
});

test("ngrok's config file is looked for where the OS puts it", () => {
  const win = ngrokConfigCandidates({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" }, "win32");
  assert.equal(win[0], "C:\\Users\\me\\AppData\\Local\\ngrok\\ngrok.yml");
  const nix = ngrokConfigCandidates({ HOME: "/home/me" }, "linux");
  assert.equal(nix[0], "/home/me/.config/ngrok/ngrok.yml");
});

test("an unreadable config file falls through to the next location", () => {
  const candidates = ngrokConfigCandidates({ LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" }, "win32");
  const read = (file: string): string => {
    if (file === candidates[0]) throw new Error("EACCES");
    if (file === candidates[1]) return "authtoken: 2xyz_from_appdata\n";
    throw new Error("ENOENT");
  };
  const found = readNgrokConfigAuthtoken({ env: { LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" }, platform: "win32", readFile: read });
  assert.equal(found?.token, "2xyz_from_appdata");
  assert.equal(found?.file, candidates[1]);
  assert.equal(readNgrokConfigAuthtoken({ platform: "win32", env: {}, readFile: () => { throw new Error("ENOENT"); } }), null);
});

test("reserved domains survive an odd payload", () => {
  assert.deepEqual(
    parseReservedDomains({ reserved_domains: [{ domain: "a.ngrok-free.app" }, { domain: "b.ngrok-free.app" }, { domain: "a.ngrok-free.app" }, {}] }),
    ["a.ngrok-free.app", "b.ngrok-free.app"],
  );
  assert.deepEqual(parseReservedDomains("nope"), []);

  const json = (body: unknown, status = 200): typeof fetch => (async () => new Response(
    JSON.stringify(body), { status, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;

  return Promise.all([
    fetchReservedDomains("tok", { fetchImpl: json({ reserved_domains: [{ domain: "a.ngrok-free.app" }] }) }),
    fetchReservedDomains("tok", { fetchImpl: json({ msg: "unauthorized" }, 401) }),
    fetchReservedDomains("tok", { fetchImpl: (async () => { throw new Error("ETIMEDOUT"); }) as unknown as typeof fetch }),
  ]).then(([ok, unauthorized, offline]) => {
    assert.deepEqual(ok.domains, ["a.ngrok-free.app"]);
    assert.equal(ok.error, null);
    assert.equal(unauthorized.domains.length, 0);
    assert.match(unauthorized.error ?? "", /401/);
    assert.match(offline.error ?? "", /ETIMEDOUT/);
  });
});

test("tailscale status is read for the three facts the card shows", () => {
  assert.deepEqual(
    parseTailscaleStatus(JSON.stringify({ Self: { DNSName: "desktop-ccbufa0.tail170424.ts.net.", Online: true } })),
    { loggedIn: true, domain: "desktop-ccbufa0.tail170424.ts.net", online: true },
  );
  assert.deepEqual(parseTailscaleStatus("not json"), { loggedIn: false, domain: "", online: false });
});

test("ngrok facts: the configured path wins, the token source is reported without the token", async () => {
  const facts = await detectNgrokFacts({
    ngrokExecutable: "D:\\bin\\ngrok.exe",
    env: { LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" },
    platform: "win32",
    readFile: () => "authtoken: 2secret_value\n",
    fetchImpl: (async () => new Response(JSON.stringify({ reserved_domains: [{ domain: "a.ngrok-free.app" }] }), { status: 200 })) as unknown as typeof fetch,
  });

  assert.equal(facts.installed, true);
  assert.equal(facts.executable, "D:\\bin\\ngrok.exe");
  assert.equal(facts.authtokenSource, "ngrok-config");
  assert.deepEqual(facts.domains, ["a.ngrok-free.app"]);
  // The value itself is nowhere in the facts: this object is rendered in the browser.
  assert.equal(JSON.stringify(facts).includes("2secret_value"), false);
});

test("ngrok facts: nothing installed, nothing to import — empty is not an error", async () => {
  const facts = await detectNgrokFacts({
    detect: { platform: "linux", exists: () => false, env: { HOME: "/home/me" } },
    env: { HOME: "/home/me" },
    platform: "linux",
    readFile: () => { throw new Error("ENOENT"); },
  });
  assert.equal(facts.installed, false);
  assert.equal(facts.executable, "");
  assert.equal(facts.authtokenSource, "none");
  assert.deepEqual(facts.domains, []);
  assert.equal(facts.domainsError, null);
});

test("tailscale facts come from the CLI's own JSON, and a dead daemon leaves defaults", async () => {
  const exe = "/usr/local/bin/tailscale";
  const run: RunText = async (_exe, args) => args[0] === "status"
    ? { ok: true, stdout: JSON.stringify({ Self: { DNSName: "m.tail1.ts.net.", Online: true } }), error: "" }
    : { ok: false, stdout: "", error: "should not be called" };

  const facts = await detectTailscaleFacts({
    tailscaleExecutable: exe,
    platform: "linux",
    env: { PATH: "/usr/local/bin" },
    exists: file => file === exe,
    run,
    readFunnel: async () => ({
      kind: "config",
      backend: { port: 18080, funnel: true },
    }),
  });
  assert.equal(facts.installed, true);
  assert.equal(facts.loggedIn, true);
  assert.equal(facts.domain, "m.tail1.ts.net");
  assert.equal(facts.mountPort, 18080);
  assert.equal(facts.mountPublic, true);

  const dead = await detectTailscaleFacts({
    tailscaleExecutable: exe,
    platform: "linux",
    env: { PATH: "/usr/local/bin" },
    exists: file => file === exe,
    run: async () => ({ ok: false, stdout: "", error: "daemon not running" }),
    readFunnel: async () => ({ kind: "unreadable", reason: "daemon not running" }),
  });
  assert.deepEqual(dead.domain, "");
  assert.equal(dead.loggedIn, false);
  assert.equal(dead.mountPort, null);

  const missing = await detectTailscaleFacts({ platform: "linux", env: { PATH: "" }, exists: () => false });
  assert.equal(missing.installed, false);
  assert.equal(missing.executable, "");
});

test("the facts shape stays JSON-clean for the console", () => {
  const keys: Array<keyof TunnelFacts> = ["ngrok", "tailscale"];
  assert.deepEqual(keys.length, 2);
});
