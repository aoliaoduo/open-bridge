/**
 * Host hooks: extra routes, and "the listener is bound, before the tunnel".
 *
 * The core cannot know about /api and /console (they are the standalone host's
 * surfaces, not the Bridge's), and the CLI needs the listener-ready signal to
 * publish runtime.json early. Setting and reading them are different modules, so
 * the hook state lives here rather than being back-imported out of the listener.
 */
import { type IncomingMessage, type ServerResponse } from "node:http";


/**
 * Extra route handler hook for the app shell: /api and /console live outside
 * the core (they are the standalone host's surfaces, not the Bridge's). The
 * handler returns true when it answered the request.
 */
export type ExtraRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<boolean>;
let extraRouteHandler: ExtraRouteHandler | undefined;
export function setExtraRouteHandler(handler: ExtraRouteHandler | undefined): void {
  extraRouteHandler = handler;
}
let localServerReadyHook: (() => void) | undefined;

/**
 * Called the moment the local listener is bound — before the tunnel, before
 * start() resolves. The CLI uses it to publish runtime.json, which is how
 * `status` / `url` / `stop` find this instance: writing that file only after
 * start() returned left the CLI blind for as long as the tunnel took (seconds),
 * or forever when the tunnel could not come up at all, even though the console
 * was already serving.
 */
export function setLocalServerReadyHook(hook: (() => void) | undefined): void {
  localServerReadyHook = hook;
}

/** The currently installed extra-route handler, if any. */
export function currentExtraRouteHandler(): ExtraRouteHandler | undefined {
  return extraRouteHandler;
}

/**
 * Tell the host the listener is bound. A host hook must never take the listener
 * down with it, so a throw here is swallowed on purpose.
 */
export function notifyLocalServerReady(): void {
  try {
    localServerReadyHook?.();
  } catch {
    /* a broken hook is the host's problem, not the listener's */
  }
}
