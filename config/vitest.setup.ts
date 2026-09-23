/**
 * Shared setup for the console test suite.
 *
 * The console picks its language from the browser, and jsdom reports en-US —
 * which would silently flip every existing assertion to English and make the
 * suite a test of the translation rather than of the behaviour it was written
 * for. Pinning 中文 keeps those assertions meaningful; the detection rules
 * themselves are covered by i18n.test.ts, which stubs navigator directly.
 *
 * The localStorage key is a TEST SEAM, not a user setting: the shipped console
 * has no language switch and never writes it. It is read by resolveLang() as
 * an override so a test can pin a language without stubbing navigator in every
 * file. Both halves are set because App calls initLang() during its first
 * render, which re-resolves and would otherwise overwrite an applied language.
 */
import { beforeEach } from "vitest";
import { applyLang } from "../ui/src/i18n";

beforeEach(() => {
  window.localStorage.setItem("openBridge.console.lang", "zh");
  applyLang();
});
