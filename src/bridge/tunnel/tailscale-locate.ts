import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { findOnPath } from "../../shell/which.js";

/**
 * The machine's stable ts.net hostname, e.g. "my-machine.tail1234.ts.net".
 *
 * Asked of the CLI (`tailscale status --json` → Self.DNSName) rather than
 * configured by hand: the name is assigned by the tailnet, a typo in a manual
 * field yields a tunnel that quietly serves the wrong host, and the CLI is the
 * one source that is already installed (funnel cannot run without it).
 * Trailing dot stripped ("...ts.net." is DNS-speak, not part of the URL).
 */
export function probeTailscaleDomain(
  exe: string,
  timeoutMs = 5_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, ["status", "--json"], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(new Error(`tailscale status failed: ${error.message}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          Self?: { DNSName?: string; Online?: boolean };
          CurrentTailnet?: { Name?: string };
        };
        const dns = parsed.Self?.DNSName?.replace(/\.$/, "").toLowerCase() ?? "";
        if (!dns) {
          reject(new Error("tailscale reported no DNS name for this machine (is it logged in to a tailnet?)."));
          return;
        }
        resolve(dns);
      } catch {
        reject(new Error("tailscale status --json produced unparseable output."));
      }
    });
  });
}

/** The MSI's default install location on Windows. */
const MSI_DEFAULT = "C:\\Program Files\\Tailscale\\tailscale.exe";

/**
 * Resolve the funnel CLI: an explicit path wins, else PATH, else the MSI's
 * default install dir. The MSI does NOT put tailscale on PATH by default, so
 * the fixed location is the common case on Windows, not a fallback curiosity.
 */
export function resolveTailscaleExecutable(configured: string, env = process.env, platform = process.platform): string {
  const explicit = configured.trim();
  if (explicit) return explicit;
  const onPath = findOnPath("tailscale", { platform, env });
  if (onPath) return onPath;
  if (platform === "win32" && existsSync(MSI_DEFAULT)) return MSI_DEFAULT;
  return "tailscale";
}
