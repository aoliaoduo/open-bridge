/**
 * The package version, read once.
 *
 * Its own module so every command module can print it without importing the
 * entry point (which would be a cycle) or re-reading package.json.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

export const VERSION: string = pkg.version;
