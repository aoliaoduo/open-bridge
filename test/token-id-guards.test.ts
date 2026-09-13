import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteToken, revokeToken, rotateToken } from "../src/http/auth.js";

// Empty-id guards fire before any store access, so these need no host setup:
// they prove a blank id can never prefix-match its way onto a real token
// ("" is a prefix of every id, and `find` would take the first record).

test("rotateToken refuses an empty id instead of rotating the first token", async () => {
  await assert.rejects(rotateToken(""), /Provide a token id/);
  await assert.rejects(rotateToken("   "), /Provide a token id/);
});

test("revokeToken and deleteToken refuse an empty id", async () => {
  await assert.rejects(revokeToken(""), /Provide a token id/);
  await assert.rejects(deleteToken(""), /Provide a token id/);
});
