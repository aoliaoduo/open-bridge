/** UTF-8 boundary alignment for byte-addressed process/log text pages. */

export interface Utf8TextPage {
  text: string;
  offset: number;
  nextOffset: number;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function utf8Width(byte: number | undefined): number {
  if (byte === undefined) return 0;
  if (byte <= 0x7f) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
}

function safeEnd(data: Buffer, start: number, end: number): number {
  if (end <= start) return end;
  let lead = end - 1;
  let continuations = 0;
  while (lead >= start && isContinuation(data[lead]) && continuations < 3) {
    continuations += 1;
    lead -= 1;
  }
  if (lead < start) return end;
  const width = utf8Width(data[lead]);
  if (width > 1 && width > continuations + 1) return lead;
  return end;
}

/**
 * Decode one byte-addressed page without manufacturing U+FFFD merely because
 * its start/end landed inside a UTF-8 code point.
 *
 * `offset`/`nextOffset` remain absolute byte offsets. A caller that starts in
 * the middle of a character is advanced past its continuation bytes. At the
 * trailing edge we rewind to the character start so the next page re-reads it
 * whole. If an explicit byte cap cannot fit even that one character while more
 * bytes are already available, the caller must raise the cap instead of getting
 * replacement text. A still-growing stream may temporarily end mid-character;
 * in that case the page stays empty and leaves the cursor in place until the
 * remaining bytes arrive.
 */
export function decodeUtf8Page(
  data: Buffer,
  offset: number,
  endOffset: number,
  totalBytes: number,
  mayGrow = false,
): Utf8TextPage {
  let start = 0;
  if (offset > 0) {
    while (start < data.length && isContinuation(data[start]) && start < 3) start += 1;
  }

  let end = data.length;
  if (endOffset < totalBytes || mayGrow) {
    const aligned = safeEnd(data, start, end);
    if (aligned === start && end > start) {
      if (endOffset < totalBytes) {
        throw new RangeError("max_bytes is too small to return the next UTF-8 character; use at least 4 bytes.");
      }
      // The stream currently ends inside the character. Do not consume those
      // bytes: the next read can return the character whole after it grows.
      end = start;
    } else {
      end = aligned;
    }
  }

  return {
    text: data.subarray(start, end).toString("utf8"),
    offset: offset + start,
    nextOffset: offset + end,
  };
}
