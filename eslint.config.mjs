import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Conservative start: JS recommended + TypeScript recommended.
// no-explicit-any stays a warning (existing code has legitimate escape hatches);
// empty catch blocks are an intentional best-effort pattern; build output,
// bundled assets and dependencies are not linted.
export default tseslint.config(
  { ignores: ["dist/**", "build/**", "ui/dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TypeScript itself flags undefined identifiers, so the JS rule is redundant there.
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off",
      // The base rule misfires on TS-only constructs (enums, namespaces,
      // declaration merging); the typed one understands them.
      "no-shadow": "off",
      "@typescript-eslint/no-shadow": "error",
    },
  },
  {
    // Plain node scripts (release tooling, the contract test) use node globals.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      // `_`-prefixed args/locals are the codebase's explicit "kept for shape"
      // marker (callback signatures, destructured omissions): the rule stays
      // loud for real mistakes without forcing zero-arg contortions.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // A local that shadows an import or an outer function reads like the outer
      // one. TypeScript would catch a real misuse at compile time, but it reads
      // as a bug first and costs a re-read every time — and `host`, `root`,
      // `record`, `before`/`after` are names this codebase already uses at
      // module scope, so the confusion is not hypothetical.
      "no-shadow": "error",
    },
  },
);
