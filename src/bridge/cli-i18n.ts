/**
 * Language for anything the CLI prints.
 *
 * The console picks its language from the browser; a terminal has no such
 * signal, so this reads the POSIX locale variables the way every other CLI
 * does. Same inline-pair shape as ui/src/i18n.ts (`t("中文", "English")`) so
 * the two halves of the project state translations identically — see that file
 * for why pairs beat a message table here.
 *
 * `OPEN_BRIDGE_LANG` wins over the locale: a user whose system is English but
 * who wants Chinese output (or the reverse) needs a way to say so that does not
 * involve changing their whole locale.
 */

type CliLang = "zh" | "en";

let current: CliLang | null = null;

/**
 * Decide from the environment. Chinese only when the locale actually says
 * Chinese; everything else is English, because English is the safer default
 * for a locale we do not recognise (the reverse would show Chinese to someone
 * who cannot read it).
 */
export function detectCliLang(env: NodeJS.ProcessEnv = process.env): CliLang {
  const override = (env.OPEN_BRIDGE_LANG ?? "").trim().toLowerCase();
  if (override.startsWith("zh")) return "zh";
  if (override.length > 0) return "en";

  // LC_ALL overrides LC_MESSAGES overrides LANG — the POSIX precedence.
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"] as const) {
    const value = (env[name] ?? "").trim();
    if (value.length === 0) continue;
    // "C" and "POSIX" are the explicit "no locale" answers, not a language.
    if (value === "C" || value === "POSIX") return "en";
    return value.toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  // No locale set at all is normal on Windows, where the console has been
  // Chinese since this project began; keeping that avoids silently switching
  // the existing user's terminal to English on upgrade.
  return "zh";
}

/** Resolve lazily once so output stays consistent throughout the process. */
function cliLang(): CliLang {
  current ??= detectCliLang();
  return current;
}

/** Pick a string. Both languages required, so nothing ships half-translated. */
export function t(zh: string, en: string): string {
  return cliLang() === "en" ? en : zh;
}
