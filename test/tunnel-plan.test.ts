import assert from "node:assert/strict";
import test from "node:test";
import { emptyTunnelFacts, planTunnelAutoConfig, type AutoConfigInput, type AutoConfigWrite } from "../src/bridge/tunnel-plan.js";

/**
 * 「自动配置」 is the one action on the settings page that writes several values
 * at once, so its rules are pinned here rather than in the page:
 *
 *  - a detected value only ever fills an EMPTY field (the whole reason someone
 *    who typed a path on purpose is safe to press the button);
 *  - a choice that is genuinely the operator's (which of several reserved
 *    domains, which shell) is never made for them;
 *  - the ts.net domain is never written at all, because the bridge discovers it
 *    at every start and a stored copy that goes stale turns into a start-up
 *    error instead of a tunnel.
 */

function input(overrides: Partial<AutoConfigInput> = {}): AutoConfigInput {
  return {
    provider: "ngrok",
    current: { ngrokExecutable: "", ngrokDomain: "", tailscaleExecutable: "" },
    authtokenStored: false,
    facts: emptyTunnelFacts(),
    ...overrides,
  };
}

const keys = (writes: AutoConfigWrite[]): string[] => writes.map(write => write.key);

test("a detected executable fills an empty field", () => {
  const facts = emptyTunnelFacts();
  facts.ngrok = { ...facts.ngrok, installed: true, executable: "C:\\tools\\ngrok.exe", executableLabel: "PATH", authtokenSource: "stored" };

  const plan = planTunnelAutoConfig(input({ facts }));

  assert.deepEqual(keys(plan.writes), ["ngrokExecutable"]);
  assert.equal(plan.writes[0]?.kind === "config" ? plan.writes[0].value : "", "C:\\tools\\ngrok.exe");
  assert.equal(plan.blocked, null);
});

test("an operator's own value is kept, not overwritten", () => {
  const facts = emptyTunnelFacts();
  facts.ngrok = { ...facts.ngrok, installed: true, executable: "C:\\tools\\ngrok.exe", executableLabel: "PATH", authtokenSource: "stored" };

  const plan = planTunnelAutoConfig(input({
    current: { ngrokExecutable: "D:\\bin\\ngrok.exe", ngrokDomain: "mine.ngrok-free.app", tailscaleExecutable: "" },
    facts,
  }));

  assert.deepEqual(plan.writes, []);
  const kept = plan.keep.join(" ");
  assert.match(kept, /D:\\bin\\ngrok\.exe/);
  assert.match(kept, /mine\.ngrok-free\.app/);
  assert.match(kept, /authtoken/);
});

test("the literal default \"ngrok\" counts as unset: the pick-list resolves it", () => {
  const facts = emptyTunnelFacts();
  facts.ngrok = { ...facts.ngrok, installed: true, executable: "C:\\ProgramData\\chocolatey\\bin\\ngrok.exe", executableLabel: "Chocolatey", authtokenSource: "stored" };

  const plan = planTunnelAutoConfig(input({ current: { ngrokExecutable: "ngrok", ngrokDomain: "", tailscaleExecutable: "" }, facts }));

  assert.deepEqual(keys(plan.writes), ["ngrokExecutable"]);
});

test("one reserved domain is chosen; several are left to the operator", () => {
  const facts = emptyTunnelFacts();
  facts.ngrok = { ...facts.ngrok, installed: true, executable: "C:\\tools\\ngrok.exe", executableLabel: "PATH", authtokenSource: "stored", domains: ["one.ngrok-free.app"] };
  const current = { ngrokExecutable: "C:\\tools\\ngrok.exe", ngrokDomain: "", tailscaleExecutable: "" };
  const single = planTunnelAutoConfig(input({ current, facts }));
  assert.deepEqual(keys(single.writes), ["ngrokDomain"]);
  assert.match(single.writes[0]?.label ?? "", /one\.ngrok-free\.app/);

  facts.ngrok = { ...facts.ngrok, domains: ["one.ngrok-free.app", "two.ngrok-free.app", "three.ngrok-free.app"] };
  const many = planTunnelAutoConfig(input({ current, facts }));
  assert.deepEqual(keys(many.writes), []);
  assert.match(many.notes.join(" "), /3 个保留域名/);
});

test("a stored authtoken is kept; ngrok's own file is imported when there is none", () => {
  const facts = emptyTunnelFacts();
  facts.ngrok = { ...facts.ngrok, installed: true, executable: "C:\\tools\\ngrok.exe", executableLabel: "PATH", authtokenSource: "ngrok-config" };
  const current = { ngrokExecutable: "C:\\tools\\ngrok.exe", ngrokDomain: "", tailscaleExecutable: "" };
  const imported = planTunnelAutoConfig(input({ current, facts }));
  assert.deepEqual(keys(imported.writes), ["ngrokAuthtoken"]);
  const write = imported.writes[0];
  assert.equal(write?.kind, "secret");
  // The token value must not be part of the plan: this object is rendered in a
  // browser. The executor reads it server-side from the file.
  assert.equal("value" in (write ?? {}), false);

  facts.ngrok = { ...facts.ngrok, authtokenSource: "stored" };
  const stored = planTunnelAutoConfig(input({ current, facts }));
  assert.deepEqual(keys(stored.writes), []);
  assert.match(stored.keep.join(" "), /authtoken/);
});

test("nothing to import and nothing installed: the plan says what is missing instead of pretending", () => {
  const plan = planTunnelAutoConfig(input({ facts: emptyTunnelFacts() }));
  assert.ok(plan.blocked, "expected a blocker when ngrok is neither installed nor credentialed");
  assert.match(plan.blocked ?? "", /ngrok/);
  assert.deepEqual(plan.writes, []);
});

test("tailscale: the executable is written, the discovered domain never is", () => {
  const facts = emptyTunnelFacts();
  facts.tailscale = {
    installed: true, executable: "C:\\Program Files\\Tailscale\\tailscale.exe", executableLabel: "默认安装目录",
    loggedIn: true, domain: "desktop-ccbufa0.tail170424.ts.net", online: true, mountPort: null, mountPublic: false,
  };

  const plan = planTunnelAutoConfig(input({ provider: "tailscale", facts }));

  assert.deepEqual(keys(plan.writes), ["tailscaleExecutable"]);
  assert.match(plan.notes.join(" "), /desktop-ccbufa0\.tail170424\.ts\.net/);
  // The tunnel start path fills this in from the CLI; auto-config must say so
  // rather than quietly writing a second, frozen copy of the name.
  assert.match(plan.notes.join(" "), /自动填写/);
  assert.equal(plan.blocked, null);
});

test("tailscale: a node that is not logged in blocks the goal but still writes the path", () => {
  const facts = emptyTunnelFacts();
  facts.tailscale = {
    installed: true, executable: "/usr/local/bin/tailscale", executableLabel: "PATH",
    loggedIn: false, domain: "", online: false, mountPort: null, mountPublic: false,
  };

  const plan = planTunnelAutoConfig(input({ provider: "tailscale", facts }));

  assert.deepEqual(keys(plan.writes), ["tailscaleExecutable"]);
  assert.match(plan.blocked ?? "", /tailscale up/);
});

test("tailscale: an existing 443 mount is described, not re-decided", () => {
  const facts = emptyTunnelFacts();
  facts.tailscale = {
    installed: true, executable: "/opt/bin/tailscale", executableLabel: "PATH",
    loggedIn: true, domain: "m.tail1.ts.net", online: true, mountPort: 18080, mountPublic: true,
  };
  const publicMount = planTunnelAutoConfig(input({ provider: "tailscale", facts }));
  assert.match(publicMount.notes.join(" "), /443 上已挂载到本机端口 18080/);

  facts.tailscale = { ...facts.tailscale, mountPublic: false };
  const tailnetOnly = planTunnelAutoConfig(input({ provider: "tailscale", facts }));
  assert.match(tailnetOnly.notes.join(" "), /tailnet 内的 serve/);
});

test("provider none plans nothing and says what to do first", () => {
  const plan = planTunnelAutoConfig(input({ provider: "none" }));
  assert.deepEqual(plan.writes, []);
  assert.match(plan.blocked ?? "", /选一个提供商/);
});
