/**
 * Shared setup for the console test suite.
 *
 * The console now picks its language from the browser, and jsdom reports
 * en-US — which would silently flip every existing assertion to English and
 * make the suite a test of the translation rather than of the behaviour it was
 * written for. Pinning 中文 keeps those assertions meaningful; the language
 * machinery itself is covered by i18n.test.ts, which sets its own language
 * explicitly, and by the switch test in App.test.tsx.
 *
 * The stored preference is what gets pinned, not the applied language: App
 * calls initLang() during its first render, which re-reads storage and would
 * otherwise overwrite anything applied here.
 */
import { beforeEach } from "vitest";
import { applyLang } from "./ui/src/i18n";

beforeEach(() => {
  window.localStorage.setItem("openBridge.console.lang", "zh");
  applyLang("zh");
});
