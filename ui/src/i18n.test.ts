import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  applyLang, detectLang, lang, langPrefLabel, nextLangPref, resolveLang, storeLangPref, t,
} from "./i18n";

/**
 * Language selection is the one piece of the console an English operator meets
 * before they can read anything else, so the detection rules are pinned here
 * rather than left to manual checking.
 */

function stubLanguages(languages: string[], primary = languages[0] ?? "") {
  vi.stubGlobal("navigator", { languages, language: primary });
}

beforeEach(() => {
  applyLang("zh");
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

describe("preference resolution", () => {
  test("an explicit choice overrides the browser", () => {
    stubLanguages(["en-US"]);
    expect(resolveLang("zh")).toBe("zh");
    expect(resolveLang("en")).toBe("en");
    expect(resolveLang("system")).toBe("en");
  });

  test("t() follows the applied language and <html lang> follows with it", () => {
    applyLang("en");
    expect(lang()).toBe("en");
    expect(t("状态", "Status")).toBe("Status");
    expect(document.documentElement.lang).toBe("en");

    applyLang("zh");
    expect(t("状态", "Status")).toBe("状态");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  test("the cycle visits all three states and returns", () => {
    expect(nextLangPref("system")).toBe("zh");
    expect(nextLangPref("zh")).toBe("en");
    expect(nextLangPref("en")).toBe("system");
  });

  test("each language names itself, so the switch stays readable either way", () => {
    applyLang("en");
    expect(langPrefLabel("zh")).toBe("中文");
    expect(langPrefLabel("en")).toBe("English");
    applyLang("zh");
    expect(langPrefLabel("zh")).toBe("中文");
    expect(langPrefLabel("en")).toBe("English");
  });

  test("storage refusing to cooperate does not break the choice", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => storeLangPref("en")).not.toThrow();
    setItem.mockRestore();
  });
});
