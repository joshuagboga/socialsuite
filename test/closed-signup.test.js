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

test("CLIENT_IP_HEADER makes rate limits follow the address the host's proxy reports", async () => {
  const app = await startServer({ env: { CLIENT_IP_HEADER: "Fly-Client-IP" } });
  try {
    const visitorA = { "Fly-Client-IP": "203.0.113.5" }, visitorB = { "Fly-Client-IP": "203.0.113.9" };
    const c = client(app.url);
    for (let i = 0; i < 5; i++) await c.post("/api/login", { email: "x@example.com", password: "wrong-pass" }, visitorA);
    assert.equal((await c.post("/api/login", { email: "x@example.com", password: "wrong-pass" }, visitorA)).status, 429);
    assert.equal((await c.post("/api/login", { email: "x@example.com", password: "wrong-pass" }, visitorB)).status, 401, "another visitor is not locked out");
  } finally {
    await app.stop();
  }
});
