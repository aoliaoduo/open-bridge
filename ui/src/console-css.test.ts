/**
 * Specificity guards for rules that hide something.
 *
 * The bug this exists for: `.menu-btn { display: none }` (0-1-0) was outranked
 * by `button.icon-btn { display: inline-flex }` (0-1-1), so the hamburger that
 * opens the mobile drawer was visible at every width. On a wide screen there
 * is no drawer to open, so clicking it did nothing -- a control that is always
 * there and never works.
 *
 * Asserted against the stylesheet text rather than a rendered page: the CSS is
 * only imported by main.tsx, and jsdom does not do cascade resolution anyway,
 * so a DOM test here would prove nothing.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const css = readFileSync(path.join(process.cwd(), "ui/src/console.css"), "utf8");

test("the drawer toggle is hidden by a rule that can actually win", () => {
  // Both the hide and the show must carry the element qualifier, otherwise
  // button.icon-btn takes the cascade.
  assert.match(css, /button\.menu-btn \{ display: none; \}/, "the hide rule needs the element qualifier");
  assert.match(css, /button\.menu-btn \{ display: inline-flex; \}/, "the media-query show rule must match it");
  assert.doesNotMatch(
    css,
    /^\s*\.menu-btn \{ display:/m,
    "a bare .menu-btn display rule loses to button.icon-btn and reintroduces the bug",
  );
});

/**
 * The markup pairs, so the check can ask the real question: for an element
 * that carries BOTH classes, does the hide rule outrank the show rule?
 *
 * A first version of this test only looked for `el.sameClass` and passed
 * against the actual bug, because the rule that won was `button.icon-btn` --
 * a different class on the same element. Checking "is .x outranked by
 * something also matching .x" cannot see that, so the pairs are listed
 * explicitly instead of inferred.
 */
const PAIRED_CLASSES: ReadonlyArray<readonly [hidden: string, alsoOn: string]> = [
  ["menu-btn", "icon-btn"],
];

test("a hide rule outranks the other rules on the same element", () => {
  const specificity = (selector: string): number =>
    (selector.match(/\.[a-z][a-z0-9-]*/g) ?? []).length * 10
    + (/^[a-z]+[.\s]|^[a-z]+$/.test(selector.trim()) ? 1 : 0);

  const displayRules = [...css.matchAll(/^\s*([^{@\n][^{\n]*?)\s*\{([^}]*display:\s*[^;}]+)/gm)]
    .map(match => ({ selector: (match[1] ?? "").trim(), body: match[2] ?? "" }));

  for (const [hiddenClass, companion] of PAIRED_CLASSES) {
    const hide = displayRules.find(
      rule => rule.selector.endsWith(`.${hiddenClass}`) && /display:\s*none/.test(rule.body),
    );
    assert.ok(hide, `no display:none rule found for .${hiddenClass}`);

    const competing = displayRules.filter(
      rule => rule.selector.includes(`.${companion}`) && !/display:\s*none/.test(rule.body),
    );
    for (const rule of competing) {
      assert.ok(
        specificity(hide.selector) >= specificity(rule.selector),
        `.${hiddenClass} is hidden by "${hide.selector}" but "${rule.selector}" sets display and wins`,
      );
    }
  }
});
