/**
 * Recognising the ngrok failures that retrying cannot heal.
 *
 * ngrok exits for two very different reasons. The first is transient: the agent
 * was killed, its session dropped, the machine woke up before the network did.
 * Reconnecting is the right answer there, and the reconnect chain exists for it.
 *
 * The second is configuration: a domain the account may not serve
 * (ERR_NGROK_313), a rejected authtoken, a proxy the free plan refuses
 * (ERR_NGROK_9009). Those fail identically on every attempt, forever. Treated as
 * transient, they produced an endless spawn-retry loop — while each doomed
 * attempt republished an https URL that answered nothing.
 *
 * ngrok marks the second kind with a structured `ERR_NGROK_<code>` in its own
 * log output, so that is what this module looks for. The exit code cannot be
 * used: ngrok exits 1 for both kinds.
 */

/** ngrok's structured error marker, e.g. `ERR_NGROK_313`. */
const NGROK_ERROR_CODE = /ERR_NGROK_\d+/;

/**
 * True when ngrok's own output names one of its structured errors.
 *
 * Only asked about a tunnel process that died BEFORE it was ever ready: an
 * ngrok that had been serving and then fell over is the reconnect chain's job,
 * and its failure text is not consulted here.
 */
export function isFatalNgrokError(output: string): boolean {
  return NGROK_ERROR_CODE.test(output);
}

/**
 * A short reason for the operator, in ngrok's own words, so the fix — which only
 * they can make — is visible without opening the log.
 */
export function ngrokFailureSummary(output: string, limit = 240): string {
  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const code = output.match(NGROK_ERROR_CODE)?.[0];
  // ngrok prints its human-readable line prefixed with `ERROR:`; the structured
  // `t=… lvl=eror …` line above it is noisy and repeats the same text.
  const detail = lines.find(line => line.startsWith("ERROR:"))
    ?? lines.find(line => line.includes("failed to start tunnel"));
  const text = [code, detail?.replace(/^ERROR:\s*/, "")].filter(Boolean).join(" · ")
    || "ngrok exited before the tunnel was ready";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
