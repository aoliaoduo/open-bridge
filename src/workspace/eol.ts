export type EolStyle = "\n" | "\r\n";

/**
 * Detect the dominant line ending of a file. CRLF counts as one line ending.
 * Defaults to LF (the repo/.gitattributes convention) on ties or no newlines.
 */
export function detectEol(text: string): EolStyle {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  // LF count = total LF minus those that are part of CRLF.
  const lfTotal = (text.match(/\n/g) ?? []).length;
  const lfOnly = lfTotal - crlf;
  return crlf > lfOnly ? "\r\n" : "\n";
}

/** Normalize all line endings to LF for matching against LF-normalized edits. */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Restore a target EOL style (used when writing a file back). */
export function applyEol(text: string, eol: EolStyle): string {
  const lf = toLf(text);
  return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}
