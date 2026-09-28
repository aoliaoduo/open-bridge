/**
 * Canonical Open Bridge configuration catalog.
 *
 * This file owns only stable metadata: key, default value, JSON shape and
 * whether the generic console settings action may write the key. Complex value
 * validation stays in config-values.ts; stateful gates stay with their callers.
 * Keeping this module dependency-free also lets the React console import types
 * derived from it without pulling node-only code into the browser bundle.
 */
export type ConfigJsonSchema =
  | { type: "boolean" }
  | { type: "number"; minimum?: number; maximum?: number }
  | { type: "string"; enum?: readonly string[] }
  | { type: "array"; items: { type: "string" } };

type ConfigSpecOptions = {
  /** Writable through the console's generic setConfig action. */
  console?: true;
  /** Included in SettingsState.config; some writable keys have dedicated views. */
  view?: true;
};

const PAGE_SETTING = { console: true, view: true } as const;
const CONSOLE_ONLY_SETTING = { console: true } as const;

type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T;

function entry<T, O extends ConfigSpecOptions = Record<never, never>>(
  defaultValue: T,
  schema: ConfigJsonSchema,
  options?: O,
): { default: Widen<T>; schema: ConfigJsonSchema } & O {
  return { default: defaultValue, schema, ...(options ?? {}) } as { default: Widen<T>; schema: ConfigJsonSchema } & O;
}

export const CONFIG_SPECS = {
  tunnelProvider: entry("ngrok", { type: "string", enum: ["none", "ngrok", "tailscale"] }, PAGE_SETTING),
  ngrokDomain: entry("", { type: "string" }),
  tailscaleDomain: entry("", { type: "string" }, PAGE_SETTING),
  tailscaleExecutable: entry("", { type: "string" }, PAGE_SETTING),
  ngrokExecutable: entry("ngrok", { type: "string" }, PAGE_SETTING),
  sharedPeerRegistry: entry("", { type: "string" }),
  shellPath: entry("", { type: "string" }, PAGE_SETTING),
  shellArgs: entry([] as string[], { type: "array", items: { type: "string" } }, PAGE_SETTING),
  unrestrictedFileAccess: entry(true, { type: "boolean" }, PAGE_SETTING),
  allowedDirectories: entry([] as string[], { type: "array", items: { type: "string" } }, PAGE_SETTING),
  port: entry(0, { type: "number", minimum: 0, maximum: 65535 }, PAGE_SETTING),
  publicHealthTimeoutMs: entry(20_000, { type: "number", minimum: 3_000, maximum: 120_000 }, PAGE_SETTING),
  autoReconnect: entry(true, { type: "boolean" }, PAGE_SETTING),
  ngrokUseHttpProxy: entry(true, { type: "boolean" }, PAGE_SETTING),
  toolProfile: entry("full", { type: "string", enum: ["full", "core"] }, PAGE_SETTING),
  logMaxBytes: entry(10 * 1024 * 1024, { type: "number", minimum: 0, maximum: 1024 * 1024 * 1024 }, PAGE_SETTING),
  "auth.enabled": entry(false, { type: "boolean" }),
  "auth.tokenTtlSeconds": entry(0, { type: "number", minimum: 0, maximum: 2_147_483_647 }),
  "oauth.enabled": entry(false, { type: "boolean" }, PAGE_SETTING),
  "oauth.allowedRedirectHosts": entry([] as string[], { type: "array", items: { type: "string" } }, PAGE_SETTING),
  "concurrency.enabled": entry(true, { type: "boolean" }),
  "concurrency.holdTimeoutMs": entry(300_000, { type: "number", minimum: 0, maximum: 2_147_483_647 }),
  "concurrency.waitTimeoutMs": entry(120_000, { type: "number", minimum: 0, maximum: 2_147_483_647 }),
  "notify.enabled": entry(true, { type: "boolean" }, CONSOLE_ONLY_SETTING),
  "notify.barkKey": entry("", { type: "string" }),
  "notify.serverUrl": entry("https://api.day.app", { type: "string" }, CONSOLE_ONLY_SETTING),
  "sound.enabled": entry(false, { type: "boolean" }, PAGE_SETTING),
  "sound.fileWaiting": entry("", { type: "string" }, PAGE_SETTING),
  "sound.fileFinished": entry("", { type: "string" }, PAGE_SETTING),
} as const;

export type ConfigKey = keyof typeof CONFIG_SPECS;
type SpecValue<K extends ConfigKey> = (typeof CONFIG_SPECS)[K]["default"];
export type ConfigValues = { [K in ConfigKey]: SpecValue<K> };
export type ConsoleConfigKey = {
  [K in ConfigKey]: (typeof CONFIG_SPECS)[K] extends { console: true } ? K : never
}[ConfigKey];
export type SettingsViewConfigKey = {
  [K in ConfigKey]: (typeof CONFIG_SPECS)[K] extends { view: true } ? K : never
}[ConfigKey];
export type SettingsConfigView = { [K in SettingsViewConfigKey]: SpecValue<K> };

export const CONFIG_KEYS = Object.freeze(Object.keys(CONFIG_SPECS) as ConfigKey[]);
const CONFIG_KEY_SET: ReadonlySet<string> = new Set(CONFIG_KEYS);
export const CONSOLE_CONFIG_KEYS = Object.freeze(
  CONFIG_KEYS.filter(key => "console" in CONFIG_SPECS[key] && CONFIG_SPECS[key].console === true),
) as readonly ConsoleConfigKey[];
export const SETTINGS_VIEW_CONFIG_KEYS = Object.freeze(
  CONFIG_KEYS.filter(key => "view" in CONFIG_SPECS[key] && CONFIG_SPECS[key].view === true),
) as readonly SettingsViewConfigKey[];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CONFIG_DEFAULTS = deepFreeze(Object.fromEntries(
  CONFIG_KEYS.map(key => [key, CONFIG_SPECS[key].default]),
) as ConfigValues);

export function isConfigKey(value: string): value is ConfigKey {
  return CONFIG_KEY_SET.has(value);
}

export function settingsConfigFrom(
  read: (key: SettingsViewConfigKey, fallback: ConfigValues[SettingsViewConfigKey]) => unknown,
): SettingsConfigView {
  return Object.fromEntries(
    SETTINGS_VIEW_CONFIG_KEYS.map(key => [key, read(key, CONFIG_DEFAULTS[key])]),
  ) as SettingsConfigView;
}

export const CONFIG_OUTPUT_SCHEMA = {
  type: "object",
  required: [...CONFIG_KEYS],
  properties: Object.fromEntries(CONFIG_KEYS.map(key => [key, CONFIG_SPECS[key].schema])),
} as const;

export const CONFIG_KEY_INPUT_SCHEMA = {
  type: "string",
  enum: [...CONFIG_KEYS],
  description: "Declared Open Bridge configuration key to change.",
} as const;
