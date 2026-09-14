/**
 * Console language: 跟随浏览器 / 中文 / English, persisted per browser.
 *
 * The console was written Chinese-first and hard-coded, so an English-speaking
 * operator had no way in at all. This is the same shape as theme.ts on purpose
 * — detect, allow an explicit override, remember it — because the two settings
 * answer the same kind of question and should not behave differently.
 *
 * Translations are INLINE PAIRS, `t("中文", "English")`, rather than keys into
 * a message table. For a retrofit of an existing Chinese UI that is the safer
 * trade: the two languages sit on one line where a reviewer can see them
 * disagree, and there is no way to add a key and forget its translation (the
 * type system requires both arguments). The cost is that a string used twice
 * is written twice; at this size that is cheaper than a table nobody keeps in
 * sync.
 */

export type LangPref = "system" | "zh" | "en";
export type ResolvedLang = "zh" | "en";

const STORAGE_KEY = "openBridge.console.lang";

/**
 * Module-level rather than React context: `t()` is called from plain helpers
 * (route labels, formatters) that are not components and cannot use a hook.
 * App keeps the preference in state, so a change re-renders the tree and every
 * `t()` re-reads this on the way through.
 */
let currentLang: ResolvedLang = "zh";

function readLangPref(): LangPref {
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en" || stored === "system") return stored;
  } catch {
    // Private mode / disabled storage: fall back to detection for this session.
  }
  return "system";
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

export function resolveLang(pref: LangPref): ResolvedLang {
  if (pref === "zh" || pref === "en") return pref;
  return detectLang();
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
 * Apply a preference: sets the module language and the <html lang> attribute
 * (screen readers and the browser's own translate prompt both read it).
 */
export function applyLang(pref: LangPref): ResolvedLang {
  const resolved = resolveLang(pref);
  currentLang = resolved;
  try {
    document.documentElement.lang = resolved === "en" ? "en" : "zh-CN";
  } catch {
    // A document stub without documentElement still gets the language itself.
  }
  return resolved;
}

export function storeLangPref(pref: LangPref): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, pref);
  } catch {
    // Not being able to remember the choice must not break the choice.
  }
}

/** The three-state cycle the header button walks through. */
export function nextLangPref(pref: LangPref): LangPref {
  if (pref === "system") return "zh";
  if (pref === "zh") return "en";
  return "system";
}

/**
 * Label for the switch. Each language names itself (中文, English) rather than
 * being translated, which is how a language picker stays usable to someone who
 * cannot read the language currently active.
 */
export function langPrefLabel(pref: LangPref): string {
  if (pref === "zh") return "中文";
  if (pref === "en") return "English";
  return t("跟随浏览器", "Auto");
}

/**
 * Apply at import time, before the first React render, so the first paint is
 * already in the right language instead of flashing Chinese at an English
 * operator. Wrapped because this runs in module scope.
 */
export function initLang(): LangPref {
  const pref = readLangPref();
  try {
    applyLang(pref);
  } catch {
    // Detection failed (no navigator in a test stub): keep the zh default.
  }
  return pref;
}
