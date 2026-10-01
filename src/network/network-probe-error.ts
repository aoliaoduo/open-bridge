export type NetworkProbeErrorCode =
  | "INVALID_URL"
  | "INVALID_HOST"
  | "INVALID_PORT"
  | "UNSAFE_TARGET"
  | "DNS_LOOKUP_FAILED"
  | "REQUEST_FAILED"
  | "TIMEOUT"
  | "TOO_MANY_REDIRECTS";

/** Stable network-probe error contract shared by validation and I/O layers. */
export class NetworkProbeError extends Error {
  constructor(
    readonly code: NetworkProbeErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NetworkProbeError";
  }
}
