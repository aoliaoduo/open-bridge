/**
 * Single per-key validation for Open Bridge settings writes.
 *
 * `set_config_value` (MCP) and the console's generic `setConfig` path used to
 * validate the same keys with two different rule sets, and the two had
 * drifted: the console stored `false` for `unrestrictedFileAccess: "yes"`
 * while MCP refused it, accepted relative `allowedDirectories` MCP rejected,
 * truncated values MCP kept whole, and skipped the redirect-host lowercasing
 * MCP applied. Both entries now delegate here, so the README's "共用一套校验"
 * is literally one function.
 *
 * Rule precedence (deliberate — do not "simplify" it away):
 * - MCP decides *validity*: strict booleans, absolute-only directories,
 *   lowercased redirect hosts. Invalid input is refused, never coerced.
 * - The console's *lossless* hygiene is kept and extended to MCP: trimming,
 *   dropping empty shell args, normalizing an enum to the member it names.
 *   These can only turn input into the value the sender meant.
 * - The console's *lossy* truncation (slice to 50 items / N chars) is NOT
 *   kept: silently rewriting spawn args or an access allowlist is worse than
 *   refusing it. Over-cap values are rejected with the limit in the message.
 *
 * Deliberately dependency-free — no host, no bridge state, no imports — so
 * `settings-model.ts` (which the React console bundles) can share it. The
 * callers add their own node-only steps afterwards: `path.resolve` for
 * directories on both write paths. `ngrokDomain` is intentionally absent:
 * both entries reach it through `validateNgrokDomain` (MCP calls it inline,
 * the console through its dedicated `saveDomain` flow — same function).
 *
 * Dedicated flows (auth toggle, concurrency, TTL) keep their own gates: they
 * ask different questions (token usability, TTL allowlist) than "is this
 * value well-formed", and their behavior is pinned by tests.
 */

export type ConfigValidation = { ok: true; value: unknown } | { ok: false; error: string };

/** Shared with the MCP entry so the missing-value refusal cannot drift. */
export const SETTING_VALUE_REQUIRED = "value is required. (expected 'value': setting value)";

const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  "unrestrictedFileAccess",
  "autoReconnect",
  "ngrokUseHttpProxy",
  "concurrency.enabled",
  "oauth.enabled",
  "notify.enabled",
  "notify.onTaskDone",
  "notify.onFinish",
]);

const NON_NEGATIVE_INT_KEYS: ReadonlySet<string> = new Set([
  "auth.tokenTtlSeconds",
  "concurrency.holdTimeoutMs",
  "concurrency.waitTimeoutMs",
]);

const MAX_LIST_ITEMS = 50;
const MAX_PATH_CHARS = 500;
const MAX_STRING_CHARS = 500;
/** Longest possible DNS name: a longer "host" can never match anything. */
const MAX_HOST_CHARS = 253;
const LOG_MAX_BYTES_MAX = 1024 * 1024 * 1024;

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/**
 * Absolute-path predicate without node:path (this module must stay
 * browser-bundle-safe). Accepts everything `path.isAbsolute` accepts on
 * either platform — POSIX `/…`, drive-absolute `C:\…` / `C:/…`, UNC and
 * drive-rooted `\…` — and rejects drive-relative `C:foo` and bare relative
 * paths exactly like node does.
 */
function isAbsoluteConfigPath(value: string): boolean {
  if (value.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("\\")) return true;
  return false;
}

export function validateConfigValue(key: string, value: unknown): ConfigValidation {
  if (value === undefined) return { ok: false, error: SETTING_VALUE_REQUIRED };

  if (key === "tunnelProvider" || key === "toolProfile") {
    const allowed: readonly [string, string] = key === "tunnelProvider" ? ["none", "ngrok"] : ["full", "core"];
    const normalized = typeof value === "string" ? value.trim() : value;
    if (normalized !== allowed[0] && normalized !== allowed[1]) {
      return { ok: false, error: `${key} must be '${allowed[0]}' or '${allowed[1]}'.` };
    }
    return { ok: true, value: normalized };
  }

  if (key === "ngrokExecutable" || key === "shellPath") {
    if (typeof value !== "string" || !value.trim()) {
      return { ok: false, error: `${key} must be a non-empty string. (expected '${key}': string)` };
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_STRING_CHARS) {
      return { ok: false, error: `${key} must be at most ${MAX_STRING_CHARS} characters.` };
    }
    return { ok: true, value: trimmed };
  }

  if (key === "shellArgs") {
    if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== "string")) {
      return { ok: false, error: "shellArgs must be an array of strings." };
    }
    const cleaned = (value as string[]).map(item => item.trim()).filter(item => item.length > 0);
    if (cleaned.length > MAX_LIST_ITEMS || cleaned.some(item => item.length > MAX_PATH_CHARS)) {
      return { ok: false, error: `shellArgs must have at most ${MAX_LIST_ITEMS} items of at most ${MAX_PATH_CHARS} characters each.` };
    }
    return { ok: true, value: cleaned };
  }

  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value !== "boolean") {
      return { ok: false, error: `${key} must be a boolean. (expected '${key}': boolean)` };
    }
    return { ok: true, value };
  }

  if (key === "oauth.allowedRedirectHosts") {
    // Hosts only, never full URLs: the registration check parses the redirect
    // URI and compares its host, so a path or scheme here would never match and
    // would silently narrow the allowlist to nothing.
    if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== "string" || !item.trim())) {
      return { ok: false, error: "oauth.allowedRedirectHosts must be an array of non-empty host strings." };
    }
    const hosts = (value as string[]).map(item => item.trim().toLowerCase());
    if (hosts.length > MAX_LIST_ITEMS || hosts.some(item => item.length > MAX_HOST_CHARS)) {
      return {
        ok: false,
        error: `oauth.allowedRedirectHosts must have at most ${MAX_LIST_ITEMS} hosts of at most ${MAX_HOST_CHARS} characters each.`,
      };
    }
    return { ok: true, value: hosts };
  }

  if (key === "auth.enabled") {
    if (typeof value !== "boolean") return { ok: false, error: "auth.enabled must be a boolean." };
    // The usable-token gate lives with the caller (it needs bridge state).
    return { ok: true, value };
  }

  if (NON_NEGATIVE_INT_KEYS.has(key)) {
    if (!isInt(value) || value < 0) {
      return { ok: false, error: `${key} must be a non-negative integer. (expected '${key}': number)` };
    }
    return { ok: true, value };
  }

  if (key === "allowedDirectories") {
    if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== "string")) {
      return { ok: false, error: "allowedDirectories must contain absolute path strings. (expected 'allowedDirectories': string[])" };
    }
    const trimmed = (value as string[]).map(item => item.trim());
    if (trimmed.some(item => !item || !isAbsoluteConfigPath(item))) {
      return { ok: false, error: "allowedDirectories must contain absolute path strings. (expected 'allowedDirectories': string[])" };
    }
    if (trimmed.length > MAX_LIST_ITEMS || trimmed.some(item => item.length > MAX_PATH_CHARS)) {
      return { ok: false, error: `allowedDirectories must have at most ${MAX_LIST_ITEMS} entries of at most ${MAX_PATH_CHARS} characters each.` };
    }
    return { ok: true, value: trimmed };
  }

  if (key === "port") {
    if (!isInt(value) || value < 0 || value > 65535) {
      return { ok: false, error: "port must be an integer between 0 and 65535." };
    }
    return { ok: true, value };
  }

  if (key === "publicHealthTimeoutMs") {
    if (!isInt(value) || value < 3000 || value > 120000) {
      return { ok: false, error: "publicHealthTimeoutMs must be an integer between 3000 and 120000." };
    }
    return { ok: true, value };
  }

  if (key === "logMaxBytes") {
    // Console-only until now; the range is the console's, unchanged.
    if (!isInt(value) || value < 0 || value > LOG_MAX_BYTES_MAX) {
      return { ok: false, error: `logMaxBytes must be an integer between 0 and ${LOG_MAX_BYTES_MAX}.` };
    }
    return { ok: true, value };
  }

  // ---- phone notifications (Bark) ------------------------------------------

  if (key === "notify.barkKey") {
    // Accept a bare device key OR a pasted `https://api.day.app/<key>/…` URL:
    // the Bark app literally shows the full link, and the distinctive part to
    // copy is a path segment most people cannot name. Parse it HERE so both
    // write paths (MCP + console) store the identical canonical value, and the
    // send path can trust what it reads. "" is legal: clearing the key is the
    // operator's way to disarm notifications without losing the other settings.
    if (typeof value !== "string") {
      return { ok: false, error: "notify.barkKey must be a string. (expected 'notify.barkKey': string)" };
    }
    const parsed = parseBarkKeyInput(value);
    if (parsed === null) {
      return {
        ok: false,
        error: "notify.barkKey must be the Bark device key (4-64 letters/digits/-/_), or a full https://api.day.app/<key> URL to copy it from.",
      };
    }
    return { ok: true, value: parsed };
  }

  if (key === "notify.mode") {
    // The enum this replaced. Kept as a REJECTION rather than silently
    // ignored: someone scripting against the old key deserves to be told
    // where the setting went, not to watch a write succeed and do nothing.
    return {
      ok: false,
      error: "notify.mode was replaced by two independent switches: notify.onTaskDone (push each completed todo) and notify.onFinish (push when the exchange ends). Set those instead.",
    };
  }

  if (key === "notify.idleMinutes") {
    // Integers only, upper-bounded at one day, and 0 = "the watchdog is off"
    // (an explicit, meaningful value — never coerce it to the default).
    if (!isInt(value) || value < 0 || value > 1440) {
      return { ok: false, error: "notify.idleMinutes must be an integer between 0 and 1440 (minutes; 0 = off). (expected 'notify.idleMinutes': number)" };
    }
    return { ok: true, value };
  }

  if (key === "notify.serverUrl") {
    // Same shape as oauth's `resource` rule: a bare origin, never a URL with
    // credentials, a query, or a path that could redirect pushes elsewhere.
    // https by default; plain http only for an explicit loopback dev server.
    // "" clears a custom origin: the read side falls back to the official
    // host, exactly like clearing the device key disarms the channel.
    if (typeof value !== "string") {
      return { ok: false, error: "notify.serverUrl must be a string. (expected 'notify.serverUrl': string)" };
    }
    if (!value.trim()) return { ok: true, value: "" };
    let origin: string;
    try {
      origin = canonicalBarkOrigin(value.trim());
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, value: origin };
  }

  return { ok: false, error: `Unsupported Open Bridge setting: ${key}` };
}

/** Device-key character set used by the Bark server: URL-safe, no path syntax. */
const BARK_KEY_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * Turn whatever the operator pasted into a bare device key — or null. The
 * Bark app shows `https://api.day.app/<key>/`, so a full URL is accepted and
 * its first path segment is taken as the key; a bare key passes unchanged.
 * "" means "clear the key" and parses to "".
 */
export function parseBarkKeyInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // A full URL form is matched by ITS OWN grammar and then must yield a good
  // key — a malformed `https://[oops` never reaches the key test as-is:
  // brackets would let it pass the pattern and build a broken Bark URL.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^api\.day\.app\//i.test(trimmed)) {
    const fromUrl = barkKeyFromUrl(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return fromUrl && BARK_KEY_PATTERN.test(fromUrl) ? fromUrl : null;
  }
  return BARK_KEY_PATTERN.test(trimmed) ? trimmed : null;
}

/** First path segment of the URL = the device key. Anything else fails to null. */
function barkKeyFromUrl(input: string): string {
  try {
    const url = new URL(input);
    const first = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return first ? decodeURIComponent(first) : "";
  } catch {
    return "";
  }
}

/**
 * Validate + canonicalize a Bark server origin: https (or http on loopback),
 * no credentials/query/fragment, no path — everything after the origin comes
 * from the key and message, so a stored path could silently retarget pushes.
 */
export function canonicalBarkOrigin(input: string): string {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("notify.serverUrl must be an http(s) origin.");
  if (url.username || url.password) throw new Error("notify.serverUrl must not carry credentials.");
  if (url.search || url.hash) throw new Error("notify.serverUrl must be an origin without a query or fragment.");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("notify.serverUrl must be an origin without a path.");
  const host = url.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  if (url.protocol === "http:" && !loopback) throw new Error("notify.serverUrl may use plain http only on loopback (local development).");
  return url.origin.toLowerCase();
}

/**
 * Mask a stored device key for any display surface: same shape as the route
 * token's redaction (head + tail visible, middle always the same, so short
 * keys cannot leak through a "keep 2/3" split).
 */
export function maskBarkKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}…${"•".repeat(Math.min(key.length - 6, 20))}…${key.slice(-2)}`;
}
