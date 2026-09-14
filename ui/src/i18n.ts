/**
 * Console language: whatever the browser asks for.
 *
 * The console was written Chinese-first and hard-coded, so an English-speaking
 * operator had no way in at all. It briefly had a three-state header switch
 * (跟随浏览器 / 中文 / English) mirroring the theme control; that is gone. The
 * browser already carries the answer, every operator has set it once, and a
 * control whose only job is to restate a preference the platform supplies is a
 * button that exists to be ignored. Theme keeps its switch because people
 * genuinely want dark at night and light by day — language is not like that.
 *
 * Translations are INLINE PAIRS, `t("中文", "English")`, rather than keys into
 * a message table. For a retrofit of an existing Chinese UI that is the safer
 * trade: the two languages sit on one line where a reviewer can see them
 * disagree, and there is no way to add a key and forget its translation (the
 * type system requires both arguments). The cost is that a string used twice
 * is written twice; at this size that is cheaper than a table nobody keeps in
 * sync.
 */

export type ResolvedLang = "zh" | "en";

/**
 * Kept ONLY as a test seam: vitest.setup.ts pins the language per test because
 * jsdom reports navigator.language as en-US, which would otherwise render the
 * console in English and fail every assertion written against Chinese text.
 * Nothing in the shipped UI writes this key.
 */
const STORAGE_KEY = "openBridge.console.lang";

/**
 * Module-level rather than React context: `t()` is called from plain helpers
 * (route labels, formatters) that are not components and cannot use a hook.
 * App keeps the preference in state, so a change re-renders the tree and every
 * `t()` re-reads this on the way through.
 */
let currentLang: ResolvedLang = "zh";

/** The pinned test language, or undefined in a real browser. */
function readLangOverride(): ResolvedLang | undefined {
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    // Private mode / disabled storage: detection answers for this session.
  }
  return undefined;
}

/**
 * Browser language -> a language we actually have.
 *
 * Anything Chinese (zh, zh-CN, zh-TW, zh-Hant…) is zh; everything else gets
 * English, because English is the more likely second language of someone whose
 * browser is set to neither — a Japanese or German operator reads the English
 * console, not the Chinese one.
 */
export function detectLang(): ResolvedLang {
  const tags = [
    ...(Array.isArray(navigator?.languages) ? navigator.languages : []),
    navigator?.language ?? "",
  ];
  for (const tag of tags) {
    if (typeof tag !== "string" || tag.length === 0) continue;
    if (tag.toLowerCase().startsWith("zh")) return "zh";
    return "en";
  }
  return "zh";
}

export function resolveLang(): ResolvedLang {
  return readLangOverride() ?? detectLang();
}

/** The active language. Plain read so non-component helpers can translate. */
export function lang(): ResolvedLang {
  return currentLang;
}

/**
 * Pick a string. Both languages are required arguments, so a new piece of UI
 * cannot ship half-translated.
 */
export function t(zh: string, en: string): string {
  return currentLang === "en" ? en : zh;
}

/**
 * Resolve and apply: sets the module language and the <html lang> attribute
 * (screen readers and the browser's own translate prompt both read it).
 */
export function applyLang(): ResolvedLang {
  const resolved = resolveLang();
  currentLang = resolved;
  try {
    document.documentElement.lang = resolved === "en" ? "en" : "zh-CN";
  } catch {
    // A document stub without documentElement still gets the language itself.
  }
  return resolved;
}

/**
 * Apply at import time, before the first React render, so the first paint is
 * already in the right language instead of flashing Chinese at an English
 * operator. Wrapped because this runs in module scope.
 */
export function initLang(): ResolvedLang {
  try {
    return applyLang();
  } catch {
    // Detection failed (no navigator in a test stub): keep the zh default.
    return currentLang;
  }
}
