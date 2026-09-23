/**
 * Whether a long-lived child process gets a console of its own.
 *
 * Measured on Windows 10 with the Win32 `AttachConsole` + `GetConsoleProcessList`
 * pair, spawning a child exactly the way this Bridge spawns ngrok:
 *
 *   {windowsHide: false} -> the child is attached to OUR console; the console's
 *                           process list held parent and child together.
 *   {windowsHide: true}  -> CREATE_NO_WINDOW hands it a console of its own; our
 *                           list did not contain it.
 *
 * Closing a console window terminates the processes attached to that console and
 * only those. A hidden ngrok therefore outlived the window that started it, kept
 * the domain reserved, and the next start answered ERR_NGROK_334 and fell back
 * to local-only — with nothing on screen to explain why. The same held for the
 * services and persistent shells the Bridge spawns: orphaned by a window close,
 * still holding ports nobody could see.
 *
 * Hiding stays right when there is no console of ours to attach to (stdout and
 * stderr both redirected, or a GUI parent with no console of its own):
 * without CREATE_NO_WINDOW the console subsystem would flash a window up.
 */
export function windowsHideForChild(hasConsole: boolean = processHasConsole()): boolean {
  return !hasConsole;
}

/**
 * "Do we have a console?" — stdout OR stderr being a TTY is the honest test
 * available from Node (`> file` redirects stdout only). Both redirected reads as
 * "no console", which hides the child: the safe direction, since a wrong guess
 * there only costs a flashing window.
 */
export function processHasConsole(): boolean {
  return Boolean(process.stdout.isTTY || process.stderr.isTTY);
}
