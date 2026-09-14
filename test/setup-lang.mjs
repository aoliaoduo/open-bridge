/**
 * Pin the CLI's language for the integration suites.
 *
 * These tests spawn `bin/open-bridge.js` and assert on its human-readable
 * output, which is bilingual: `cli-i18n.ts` picks Chinese or English from
 * `OPEN_BRIDGE_LANG`, then `LC_ALL` / `LC_MESSAGES` / `LANG`. The assertions
 * are written against the Chinese strings, so the language has to be a stated
 * precondition rather than a property of whoever's machine is running them.
 *
 * Without this the suites pass on a zh_CN developer box and fail on CI, where
 * no locale is set and the CLI correctly answers in English -- the tests would
 * be measuring the environment instead of the code. The UI suites hit exactly
 * this (jsdom reports en-US) and fixed it the same way, in `vitest.setup.ts`;
 * the .mjs suites were left out of that pass.
 *
 * Set before any test file is imported, so it is inherited by every child
 * process regardless of whether that spawn site passes an explicit `env`.
 */
process.env.OPEN_BRIDGE_LANG = "zh";
