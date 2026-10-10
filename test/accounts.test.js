// Sign-up, login, rate limiting, and the wall between users.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, startFakeMastodon, client, connectMastodon, inAnHour } from "./helpers.js";

let app, fake;
before(async () => { app = await startServer(); fake = await startFakeMastodon(); });
after(async () => { await app.stop(); await fake.close(); });

test("sign up, log out, log back in", async () => {
  const c = client(app.url);
  assert.equal((await c.get("/api/accounts")).status, 401, "API is closed before sign-in");
  const up = await c.signUp("first@example.com");
  assert.equal(up.status, 200);
  assert.equal(up.data.user.email, "first@example.com");
  assert.equal(up.data.user.password_hash, undefined, "the hash never leaves the server");
  assert.equal((await c.get("/api/accounts")).status, 200);

  await c.post("/api/logout");
  assert.equal((await c.get("/api/accounts")).status, 401, "old cookie stops working after logout");
  assert.equal((await c.logIn("FIRST@example.com")).status, 200, "email is not case sensitive");
});

test("rejects bad sign-ups", async () => {
  const c = client(app.url);
  assert.match((await c.signUp("not-an-email")).data.error, /valid email/);
  assert.match((await c.signUp("short@example.com", "1234567")).data.error, /at least 8/);
  assert.match((await c.signUp("first@example.com")).data.error, /already exists/);
});

test("users cannot see or touch each other's accounts and posts", async () => {
  const alice = client(app.url), bob = client(app.url);
  await alice.signUp("alice@example.com");
  await bob.signUp("bob@example.com");
  const aliceAccount = await connectMastodon(alice, fake, "alice-token");
  const bobAccount = await connectMastodon(bob, fake, "bob-token");

  const post = (await alice.post("/api/posts", {
    content: "Alice's secret launch", scheduled_at: inAnHour(), targets: [{ account_id: aliceAccount }],
  })).data;
  assert.equal(post.status, "scheduled");

  // Bob sees only his own things.
  assert.deepEqual((await bob.get("/api/accounts")).data.map((a) => a.id), [bobAccount]);
  assert.deepEqual((await bob.get("/api/posts")).data, []);
  assert.equal((await bob.get(`/api/posts/${post.id}`)).status, 404);

  // Bob cannot change, publish or delete Alice's post, or disconnect her account.
  const edit = await bob.put(`/api/posts/${post.id}`, { content: "hacked", scheduled_at: inAnHour(), targets: [{ account_id: bobAccount }] });
  assert.match(edit.data.error, /not found/i);
  assert.match((await bob.post(`/api/posts/${post.id}/publish`)).data.error, /not found/i);
  assert.equal((await bob.del(`/api/posts/${post.id}`)).status, 404);
  assert.equal((await bob.del(`/api/accounts/${aliceAccount}`)).status, 404);

  // Bob cannot post through Alice's account.
  const hijack = await bob.post("/api/posts", { content: "as alice", scheduled_at: inAnHour(), targets: [{ account_id: aliceAccount }] });
  assert.match(hijack.data.error, /Unknown account/);

  // Alice's post is untouched, and nothing was sent.
  assert.equal((await alice.get(`/api/posts/${post.id}`)).data.content, "Alice's secret launch");
  assert.equal(fake.posts.length, 0);
});

test("the same social account can be connected by two users", async () => {
  const carol = client(app.url), dave = client(app.url);
  await carol.signUp("carol@example.com");
  await dave.signUp("dave@example.com");
  const a = await connectMastodon(carol, fake, "shared-token");
  const b = await connectMastodon(dave, fake, "shared-token");
  assert.notEqual(a, b);
});

test("each Claude connector key only reaches its owner's data", async () => {
  const erin = client(app.url), frank = client(app.url);
  await erin.signUp("erin@example.com");
  await frank.signUp("frank@example.com");
  await connectMastodon(erin, fake, "erin-token");
  const erinKey = (await erin.get("/api/settings")).data.mcp.key;
  const frankKey = (await frank.get("/api/settings")).data.mcp.key;
  assert.notEqual(erinKey, frankKey);

  const listAccounts = async (key) => {
    const res = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_accounts", arguments: {} } }),
    });
    const text = await res.text();
    const payload = JSON.parse(text.includes("data: ") ? text.split("data: ")[1] : text);
    return { status: res.status, accounts: payload.result ? JSON.parse(payload.result.content[0].text) : null };
  };
  assert.deepEqual((await listAccounts(erinKey)).accounts.map((a) => a.handle), [`@erin@${new URL(fake.url).host}`]);
  assert.deepEqual((await listAccounts(frankKey)).accounts, []);
  assert.equal((await listAccounts("ss_wrong")).status, 401);

  // A rotated key replaces the old one.
  const { key: newKey } = (await erin.post("/api/settings/rotate-mcp-key")).data;
  assert.equal((await listAccounts(erinKey)).status, 401);
  assert.equal((await listAccounts(newKey)).accounts.length, 1);
});

test("tokens are encrypted in the database file", async () => {
  const c = client(app.url);
  await c.signUp("grace@example.com");
  await connectMastodon(c, fake, "super-secret-token-9f3a");
  await c.post("/api/logout"); // any write, to be sure the WAL holds the rows
  const files = fs.readdirSync(app.dataDir).filter((f) => f.startsWith("socialsuite.db"));
  const raw = Buffer.concat(files.map((f) => fs.readFileSync(path.join(app.dataDir, f)))).toString("latin1");
  assert.ok(raw.includes("enc:v1:"), "encrypted values are present");
  assert.ok(!raw.includes("super-secret-token-9f3a"), "the token does not appear in plain text");
  assert.ok(!/ss_[A-Za-z0-9_-]{32}/.test(raw), "connector keys do not appear in plain text");
  assert.ok(!raw.includes("correct horse battery"), "passwords are hashed");
});

test("failed logins are rate limited", async () => {
  const c = client(app.url);
  await c.signUp("heidi@example.com");
  await c.post("/api/logout");
  for (let i = 0; i < 5; i++) {
    const r = await c.logIn("heidi@example.com", "wrong-password");
    assert.equal(r.status, 401);
    assert.equal(r.data.error, "Wrong email or password");
  }
  const blocked = await c.logIn("heidi@example.com", "wrong-password");
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal((await c.logIn("heidi@example.com")).status, 429, "even the right password waits out the lock");
  // Unknown emails get the same answer as wrong passwords, so the form does not reveal who has an account.
  assert.equal((await c.logIn("nobody@example.com", "whatever-pass")).data.error, "Wrong email or password");
});
