// Publishing, retries, and what happens when the server dies mid-send.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, startFakeMastodon, client, connectMastodon, inAnHour, waitFor } from "./helpers.js";

test("publishes, and a retry does not move the scheduled time", async () => {
  const app = await startServer(), fake = await startFakeMastodon();
  try {
    const c = client(app.url);
    await c.signUp("retry@example.com");
    const account = await connectMastodon(c, fake, "tok");

    // Happy path.
    const ok = (await c.post("/api/posts", { content: "hello", scheduled_at: inAnHour(), targets: [{ account_id: account }] })).data;
    const sent = (await c.post(`/api/posts/${ok.id}/publish`)).data;
    assert.equal(sent.status, "published");
    assert.equal(sent.targets[0].remote_url, `${fake.url}/@tok/1`);

    // The platform is down: the post goes back in the queue for a retry...
    fake.behavior.status = "fail";
    const p = (await c.post("/api/posts", { content: "will retry", scheduled_at: inAnHour(), targets: [{ account_id: account }] })).data;
    const before = Date.now();
    const failed = (await c.post(`/api/posts/${p.id}/publish`)).data;
    assert.equal(failed.status, "scheduled");
    assert.equal(failed.targets[0].status, "pending");
    assert.equal(failed.targets[0].attempts, 1);
    assert.match(failed.targets[0].error, /Fake instance is down/);
    // ...and the retry time lives in next_attempt_at, about two minutes out,
    assert.ok(failed.next_attempt_at > before + 100_000 && failed.next_attempt_at < Date.now() + 140_000);
    // while scheduled_at is still when it was sent ("Post now" sets it to that moment), not the retry time.
    assert.ok(failed.scheduled_at >= before - 5 && failed.scheduled_at <= Date.now());
    assert.ok(failed.scheduled_at < failed.next_attempt_at);

    // Editing a post clears any pending retry time.
    const when = inAnHour();
    const edited = (await c.put(`/api/posts/${p.id}`, { content: "edited", scheduled_at: when, targets: [{ account_id: account }] })).data;
    assert.equal(edited.scheduled_at, Date.parse(when));
    assert.equal(edited.next_attempt_at, null);

    // Manual retry once the platform is back.
    fake.behavior.status = "ok";
    assert.equal((await c.post(`/api/posts/${p.id}/publish`)).data.status, "published");
  } finally {
    await app.stop(); await fake.close();
  }
});

test("a crash in the middle of sending never posts twice", async () => {
  const fake = await startFakeMastodon();
  let app = await startServer();
  try {
    const c = client(app.url);
    await c.signUp("crash@example.com");
    const slow = await connectMastodon(c, fake, "slow");
    const p = (await c.post("/api/posts", { content: "only once", scheduled_at: inAnHour(), targets: [{ account_id: slow }] })).data;

    // The platform accepts the request but never answers, and the server is killed while waiting.
    fake.behavior.status = "hang";
    c.post(`/api/posts/${p.id}/publish`).catch(() => {});
    await waitFor(() => fake.posts.length === 1, { what: "the send to start" });
    const dataDir = app.dataDir;
    await app.stop("SIGKILL");

    // Restart on the same data. The platform works again.
    fake.behavior.status = "ok";
    app = await startServer({ dataDir, env: { ENCRYPTION_KEY: app.encryptionKey } });
    const c2 = client(app.url);
    await c2.logIn("crash@example.com");
    const after = (await c2.get(`/api/posts/${p.id}`)).data;

    assert.equal(fake.posts.length, 1, "the post was not sent a second time");
    assert.equal(after.status, "failed");
    assert.equal(after.targets[0].status, "failed");
    assert.match(after.targets[0].error, /may or may not have gone out/);
    assert.match(app.log(), /interrupted by a restart/);

    // The user checks, sees it is missing, and retries. Mastodon gets the same idempotency key,
    // so even if the first one had landed, the instance would not create a duplicate.
    const retried = (await c2.post(`/api/posts/${p.id}/publish`)).data;
    assert.equal(retried.status, "published");
    assert.equal(fake.posts.length, 2);
    assert.equal(fake.posts[0].idempotencyKey, fake.posts[1].idempotencyKey);
  } finally {
    await app.stop(); await fake.close();
  }
});

test("SIGTERM waits for the send in progress instead of cutting it off", async () => {
  const fake = await startFakeMastodon();
  const app = await startServer();
  try {
    const c = client(app.url);
    await c.signUp("deploy@example.com");
    const account = await connectMastodon(c, fake, "tok");
    const p = (await c.post("/api/posts", { content: "mid-deploy", scheduled_at: inAnHour(), targets: [{ account_id: account }] })).data;

    fake.behavior.status = "hang";
    c.post(`/api/posts/${p.id}/publish`).catch(() => {});
    await waitFor(() => fake.posts.length === 1, { what: "the send to start" });
    app.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(app.child.exitCode, null, "still running while a send is in flight");
  } finally {
    await app.stop("SIGKILL"); await fake.close();
  }
});
