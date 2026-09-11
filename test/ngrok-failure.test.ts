import assert from "node:assert/strict";
import test from "node:test";
import { isEndpointTakenError, isFatalNgrokError, ngrokFailureSummary } from "../src/network/ngrok-failure.js";

/**
 * Captured verbatim from a real run: a reserved subdomain the free account may
 * not serve. This is the shape the classifier has to recognise — ngrok's own
 * structured code, buried in a structured log line and repeated in `ERROR:`
 * lines, with the human-readable reason split across several lines.
 */
const REFUSED_DOMAIN = [
  't=2026-09-11T03:57:59+0800 lvl=eror msg="terminating with error" obj=app err="failed to start tunnel: Only paid plans may create endpoints with custom subdomains.\\nFailed to create an endpoint with the custom subdomain \'ngrok-free.dev\' for the account \'aoliaoduo\'.\\nThis account is on the \'Free\' plan.\\n\\nUpgrade to a paid plan at: https://dashboard.ngrok.com/billing/choose-a-plan\\r\\n\\r\\nERR_NGROK_313\\r\\n"',
  '[2026-09-10T19:57:59.747Z] [ngrok] t=2026-09-11T03:57:59+0800 lvl=crit msg="command failed" err="failed to start tunnel: Only paid plans may create endpoints with custom subdomains."',
  "[2026-09-10T19:57:59.747Z] [ngrok] ERROR:  failed to start tunnel: Only paid plans may create endpoints with custom subdomains.",
  "[2026-09-10T19:57:59.747Z] [ngrok] ERROR:  ERR_NGROK_313",
  "[2026-09-10T19:57:59.747Z] [ngrok] ERROR:  https://ngrok.com/docs/errors/err_ngrok_313",
].join("\n");

test("a tunnel ngrok refuses counts as fatal (retrying cannot heal it)", () => {
  assert.equal(isFatalNgrokError(REFUSED_DOMAIN), true);
  // A bad authtoken and a refused proxy are the same class.
  assert.equal(isFatalNgrokError("ERROR:  ERR_NGROK_105 authentication failed"), true);
  assert.equal(isFatalNgrokError("err=\"failed to start tunnel: ERR_NGROK_9009\""), true);
});

test("an exit without an ngrok error code stays transient", () => {
  // The reconnect chain exists for these: the agent was killed, its session
  // dropped, the network was not up yet. Only ngrok's own structured errors are
  // read as permanent.
  assert.equal(isFatalNgrokError(""), false);
  assert.equal(
    isFatalNgrokError('t=2026 lvl=eror msg="failed to reconnect session" err="dial tcp: connection refused"'),
    false,
  );
  assert.equal(isFatalNgrokError("ngrok exited before the tunnel was ready (code null, signal SIGTERM)."), false);
});

test("the summary carries ngrok's own reason, not just a code", () => {
  const summary = ngrokFailureSummary(REFUSED_DOMAIN);
  assert.match(summary, /ERR_NGROK_313/);
  assert.match(summary, /Only paid plans may create endpoints with custom subdomains/);
  // The structured log line and the `ERROR:` prefix are noise for the operator.
  assert.doesNotMatch(summary, /^t=/);
  assert.doesNotMatch(summary, /ERROR:/);
  assert.equal(summary.includes("\n"), false, "one line, so it reads as a single notice");
});

test("the summary is bounded and never empty", () => {
  const long = `ERROR:  ${"x".repeat(500)} ERR_NGROK_313`;
  assert.ok(ngrokFailureSummary(long).length <= 241);
  assert.equal(ngrokFailureSummary(""), "ngrok exited before the tunnel was ready");
  assert.equal(ngrokFailureSummary("plain noise with no code"), "ngrok exited before the tunnel was ready");
});

test("an endpoint another instance already holds is its own case, not a config error", () => {
  // ERR_NGROK_334 means someone else came online at this domain. The caller
  // reacts by staying local and adopting that tunnel; reporting it as a
  // deterministic "fix your configuration" failure is what parked this instance
  // local-only while a working tunnel sat next to it.
  const taken = 'lvl=eror msg="failed to start tunnel: The endpoint \'https://x.ngrok-free.dev\' is already online." ERR_NGROK_334';
  assert.equal(isEndpointTakenError(taken), true);
  assert.equal(isFatalNgrokError(taken), true);
  assert.equal(isEndpointTakenError("ERR_NGROK_313: domain not assigned"), false);
  assert.equal(isEndpointTakenError("tunnel exited without a structured code"), false);
});
