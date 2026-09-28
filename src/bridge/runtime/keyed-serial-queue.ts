/**
 * Serialize asynchronous work per key without retaining completed keys.
 *
 * Different keys run independently. Calls sharing a key form a FIFO chain, and
 * the final settled tail removes itself only if no newer call has replaced it.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  get size(): number {
    return this.tails.size;
  }
}
