let shutdownHook: (() => Promise<void>) | undefined;

/** The CLI installs the real shutdown path (lifecycle stop + process exit). */
export function setShutdownHook(hook: () => Promise<void>): void {
  shutdownHook = hook;
}

export async function gracefulShutdown(): Promise<void> {
  if (shutdownHook) await shutdownHook();
}
