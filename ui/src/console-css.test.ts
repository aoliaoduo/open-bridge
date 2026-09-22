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

/**
 * The drawer toggle has now been wrong twice: first visible at every width
 * because the hide rule lost the cascade, then still in the DOM after the CSS
 * was fixed — focusable, clickable, and toggling state no stylesheet responds
 * to above the breakpoint. It is rendered conditionally now, so the guard that
 * matters is that the two breakpoints agree.
 */
test("the drawer breakpoint in Topbar matches the one in the stylesheet", () => {
  const ts = readFileSync(path.join(process.cwd(), "ui/src/components/Topbar.tsx"), "utf8");
  const declared = /DRAWER_MAX_WIDTH = (\d+)/.exec(ts)?.[1];
  assert.ok(declared, "Topbar must declare the breakpoint it renders against");
  assert.match(
    css,
    new RegExp(`@media \\(max-width: ${declared}px\\)`),
    `console.css has no @media at ${declared}px, so the button renders at widths where the drawer does not exist`,
  );
  // And that media query must be the one that actually builds the drawer.
  //
  // Slicing a fixed number of characters does NOT work here and the first
  // version of this test proved it: the 1080px block is three lines long, so
  // a 1200-char window ran straight into the 900px block below it and found
  // drawer-open there. The test passed while pointing at the wrong
  // breakpoint. Walk the braces instead.
  const open = css.indexOf(`@media (max-width: ${declared}px)`);
  let depth = 0;
  let end = open;
  for (let i = css.indexOf("{", open); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.match(
    css.slice(open, end),
    /drawer-open/,
    `the @media at ${declared}px exists but is not the drawer's own block`,
  );
});

/**
 * Type was eleven sizes, four of them (13 / 12.5 / 12 / 11.5) inside a 1.5px
 * band. Sizes that close cannot be ranked by eye, so they read as sloppiness
 * rather than hierarchy — and each one was added by someone solving a local
 * problem, which is exactly how a scale erodes.
 *
 * The guard is not "never write a px": it is that font-size goes through the
 * scale, so adding a sixth step is a deliberate edit to :root rather than a
 * number typed into one rule.
 */
test("every font-size comes from the type scale", () => {
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  const steps = [...root.matchAll(/--fs-(\w+):/g)].map(m => m[1]);
  assert.deepEqual(steps, ["xs", "sm", "md", "lg", "xl"], "five steps, in order");

  // Usages outside :root must reference the tokens.
  const body = css.slice(root.length);
  const literals = [...body.matchAll(/font-size:\s*([\d.]+px)/g)].map(m => m[1]);
  assert.deepEqual(
    literals,
    [],
    `these font-sizes bypass the scale: ${[...new Set(literals)].join(", ")}`,
  );
});
