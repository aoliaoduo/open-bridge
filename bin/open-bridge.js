#!/usr/bin/env node
import { main } from "../dist/cli.js";

main().catch(error => {
  console.error(`open-bridge: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
