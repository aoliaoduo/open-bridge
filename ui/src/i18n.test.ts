import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyLang, detectLang, lang, resolveLang, t } from "./i18n";

/**
 * Language selection is the one piece of the console an English operator meets
 * before they can read anything else, so the detection rules are pinned here
 * rather than left to manual checking.
 *
 * There is no language switch: the browser decides. What used to be a
 * three-state preference (跟随浏览器 / 中文 / English) is gone, so the tests
 * that covered the cycle and its button label went with it — the remaining
 * surface is detection, application, and the storage override that exists for
 * these tests.
 */

function stubLanguages(languages: string[], primary = languages[0] ?? "") {
  vi.stubGlobal("navigator", { languages, language: primary });
}

beforeEach(() => {
  // The seam vitest.setup.ts uses; cleared per test so detection is visible.
  window.localStorage.clear();
  applyLang();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("detectLang", () => {
  test("every flavour of Chinese resolves to 中文", () => {
    for (const tag of ["zh", "zh-CN", "zh-TW", "zh-Hant-HK", "ZH-cn"]) {
      stubLanguages([tag]);
      expect(detectLang(), tag).toBe("zh");
    }
  });

  test("a non-Chinese browser gets English, not just en-*", () => {
    // The rule is "Chinese or else English": a German operator reads the
    // English console, since it is the likelier second language of the two.
    for (const tag of ["en", "en-GB", "de-DE", "ja", "fr"]) {
      stubLanguages([tag]);
      expect(detectLang(), tag).toBe("en");
    }
  });

  test("the first entry wins, because it is the user's own ranking", () => {
    stubLanguages(["en-US", "zh-CN"]);
    expect(detectLang()).toBe("en");
    stubLanguages(["zh-CN", "en-US"]);
    expect(detectLang()).toBe("zh");
  });

  test("a browser that reports nothing usable falls back instead of throwing", () => {
    stubLanguages([], "");
    expect(detectLang()).toBe("zh");
    vi.stubGlobal("navigator", undefined);
    expect(() => detectLang()).not.toThrow();
  });
});

describe("applying the detected language", () => {
  test("the browser decides, with no preference to consult", () => {
    stubLanguages(["en-US"]);
    expect(resolveLang()).toBe("en");
    stubLanguages(["zh-CN"]);
    expect(resolveLang()).toBe("zh");
  });

  test("t() follows the applied language and <html lang> follows with it", () => {
    stubLanguages(["en-US"]);
    applyLang();
    expect(lang()).toBe("en");
    expect(t("状态", "Status")).toBe("Status");
    expect(document.documentElement.lang).toBe("en");

    stubLanguages(["zh-CN"]);
    applyLang();
    expect(t("状态", "Status")).toBe("状态");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  test("the stored test seam overrides detection, so suites can pin a language", () => {
    // Not a user setting — the shipped console never writes this key. It is
    // how vitest.setup.ts keeps Chinese assertions meaningful under jsdom,
    // which reports en-US.
    stubLanguages(["en-US"]);
    window.localStorage.setItem("openBridge.console.lang", "zh");
    expect(resolveLang()).toBe("zh");
    window.localStorage.setItem("openBridge.console.lang", "en");
    expect(resolveLang()).toBe("en");
  });

  test("storage refusing to cooperate falls back to detection", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    stubLanguages(["en-US"]);
    expect(() => resolveLang()).not.toThrow();
    expect(resolveLang()).toBe("en");
    getItem.mockRestore();
  });
});
