/**
 * The English half of a bilingual console has to actually be English.
 *
 * Two strings had leaked: "Open 体检" as a button label and a sentence that
 * opened with 体检 in the English text. Both came from the same habit —
 * treating a page name as a proper noun and leaving it untranslated — and
 * both are invisible unless you switch the console to English and read it,
 * which nobody does on a Chinese desktop.
 *
 * Not a blanket "no CJK in the second argument": Bark, ngrok and Shell are
 * product names that belong in both halves, and the Chinese side legitimately
 * mixes scripts ("Bearer 门禁"). The check is narrower and therefore useful —
 * the ENGLISH string must not contain Han characters.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const HAN = /[\u4e00-\u9fff]/;

/** Extract both arguments of every t("…", "…") call, multi-line tolerant. */
function translationPairs(source: string): Array<{ zh: string; en: string }> {
  const pairs: Array<{ zh: string; en: string }> = [];
  for (let i = 0; i < source.length;) {
    const start = source.indexOf("t(", i);
    if (start < 0) break;
    const before = start > 0 ? source[start - 1] ?? "" : "";
    if (/[\w$.]/.test(before)) { i = start + 2; continue; }

    let depth = 0;
    let end = start + 1;
    for (let k = start + 1; k < source.length; k += 1) {
      const ch = source[k];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) { end = k; break; }
      }
    }
    const body = source.slice(start + 2, end);
    // Arguments are split on top-level commas BEFORE literals are collected.
    // Long hints are written as "part one " + "part two", and a naive
    // "first literal is Chinese, second is English" read then treats the
    // Chinese continuation as the translation — which produced two false
    // reports the first time this test ran.
    const args: string[] = [];
    let argDepth = 0;
    let current = "";
    let inString = false;
    for (let k = 0; k < body.length; k += 1) {
      const ch = body[k] ?? "";
      if (inString) {
        current += ch;
        if (ch === "\\") { current += body[k + 1] ?? ""; k += 1; }
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") { inString = true; current += ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") argDepth += 1;
      if (ch === ")" || ch === "]" || ch === "}") argDepth -= 1;
      if (ch === "," && argDepth === 0) { args.push(current); current = ""; continue; }
      current += ch;
    }
    args.push(current);

    const joinLiterals = (arg: string): string =>
      [...arg.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1] ?? "").join("");
    if (args.length >= 2) {
      pairs.push({ zh: joinLiterals(args[0] ?? ""), en: joinLiterals(args[1] ?? "") });
    }
    i = end + 1;
  }
  return pairs;
}

function uiSources(): string[] {
  const roots = ["ui/src", "ui/src/components"];
  const files: string[] = [];
  for (const root of roots) {
    for (const name of readdirSync(path.join(process.cwd(), root))) {
      if (name.includes(".test.")) continue;
      if (!name.endsWith(".tsx") && !name.endsWith(".ts")) continue;
      files.push(path.join(root, name));
    }
  }
  return files;
}

test("the English side of every translation is English", () => {
  const offenders: string[] = [];
  for (const file of uiSources()) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    for (const { zh, en } of translationPairs(source)) {
      if (HAN.test(en)) offenders.push(`${path.basename(file)}: ${JSON.stringify(zh).slice(0, 34)} -> ${JSON.stringify(en).slice(0, 44)}`);
    }
  }
  assert.deepEqual(offenders, [], `English strings containing Han characters:\n  ${offenders.join("\n  ")}`);
});

test("no translation is missing its English half", () => {
  const offenders: string[] = [];
  for (const file of uiSources()) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    for (const { zh, en } of translationPairs(source)) {
      if (!en.trim() && zh.trim()) offenders.push(`${path.basename(file)}: ${JSON.stringify(zh).slice(0, 40)}`);
    }
  }
  assert.deepEqual(offenders, [], `translations with an empty English side:\n  ${offenders.join("\n  ")}`);
});

test("no raw Han characters in UI code outside comments and t() translations", () => {
  const offenders: string[] = [];
  for (const file of uiSources()) {
    let source = readFileSync(path.join(process.cwd(), file), "utf8");
    source = source.replace(/\/\*[\s\S]*?\*\//g, "");
    source = source.replace(/\/\/.*$/gm, "");
    source = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

    let stripped = "";
    let i = 0;
    while (i < source.length) {
      const start = source.indexOf("t(", i);
      if (start < 0) {
        stripped += source.slice(i);
        break;
      }
      const before = start > 0 ? source[start - 1] ?? "" : "";
      if (/[\w$.]/.test(before)) {
        stripped += source.slice(i, start + 2);
        i = start + 2;
        continue;
      }
      stripped += source.slice(i, start);
      let depth = 0;
      let end = start + 1;
      for (let k = start + 1; k < source.length; k += 1) {
        const ch = source[k];
        if (ch === "(") depth += 1;
        else if (ch === ")") {
          depth -= 1;
          if (depth === 0) { end = k; break; }
        }
      }
      i = end + 1;
    }

    const lines = stripped.split("\n");
    for (let lineNo = 1; lineNo <= lines.length; lineNo += 1) {
      const line = lines[lineNo - 1] ?? "";
      if (HAN.test(line)) {
        offenders.push(`${path.basename(file)}:${lineNo}: ${line.trim().slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Raw Han characters found outside t():\n  ${offenders.join("\n  ")}`);
});
