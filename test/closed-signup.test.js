import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, client } from "./helpers.js";

test("ALLOW_SIGNUP=false still lets the first account be created, then closes", async () => {
  const app = await startServer({ env: { ALLOW_SIGNUP: "false" } });
  try {
    assert.equal((await client(app.url).signUp("owner@example.com")).status, 200);
    const second = await client(app.url).signUp("stranger@example.com");
    assert.equal(second.status, 403);
    assert.equal((await client(app.url).get("/api/me")).data.signupAllowed, false);
  } finally {
    await app.stop();
  }
});
