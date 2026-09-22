import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fingerprints only: never keep a retired credential in a regression fixture.
const retiredCredentialHashes = new Set([
  "ec0b3bd3d7ff7304d55473e621accfaac17afd296bd9943384948b7160473a74",
]);
const fixtureTokens = new Set(["a".repeat(32), "b".repeat(32), "0".repeat(32), "0123456789abcdef".repeat(2)]);

/** Findings contain positions and rule names, never source text or credentials. */
export function credentialFindings(file, source) {
  const findings = [];
  const seen = new Set();
  function add(index, rule) {
    const line = source.slice(0, index).split("\n").length;
    const key = `${line}:${rule}`;
    if (!seen.has(key)) { seen.add(key); findings.push({ file, line, rule }); }
  }
  // A bare copy (e.g. an assertion literal) must fail as well as a full URL.
  for (const match of source.matchAll(/\b[a-f0-9]{16,64}\b/gi)) {
    const digest = createHash("sha256").update(match[0]).digest("hex");
    if (retiredCredentialHashes.has(digest)) add(match.index, "retired-credential");
  }
  const routes = /(?:https?:\/\/[^\s`"<>'\\]+\/mcp\/([a-f0-9]{16,64})\b|\brouteToken\s*:\s*["']([a-f0-9]{16,64})["'])/gi;
  for (const match of source.matchAll(routes)) {
    if (!fixtureTokens.has(match[1] ?? match[2])) add(match.index, "literal-route-credential");
  }
  for (const match of source.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g)) add(match.index, "private-key");
  return findings;
}

export function scanRepository(root = process.cwd()) {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean);
  const findings = [];
  for (const file of new Set(files)) {
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    if (/(?:^|\/)(?:\.env(?:\..+)?|secrets\.json|credentials\.json|id_rsa|id_ed25519|\.netrc)$/.test(file)
        && !/\.(?:example|sample|template)$/.test(file)) findings.push({ file, line: 1, rule: "private-file" });
    const bytes = readFileSync(full);
    if (!bytes.includes(0)) findings.push(...credentialFindings(file, bytes.toString("utf8")));
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scanRepository();
  if (findings.length) {
    console.error("Credential hygiene failed (values intentionally omitted):");
    for (const { file, line, rule } of findings) console.error(`${file}:${line} ${rule}`);
    process.exitCode = 1;
  } else console.log("Credential hygiene passed.");
}
