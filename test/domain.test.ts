import test from "node:test";
import assert from "node:assert/strict";
import { CommandStore } from "../src/domain.js";
test("command creation deduplicates and expiration prevents publication", () => {
  const store = new CommandStore();
  const one = store.create("device", "REQUEST_STATUS", {}, 10, "key");
  const two = store.create("device", "REQUEST_STATUS", {}, 10, "key");
  assert.equal(one.id, two.id);
  assert.equal(store.publish(one.id, 11)?.status, "EXPIRED");
});
