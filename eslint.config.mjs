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
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
