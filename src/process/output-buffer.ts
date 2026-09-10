/**
 * Bounded, byte-addressable retention for a process output stream.
 *
 * Offsets always refer to the stream from byte zero. Output is kept as Buffers
 * so callers can decide when and how UTF-8 should be decoded.
 */

export interface ProcessOutputBufferState {
  /** Maximum number of stream bytes retained for future reads. */
  readonly capacityBytes: number;
  /** Number of bytes emitted by the process since this buffer was created. */
  readonly totalBytes: number;
  /** Absolute offset of the first byte that can still be read. */
  readonly bufferStartOffset: number;
  /** Number of bytes currently available to read. */
  readonly availableBytes: number;
  /** Number of leading stream bytes no longer retained. */
  readonly droppedBytes: number;
}

export interface ProcessOutputRead extends ProcessOutputBufferState {
  /** A copy of the requested raw output bytes. */
  readonly data: Buffer;
  /** Absolute stream offset of the first returned byte. */
  readonly offset: number;
  /** Absolute stream offset immediately after the returned bytes. */
  readonly endOffset: number;
  /** True when the result omits bytes from either side of the full stream. */
  readonly truncated: boolean;
}

interface BufferedChunk {
  /** Absolute stream offset of byte zero in data. */
  readonly offset: number;
  readonly data: Buffer;
  /** Relative offset of the first retained byte in data. */
  start: number;
}

/**
 * Stores a bounded trailing window of a process's raw output.
 *
 * Append operations retain Buffer chunks instead of concatenating the current
 * window. A contiguous Buffer is allocated only when a caller reads output.
 */
export class ProcessOutputBuffer {
  private chunks: Array<BufferedChunk | undefined> = [];
  private head = 0;
  private streamBytes = 0;
  private startOffset = 0;

  public constructor(private readonly capacity: number) {
    assertNonNegativeSafeInteger(capacity, "capacityBytes");
  }

  /** Add raw output emitted by the process and return the resulting state. */
  public append(data: Buffer): ProcessOutputBufferState {
    if (!Buffer.isBuffer(data)) {
      throw new TypeError("Process output must be a Buffer.");
    }

    if (data.byteLength === 0) return this.state();
    if (this.streamBytes > Number.MAX_SAFE_INTEGER - data.byteLength) {
      throw new RangeError("Process output exceeded the largest safe byte offset.");
    }

    const offset = this.streamBytes;
    this.streamBytes += data.byteLength;

    if (this.capacity > 0) {
      if (data.byteLength > this.capacity) {
        // Do not let one oversized process chunk keep its discarded prefix alive.
        const retainedStart = data.byteLength - this.capacity;
        this.chunks.push({
          offset: offset + retainedStart,
          data: Buffer.from(data.subarray(retainedStart)),
          start: 0,
        });
      } else {
        this.chunks.push({ offset, data, start: 0 });
      }
    }

    this.discardBefore(Math.max(0, this.streamBytes - this.capacity));
    return this.state();
  }

  /** Return byte-based metadata without copying retained output. */
  public state(): ProcessOutputBufferState {
    return {
      capacityBytes: this.capacity,
      totalBytes: this.streamBytes,
      bufferStartOffset: this.startOffset,
      availableBytes: this.streamBytes - this.startOffset,
      droppedBytes: this.startOffset,
    };
  }

  /**
   * Read at most maxBytes starting at an absolute stream offset.
   *
   * Requests for bytes that have been dropped are rejected instead of being
   * silently translated to the start of the retained window.
   */
  public read(offset: number, maxBytes: number): ProcessOutputRead {
    assertNonNegativeSafeInteger(offset, "offset");
    assertNonNegativeSafeInteger(maxBytes, "maxBytes");

    if (offset < this.startOffset) {
      throw new RangeError(
        `Output at byte offset ${offset} is no longer available; the buffer starts at ${this.startOffset}.`,
      );
    }
    if (offset > this.streamBytes) {
      throw new RangeError(
        `Output at byte offset ${offset} is beyond the end of the stream at ${this.streamBytes}.`,
      );
    }

    const endOffset = offset + Math.min(maxBytes, this.streamBytes - offset);
    const data = this.copyRange(offset, endOffset);
    return {
      ...this.state(),
      data,
      offset,
      endOffset,
      truncated: offset > 0 || endOffset < this.streamBytes,
    };
  }

  /**
   * Return up to maxBytes from the end of the stream.
   *
   * `truncated` indicates that some stream bytes precede or follow the result;
   * `droppedBytes` identifies output that is no longer recoverable.
   */
  public tail(maxBytes: number): ProcessOutputRead {
    assertNonNegativeSafeInteger(maxBytes, "maxBytes");
    return this.read(Math.max(this.startOffset, this.streamBytes - maxBytes), maxBytes);
  }

  private discardBefore(offset: number): void {
    this.startOffset = offset;

    while (this.head < this.chunks.length) {
      const chunk = this.chunks[this.head];
      if (!chunk) {
        this.head += 1;
        continue;
      }
      const chunkEnd = chunk.offset + chunk.data.byteLength;

      if (chunkEnd <= offset) {
        // Drop the Buffer reference immediately; head avoids an O(n) shift.
        this.chunks[this.head] = undefined;
        this.head += 1;
        continue;
      }

      if (chunk.offset < offset) {
        chunk.start = offset - chunk.offset;
      }
      break;
    }

    // Avoid repeated Array.shift() while eventually releasing discarded chunks.
    if (this.head > 32 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  private copyRange(offset: number, endOffset: number): Buffer {
    const length = endOffset - offset;
    if (length === 0) return Buffer.alloc(0);

    const pieces: Buffer[] = [];
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      if (!chunk) continue;
      const chunkStart = chunk.offset + chunk.start;
      const chunkEnd = chunk.offset + chunk.data.byteLength;

      if (chunkEnd <= offset) continue;
      if (chunkStart >= endOffset) break;

      const start = Math.max(chunk.start, offset - chunk.offset);
      const end = Math.min(chunk.data.byteLength, endOffset - chunk.offset);
      if (start < end) pieces.push(chunk.data.subarray(start, end));
    }

    return Buffer.concat(pieces, length);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}
