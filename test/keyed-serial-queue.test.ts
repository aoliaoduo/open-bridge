import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyedSerialQueue } from "../src/bridge/runtime/keyed-serial-queue.js";

test("same-key work is FIFO and the settled key is released", async () => {
  const queue = new KeyedSerialQueue();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const order: string[] = [];

  const first = queue.run("svc:web", async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
    return 1;
  });
  const second = queue.run("svc:web", async () => {
    order.push("second");
    return 2;
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  assert.equal(queue.size, 1);

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  await Promise.resolve();

  assert.deepEqual(order, ["first:start", "first:end", "second"]);
  assert.equal(queue.size, 0, "a completed key must not remain retained forever");
});

test("a rejected operation also releases its key", async () => {
  const queue = new KeyedSerialQueue();
  await assert.rejects(
    queue.run("svc:broken", async () => { throw new Error("boom"); }),
    /boom/,
  );
  await Promise.resolve();
  assert.equal(queue.size, 0);
});
