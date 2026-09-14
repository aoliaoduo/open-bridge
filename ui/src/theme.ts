/**
 * Color theme: 跟随系统 / 浅色 / 深色, persisted per browser.
 *
 * The stylesheet used to follow `prefers-color-scheme` and nothing else, so an
 * operator on a dark desktop could not get a light console (and vice versa) —
 * every reference dashboard this redesign borrows from puts a switch in the
 * header, and a status board is exactly the kind of screen someone keeps open
 * in a bright room.
 *
 * Resolution happens here rather than in CSS: 跟随系统 is resolved to a concrete
 * light/dark at load time (and again when the OS preference flips, via the
 * media-query listener), so the stylesheet only ever sees two explicit states
 * and the dark palette is written once instead of twice.
 */

import { t } from "./i18n";

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "openBridge.console.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readThemePref(): ThemePref {
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Private mode / disabled storage: fall back to 跟随系统 for this session.
  }
  return "system";
}

/** jsdom and other scripted environments ship no matchMedia; absence = light. */
function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  return systemPrefersDark() ? "dark" : "light";
}

/**
 * Write the resolved theme onto <html> — the single switch the stylesheet reads.
 * A data attribute rather than a class so the value stays readable in devtools
 * and cannot collide with utility classes.
 */
export function applyTheme(pref: ThemePref): ResolvedTheme {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export function storeThemePref(pref: ThemePref): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, pref);
  } catch {
    // Not being able to remember the choice must not break the choice.
  }
}

/** The three-state cycle the header button walks through. */
export function nextThemePref(pref: ThemePref): ThemePref {
  if (pref === "system") return "light";
  if (pref === "light") return "dark";
  return "system";
}

export function themePrefLabel(pref: ThemePref): string {
  if (pref === "light") return t("浅色", "Light");
  if (pref === "dark") return t("深色", "Dark");
  return t("跟随系统", "System");
}

/**
 * Apply at import time, before the first React render, so a dark-desktop
 * operator never sees a white flash on load. Wrapped because this runs in
 * module scope: a thrown error here would take the whole console down.
 */
export function initTheme(): ThemePref {
  const pref = readThemePref();
  try {
    applyTheme(pref);
  } catch {
    // A document without documentElement (a test stub) simply keeps the default.
  }
  return pref;
}

/** Re-resolve while 跟随系统 is active; returns an unsubscribe function. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(DARK_QUERY);
  // addEventListener is the modern API; older Chromium only had addListener.
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  query.addListener(onChange);
  return () => query.removeListener(onChange);
}
