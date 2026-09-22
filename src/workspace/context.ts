import * as path from "node:path";
import { host } from "../host/host.js";
import { resolveFromWorkspace, resolveSecurePath } from "./workspace-path.js";

/**
 * Keeps the active project root as the stable anchor.
 * Other locations remain reachable only when callers provide an absolute path.
 */
export class WorkspaceContext {
  root(): string {
    return host().projectRoot();
  }

  resolve(input = "."): string {
    return resolveFromWorkspace(this.root(), input);
  }

  /** Resolve and enforce configured access policy, including symlink checks. */
  async resolveSecure(input = ".", allowMissing = false): Promise<string> {
    return resolveSecurePath(this.root(), input, {
      unrestricted: this.unrestricted(),
      allowedRoots: this.allowedRoots(),
      allowMissing,
    });
  }

  unrestricted(): boolean {
    return host().config.get<boolean>("unrestrictedFileAccess", true);
  }

  allowedRoots(): string[] {
    if (this.unrestricted()) return [path.parse(process.cwd()).root];
    const configured = host().config.get<string[]>("allowedDirectories", []);
    const roots = configured.filter(value => typeof value === "string" && value.trim()).map(value => path.resolve(value));
    // The active workspace is always an allowed root. Explicit directories add
    // access for absolute paths but must never displace the workspace anchor.
    return [...new Set([path.resolve(this.root()), ...roots])];
  }
}
