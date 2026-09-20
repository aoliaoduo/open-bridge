/**
 * Small glob matcher for find_files, supporting *, **, ?, {a,b}, [abc] and
 * character ranges. Matching is case-insensitive (consistent with the previous
 * substring behaviour on Windows) and uses forward slashes.
 */

function escapeForRegExp(source: string): string {
  return source.replace(/[.+^${}()|\\]/g, "\\$&");
}

/** Translate a glob pattern into a RegExp source string (no anchors). */
function globToRegExpSource(pattern: string): string {
  const p = pattern.replace(/\\/g, "/");
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    // Unreachable (i < p.length), but it narrows `ch` to string for the whole
    // body — the comparisons below tolerate undefined, escapeForRegExp does not.
    if (ch === undefined) break;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        i++;
        if (p[i + 1] === "/") {
          // `**/` matches zero or more COMPLETE path segments. The old bare
          // `.*` also swallowed the separator, so "**/host.ts" matched
          // "node-host.ts" (`.*` ate "src/host/node-"): a `**` segment must
          // align to segment boundaries — or match none at all.
          i++;
          out += "(?:.*/)?";
        } else {
          // a bare ** still crosses path separators
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      let j = i + 1;
      if (p[j] === "!") j++;
      if (p[j] === "]") j++;
      while (j < p.length && p[j] !== "]") j++;
      if (j >= p.length) {
        out += "\\["; // unterminated -> literal
      } else {
        // Glob semantics: "!" as the FIRST class character negates the class
        // ("[!a]" matches anything but "a"); a "!" later is literal. A "^" in
        // the pattern is a LITERAL caret (negation in globs is spelled "!"),
        // so a leading "^" must be escaped — but only when it was not already
        // consumed as the negation marker, or "[!a]" would compile to a class
        // matching "^"/"a" instead of its complement.
        let inner = p.slice(i + 1, j);
        let negate = false;
        if (inner.startsWith("!")) {
          negate = true;
          inner = inner.slice(1);
        }
        if (inner.startsWith("^")) inner = "\\" + inner;
        out += "[" + (negate ? "^" : "") + inner + "]";
        i = j;
      }
    } else if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      while (j < p.length && depth > 0) {
        if (p[j] === "{") depth++;
        else if (p[j] === "}") depth--;
        if (depth > 0) j++;
      }
      if (depth !== 0) {
        out += "\\{";
      } else {
        // Split alternatives depth-aware: a plain split(",") cut through
        // NESTED braces, so "{src,lib}/{a,{b,c}}.ts" compiled the truncated
        // fragment "{b" as a literal and matched neither b nor c.
        const body = p.slice(i + 1, j);
        const options: string[] = [];
        let part = "";
        let inner = 0;
        for (const c of body) {
          if (c === "{") inner += 1;
          else if (c === "}") inner -= 1;
          if (c === "," && inner === 0) {
            options.push(part);
            part = "";
          } else {
            part += c;
          }
        }
        options.push(part);
        out += "(?:" + options.map(opt => globToRegExpSource(opt)).join("|") + ")";
        i = j;
      }
    } else if (ch === "/") {
      out += "/";
    } else {
      out += escapeForRegExp(ch);
    }
  }
  return out;
}

export function globToRegExp(pattern: string): RegExp {
  try {
    return new RegExp("^" + globToRegExpSource(pattern) + "$", "i");
  } catch {
    // An inverted or otherwise malformed character range ([z-a]) makes the
    // RegExp constructor throw RangeError; surface it as a clear pattern error
    // instead of a cryptic crash mid-search.
    throw new Error(`Invalid glob pattern "${pattern}": malformed character range or escape.`);
  }
}

/** True when the pattern uses path-aware syntax that should match the full relative path. */
export function isPathGlob(pattern: string): boolean {
  return pattern.includes("/") || pattern.includes("**") || pattern.includes("?") || pattern.includes("{") || pattern.includes("[");
}

/**
 * Anchored basename match for wildcard patterns: segments split on `*` must
 * appear in order, the first as prefix and the last as suffix. This keeps
 * `*.ts` from false-matching `.tsx` / `.tsv` / `*.ts.bak`, which the historic
 * strip-stars-and-substring behaviour did. Patterns without `*` keep the loose
 * contains behaviour ("index" matches "index.ts").
 */
function simpleWildcardMatch(base: string, pattern: string): boolean {
  const text = base.toLowerCase();
  const parts = pattern.toLowerCase().split("*");
  // split() always yields at least one element, so the fallback never fires;
  // naming it once keeps the three uses below from each restating the claim.
  const first = parts[0] ?? "";
  if (parts.length === 1) return text.includes(first);
  if (!text.startsWith(first)) return false;
  let pos = first.length;
  const last = parts.length - 1;
  for (let i = 1; i <= last; i++) {
    const segment = parts[i];
    if (!segment) continue;
    if (i === last) {
      // The final segment must close the name and start at/after the cursor.
      return text.endsWith(segment) && text.length - segment.length >= pos;
    }
    const found = text.indexOf(segment, pos);
    if (found === -1) return false;
    pos = found + segment.length;
  }
  return true;
}

/** Match a relative file path (forward slashes) against a user pattern. */
export function matchFile(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  const pat = pattern.replace(/\\/g, "/");
  if (isPathGlob(pat)) {
    const re = globToRegExp(pat);
    return re.test(normalized) || re.test(base);
  }
  return simpleWildcardMatch(base, pat);
}
