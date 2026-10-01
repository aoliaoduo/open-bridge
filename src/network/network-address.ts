import { isIP } from "node:net";
import { NetworkProbeError } from "./network-probe-error.js";

/**
 * The network locations a probe may reach. "any" deliberately disables address
 * class filtering; callers that want LAN/metadata protection must use a narrower scope.
 */
export type ProbeNetworkScope = "loopback" | "public" | "loopback-and-public" | "any";

export const DEFAULT_PROBE_NETWORK_SCOPE: ProbeNetworkScope = "loopback-and-public";

export type NetworkAddressKind =
  | "loopback"
  | "private"
  | "link-local"
  | "unspecified"
  | "multicast"
  | "reserved"
  | "public";

/** Classify a literal IP address without DNS or network I/O. */
export function classifyIpAddress(input: string): NetworkAddressKind {
  const address = stripIpv6Brackets(input);
  const family = isIP(address);
  if (family === 4) return classifyIpv4(address);
  if (family === 6) return classifyIpv6(address);
  throw new NetworkProbeError("INVALID_HOST", `Invalid IP address: ${input}`);
}

/** Return whether an address category can be reached under a selected policy. */
export function isAddressAllowed(
  kind: NetworkAddressKind,
  scope: ProbeNetworkScope = DEFAULT_PROBE_NETWORK_SCOPE,
): boolean {
  switch (scope) {
    case "loopback":
      return kind === "loopback";
    case "public":
      return kind === "public";
    case "loopback-and-public":
      return kind === "loopback" || kind === "public";
    case "any":
      return true;
  }
}

export function stripIpv6Brackets(input: string): string {
  if (input.startsWith("[") && input.endsWith("]")) return input.slice(1, -1);
  return input;
}

function classifyIpv4(address: string): NetworkAddressKind {
  const octets = address.split(".").map(Number);
  const [a, b] = octets;
  if (a === undefined || b === undefined) return "reserved";
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 169 && b === 254) return "link-local";
  if (a === 0) return "unspecified";
  if (a === 100 && b >= 64 && b <= 127) return "reserved";
  if (a === 192 && b === 0) return "reserved";
  if (a === 192 && b === 88) return "reserved";
  if (a === 192 && b === 31 && octets[2] === 196) return "reserved";
  if (a === 192 && b === 52 && octets[2] === 193) return "reserved";
  if (a === 192 && b === 175 && octets[2] === 48) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if ((a === 198 && b === 51 && octets[2] === 100) || (a === 203 && b === 0 && octets[2] === 113)) return "reserved";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return "public";
}

function classifyIpv6(address: string): NetworkAddressKind {
  const bytes = ipv6Bytes(address);
  if (!bytes) throw new NetworkProbeError("INVALID_HOST", `Invalid IP address: ${address}`);
  if (bytes.every(byte => byte === 0)) return "unspecified";
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1) return "loopback";

  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return classifyIpv4([...bytes.slice(12)].join("."));
  }
  if (bytes.slice(0, 12).every(byte => byte === 0)) {
    return classifyIpv4([...bytes.slice(12)].join("."));
  }

  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 === undefined || b1 === undefined) {
    throw new NetworkProbeError("INVALID_HOST", `Invalid IP address: ${address}`);
  }
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return "link-local";
  if (b0 === 0xfe && (b1 & 0xc0) === 0x00) return "reserved";
  if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return "reserved";
  if ((b0 & 0xfe) === 0xfc) return "private";
  if (bytes[0] === 0xff) return "multicast";

  if (isPrefix(bytes, [0x00])) return "reserved";
  if (isPrefix(bytes, [0x00, 0x64, 0xff, 0x9b])) return "reserved";
  if (isPrefix(bytes, [0x01, 0x00])) return "reserved";
  if (isPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8])) return "reserved";
  if (isPrefix(bytes, [0x20, 0x02])) return "reserved";
  if (isPrefix(bytes, [0x3f, 0xff])) return "reserved";
  if (isPrefix(bytes, [0x5f, 0x00])) return "reserved";
  return "public";
}

function ipv6Bytes(address: string): number[] | undefined {
  const value = address.toLowerCase();
  if (value.includes("%")) return undefined;
  const doubleColon = value.indexOf("::");
  if (doubleColon !== -1 && doubleColon !== value.lastIndexOf("::")) return undefined;

  const parseSide = (side: string): number[] | undefined => {
    if (!side) return [];
    const parts = side.split(":");
    const output: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === undefined) return undefined;
      if (part.includes(".")) {
        if (index !== parts.length - 1) return undefined;
        if (isIP(part) !== 4) return undefined;
        const octets = part.split(".").map(Number);
        output.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
        output.push(Number.parseInt(part, 16));
      }
    }
    return output;
  };

  const left = parseSide(doubleColon === -1 ? value : value.slice(0, doubleColon));
  const right = parseSide(doubleColon === -1 ? "" : value.slice(doubleColon + 2));
  if (!left || !right) return undefined;
  const words = doubleColon === -1
    ? left
    : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
  if (words.length !== 8) return undefined;
  return words.flatMap(word => [(word >> 8) & 0xff, word & 0xff]);
}

function isPrefix(bytes: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}
