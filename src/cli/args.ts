/**
 * Argument parsing and the fatal-exit helper, shared by every command.
 *
 * `fail` lives here rather than in each command module so the exit code and
 * the `open-bridge: ` prefix have exactly one definition.
 */

export type ParsedArgs = { command: string; rest: string[]; flags: Map<string, string | true> };

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

