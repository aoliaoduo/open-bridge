/**
 * ANSI escape-sequence stripping for process output returned to MCP clients.
 *
 * Colors, cursor movement, OSC hyperlinks and friends burn tokens and pollute
 * the model context, so tool results strip them by default (`strip_ansi: false`
 * keeps the raw text). Pure module with no bridge state access.
 */

// Battle-tested shape (same coverage as the widely used ansi-regex package):
// CSI sequences, OSC sequences terminated by BEL, and two-byte/designate escapes.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** Remove ANSI escape/control sequences from `text`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Apply the `strip_ansi` tool argument semantics (default true) to a result field. */
export function maybeStripAnsi(text: string, stripArg: unknown): string {
  return stripArg === false ? text : stripAnsi(text);
}
