/**
 * Argument parsing and the fatal-exit helper, shared by every command.
 *
 * `fail` lives here rather than in each command module so the exit code and
 * the `open-bridge: ` prefix have exactly one definition.
 */
import { t } from "./cli-i18n.js";

export type ParsedArgs = { command: string; rest: string[]; flags: Map<string, string | true> };

/** A usage error thrown by the parser itself. `main()`'s catch prints it with
 *  the same `open-bridge: ` prefix and exit code `fail()` would. */
export class UsageError extends Error {}

/**
 * Flags that take a value. A bare one (end of argv, or the next token is
 * another flag) is a usage error rather than a boolean `true`: the leftover
 * `true` was coerced at the read sites — `Number(true)` is 1, so
 * `token create --ttl` minted a token that expired in one second, bare
 * `stop --pid` silently targeted "this directory's instance" instead of the
 * pid the caller was pointing at, and `serve --root` died in
 * `path.resolve(true)` with a TypeError that named no flag. `--port` had
 * already been fixed at its own read site; the parser is the one place every
 * reader is protected at once.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "home", "root", "port", "label", "ttl", "pid", "out", "tail",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    // Unreachable (i < rest.length), but stating it narrows `arg` to string for
    // the whole body instead of sprinkling fallbacks over three use sites.
    if (arg === undefined) break;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i += 1;
      } else if (VALUE_FLAGS.has(key)) {
        throw new UsageError(t(
          `--${key} 需要一个值（收到的是裸旗标）。`,
          `--${key} needs a value (a bare flag was given).`,
        ));
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, rest: positional, flags };
}

export function fail(message: string): never {
  console.error(`open-bridge: ${message}`);
  process.exit(1);
}
