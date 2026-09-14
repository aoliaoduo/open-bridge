/**
 * Settings sub-page routing: the path model (/console/settings/<section>) and
 * its tolerant parsing. These are pure functions — no jsdom navigation, the
 * pathname comes in as an argument.
 */
import { describe, expect, test } from "vitest";

import {
  currentRoute, currentSettingsSection, settingsSectionPath,
  SETTINGS_DEFAULT_SECTION, SETTINGS_SECTIONS,
} from "./routes";

describe("currentRoute", () => {
  test("a settings sub-page path is the settings route, not an unknown one", () => {
    expect(currentRoute("/console/settings/notify")).toBe("settings");
    expect(currentRoute("/console/settings/logs")).toBe("settings");
    // Bare settings keeps working; unknown sections are the section parser's
    // problem, never a fall-through to 状态.
    expect(currentRoute("/console/settings")).toBe("settings");
    expect(currentRoute("/console/settings/nonsense")).toBe("settings");
  });

  test("other routes are untouched by the sub-page rule", () => {
    expect(currentRoute("/console/status")).toBe("status");
    expect(currentRoute("/console/security")).toBe("security");
    expect(currentRoute("/console/tokens")).toBe("security", );
    expect(currentRoute("/console")).toBe("status");
  });
});

describe("currentSettingsSection", () => {
  test("parses a known section tail", () => {
    expect(currentSettingsSection("/console/settings/notify")).toBe("notify");
    expect(currentSettingsSection("/console/settings/logs/")).toBe("logs");
  });

  test("bare settings, foreign paths and junk tails all land on the default", () => {
    expect(currentSettingsSection("/console/settings")).toBe(SETTINGS_DEFAULT_SECTION);
    expect(currentSettingsSection("/console")).toBe(SETTINGS_DEFAULT_SECTION);
    expect(currentSettingsSection("/console/settings/nonsense")).toBe(SETTINGS_DEFAULT_SECTION);
    expect(currentSettingsSection("")).toBe(SETTINGS_DEFAULT_SECTION);
  });

  test("every declared section round-trips through its path", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(currentSettingsSection(settingsSectionPath(section.id))).toBe(section.id);
    }
  });
});
