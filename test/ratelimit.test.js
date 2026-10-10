import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter } from "../src/ratelimit.js";

test("allows up to max, then blocks until the window ends", async () => {
  const l = createLimiter({ windowMs: 80, max: 3 });
  for (let i = 0; i < 3; i++) { assert.ok(l.check("ip").allowed); l.hit("ip"); }
  const blocked = l.check("ip");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);
  assert.ok(l.check("someone-else").allowed, "keys are counted separately");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(l.check("ip").allowed, "allowed again after the window");
});

test("reset clears a key", () => {
  const l = createLimiter({ windowMs: 60_000, max: 1 });
  l.hit("k");
  assert.equal(l.check("k").allowed, false);
  l.reset("k");
  assert.ok(l.check("k").allowed);
});
