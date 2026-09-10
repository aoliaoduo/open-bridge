/**
 * Visible-terminal mirror — standalone host edition.
 *
 * Inside an editor host, showVisibleTerminal opens a terminal pane that
 * tail-follows the command's tee capture file. The standalone host has no
 * terminal pane, so this is a no-op: output is still fully captured by the
 * tee capture file and readable via read_process_output / the console.
 */
export function showVisibleTerminal(_id: string, _cwd: string): void {
  void _id;
  void _cwd;
  // No terminal surface outside an editor host.
}
