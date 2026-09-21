import assert from "node:assert/strict";
import test from "node:test";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { markTransportInitialized } from "../src/bridge/session-resume.js";

test("markTransportInitialized stamps the SDK inner session so the public getter sees it", () => {
  const id = "ab".repeat(16);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
  });
  assert.equal(transport.sessionId, undefined, "a fresh transport has not initialized");
  markTransportInitialized(transport, id);
  assert.equal(transport.sessionId, id, "the issued id is visible without a handshake");
});
