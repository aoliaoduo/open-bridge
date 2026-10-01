/**
 * Repair a POSIX-style whole-hour TZ only when Node/ICU cannot resolve the
 * current value. Anything carrying DST rules or minute offsets is left alone.
 */
export function normalizeTimezone(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const resolved = (): string => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
  };
  const unresolvable = (zone: string): boolean => zone === "" || zone === "Etc/Unknown";
  if (!unresolvable(resolved())) return undefined;

  const raw = env.TZ;
  if (raw === undefined || raw === "") return undefined;
  const match = /^[A-Za-z]{3,}([+-]?\d{1,2})$/.exec(raw.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  if (!Number.isInteger(hours) || Math.abs(hours) > 14) return undefined;

  const candidate = hours === 0 ? "Etc/GMT" : `Etc/GMT${hours < 0 ? "-" : "+"}${Math.abs(hours)}`;
  const previous = env.TZ;
  env.TZ = candidate;
  if (unresolvable(resolved())) {
    env.TZ = previous;
    return undefined;
  }
  return candidate;
}

/** This machine's UTC offset in the human-facing +08:00 form. */
export function localUtcOffset(now: Date = new Date()): string {
  const pad = (value: number): string => String(Math.abs(value)).padStart(2, "0");
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  return `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
}

/** Human log timestamp in local wall-clock time; machine timestamps stay ISO UTC elsewhere. */
export function localLogStamp(now: Date = new Date()): string {
  const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `.${pad(now.getMilliseconds(), 3)}`;
}
