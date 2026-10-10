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

test("the privacy policy is public and shows the operator's contact details", async () => {
  const app = await startServer({ env: { OPERATOR_NAME: "Ada <Lovelace>", CONTACT_EMAIL: "privacy@example.com" } });
  try {
    const res = await fetch(app.url + "/privacy");
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.ok(html.includes('href="mailto:privacy@example.com"'));
    assert.ok(html.includes("Ada &#60;Lovelace&#62;"), "values from .env are escaped");
    assert.ok(!html.includes("{{"), "no placeholder left unfilled");
  } finally {
    await app.stop();
  }
});
