import * as fs from "node:fs/promises";

export interface PersistResult {
  via: "editor" | "disk";
}

export interface PersistOptions {
  /**
   * Editor-host only: when false, writing to a file open in an editor with
   * unsaved changes throws. The standalone host has no editor buffers, so the
   * flag is accepted for API compatibility and has no effect here.
   */
  allowDirty?: boolean;
}

/** Thrown when a write targets an editor buffer that has unsaved manual changes. */
export class DirtyBufferError extends Error {
  constructor(public readonly file: string) {
    super(
      `Refusing to write "${file}": it is open in an editor with unsaved changes. ` +
      "Save or discard those changes first, or re-run with allow_dirty=true.",
    );
    this.name = "DirtyBufferError";
  }
}

/**
 * Dirty-buffer guard kept for interface parity with the editor host. The
 * standalone host owns the whole filesystem view, so it is always writable.
 */
export async function ensureWritableBufferTarget(_fullPath: string, _allowDirty: boolean): Promise<void> {
  void _fullPath;
  void _allowDirty;
  // No editor buffers exist outside an editor host.
}

/**
 * Persist text content for a file path.
 *
 * Inside an editor host the write goes through the editor API (undo stack,
 * dirty-buffer guard). The standalone host writes directly to disk — there is
 * no in-memory buffer that could diverge from the file.
 */
export async function persistText(
  fullPath: string,
  content: string,
  _opts: PersistOptions = {},
): Promise<PersistResult> {
  // Intentionally ignored outside an editor host; retain the parameter for API parity.
  void _opts;
  await fs.writeFile(fullPath, content, "utf8");
  return { via: "disk" };
}
