import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  CONFIG_KEY_INPUT_SCHEMA,
  CONFIG_OUTPUT_SCHEMA,
  CONFIG_SPECS,
  CONSOLE_CONFIG_KEYS,
  SETTINGS_VIEW_CONFIG_KEYS,
  settingsConfigFrom,
} from "../src/bridge/config/config-spec.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tool-definitions.js";
import { validateConfigValue } from "../src/bridge/config/config-values.js";
import { normalizeNgrokDomainSetting } from "../src/http/request-policy.js";

test("one config catalog drives defaults and MCP schemas", () => {
  assert.deepEqual(Object.keys(CONFIG_DEFAULTS), CONFIG_KEYS);
  assert.deepEqual(CONFIG_OUTPUT_SCHEMA.required, CONFIG_KEYS);
  assert.deepEqual(Object.keys(CONFIG_OUTPUT_SCHEMA.properties), CONFIG_KEYS);
  assert.deepEqual(CONFIG_KEY_INPUT_SCHEMA.enum, CONFIG_KEYS);

  for (const key of CONFIG_KEYS) {
    assert.deepEqual(CONFIG_DEFAULTS[key], CONFIG_SPECS[key].default, key);
    assert.deepEqual(CONFIG_OUTPUT_SCHEMA.properties[key], CONFIG_SPECS[key].schema, key);
  }
});

test("every catalog key has a write-validation path that accepts its own default", () => {
  for (const key of CONFIG_KEYS) {
    if (key === "ngrokDomain") {
      assert.equal(normalizeNgrokDomainSetting(CONFIG_DEFAULTS[key]), "");
      continue;
    }
    const checked = validateConfigValue(key, CONFIG_DEFAULTS[key]);
    assert.equal(checked.ok, true, key + " default must not fall through to Unsupported Open Bridge setting");
  }
});

test("tool definitions consume the canonical config schemas", () => {
  const getConfig = TOOL_DEFINITIONS.find(tool => tool.name === "get_config");
  const setConfig = TOOL_DEFINITIONS.find(tool => tool.name === "set_config_value");
  assert.ok(getConfig);
  assert.ok(setConfig);
  assert.deepEqual(getConfig.outputSchema, CONFIG_OUTPUT_SCHEMA);
  assert.deepEqual(setConfig.inputSchema.properties.key, CONFIG_KEY_INPUT_SCHEMA);
});

test("console write keys and settings-state projection come from distinct catalog flags", () => {
  const writable = CONFIG_KEYS.filter(key => "console" in CONFIG_SPECS[key] && CONFIG_SPECS[key].console === true);
  const visible = CONFIG_KEYS.filter(key => "view" in CONFIG_SPECS[key] && CONFIG_SPECS[key].view === true);
  assert.deepEqual(CONSOLE_CONFIG_KEYS, writable);
  assert.deepEqual(SETTINGS_VIEW_CONFIG_KEYS, visible);
  assert.ok(CONSOLE_CONFIG_KEYS.includes("notify.enabled"));
  assert.equal(SETTINGS_VIEW_CONFIG_KEYS.includes("notify.enabled" as never), false,
    "notify settings live in SettingsState.notify, not the generic config projection");

  const projected = settingsConfigFrom((_key, fallback) =>
    Array.isArray(fallback) ? [...fallback] : fallback);
  assert.deepEqual(Object.keys(projected), SETTINGS_VIEW_CONFIG_KEYS);
  for (const key of SETTINGS_VIEW_CONFIG_KEYS) {
    assert.deepEqual(projected[key], CONFIG_DEFAULTS[key], key);
  }
});
