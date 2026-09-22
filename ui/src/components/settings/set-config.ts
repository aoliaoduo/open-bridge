import type { Act } from "../../api";

/**
 * One config write. The shell owns `act` (and the toasts it reports through);
 * every settings surface needs the same "write this key" shape, so it is
 * built once here instead of being re-typed per page.
 */
export function setConfigFor(act: Act): (key: string, value: unknown) => void {
  return (key, value) => { void act({ command: "setConfig", key, value }); };
}
