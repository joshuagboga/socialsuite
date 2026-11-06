// X: per-platform variants, X Premium's longer limit, counting characters the way X does, and threads.
// A fake X API answers the real OAuth and posting code (X_API_URL points the server at it).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  startServer, startFakeMastodon, startFakeX, client, connectMastodon, connectX, inAnHour, mcpCall, mcpData,
} from "./helpers.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let app, fakeX, fakeMastodon;
before(async () => {
  fakeX = await startFakeX();
  fakeMastodon = await startFakeMastodon();
  app = await startServer({ env: { X_CLIENT_ID: "test-client", X_API_URL: fakeX.url } });
});
after(async () => { await app.stop(); await fakeX.close(); await fakeMastodon.close(); });

// A signed-in user with an X account, and their connector key.
async function xUser(email) {
  const c = client(app.url);
  await c.signUp(email);
  const x = await connectX(c);
  const key = (await c.get("/api/settings")).data.mcp.key;
  return { c, x, key, mcp: (name, args) => mcpCall(app.url, key, name, args) };
}

test("variants only need the platforms that differ", async () => {
  const { c, x, mcp } = await xUser("variants@example.com");
  const masto = await connectMastodon(c, fakeMastodon, "variants");
  const result = await mcp("schedule_post", {
    content: "The full announcement, with all the details for Mastodon.",
    account_ids: [x, masto], variants: { x: "Short version for X" }, scheduled_at: inAnHour(),
  });
  assert.equal(result.isError, undefined, result.content[0].text);
  const targets = Object.fromEntries(mcpData(result).post.targets.map((t) => [t.platform, t.content_override]));
  assert.deepEqual(targets, { x: "Short version for X", mastodon: null });

  // update_post takes a partial set too.
  const id = mcpData(result).post.id;
  const updated = await mcp("update_post", { post_id: id, variants: { mastodon: "Mastodon gets its own now" } });
  assert.equal(updated.isError, undefined, updated.content[0].text);
  const after = Object.fromEntries(mcpData(updated).post.targets.map((t) => [t.platform, t.content_override]));
  assert.deepEqual(after, { x: "Short version for X", mastodon: "Mastodon gets its own now" });
});

test("X Premium raises the limit from 280 to 25,000 characters", async () => {
  const { c, x, mcp } = await xUser("premium@example.com");
  const long = "a".repeat(500);

  assert.equal(mcpData(await mcp("list_accounts"))[0].char_limit, 280);
  const refused = await mcp("schedule_post", { content: long, account_ids: [x], scheduled_at: inAnHour() });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /X \(Twitter\) @xtester: 500\/280 characters/);

  const on = await c.patch(`/api/accounts/${x}`, { premium: true });
  assert.equal(on.status, 200);
  assert.equal(on.data.premium, true);
  assert.equal((await c.get("/api/accounts")).data[0].premium, true);
  const listed = mcpData(await mcp("list_accounts"))[0];
  assert.equal(listed.char_limit, 25000);
  assert.equal(listed.x_premium, true);

  const accepted = await mcp("schedule_post", { content: long, account_ids: [x], scheduled_at: inAnHour() });
  assert.equal(accepted.isError, undefined, accepted.content[0].text);
  const tooLongEvenForPremium = await mcp("schedule_post", { content: "a".repeat(25001), account_ids: [x], scheduled_at: inAnHour() });
  assert.match(tooLongEvenForPremium.content[0].text, /25001\/25000/);

  // Turning it off again brings back the 280 limit.
  assert.equal((await c.patch(`/api/accounts/${x}`, { premium: false })).data.premium, false);
  assert.equal(mcpData(await mcp("list_accounts"))[0].char_limit, 280);
});

test("only the owner can set Premium, and only on X accounts", async () => {
  const { c, x } = await xUser("premium-owner@example.com");
  const masto = await connectMastodon(c, fakeMastodon, "premiumowner");
  const r = await c.patch(`/api/accounts/${masto}`, { premium: true });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Only X accounts/);
  assert.match((await c.patch(`/api/accounts/${x}`, { premium: "yes" })).data.error, /premium: true/);

  const other = client(app.url);
  await other.signUp("premium-stranger@example.com");
  assert.equal((await other.patch(`/api/accounts/${x}`, { premium: true })).status, 404);
  assert.equal((await c.get("/api/accounts")).data.find((a) => a.id === x).premium, false, "unchanged");
});

test("X characters are counted the way X counts them", async () => {
  const { x, mcp } = await xUser("counting@example.com");
  const schedule = (content) => mcp("schedule_post", { content, account_ids: [x], scheduled_at: inAnHour() });

  // 140 emoji are 140 characters to JavaScript but 280 to X: exactly the limit.
  assert.equal((await schedule("😀".repeat(140))).isError, undefined);
  const over = await schedule("😀".repeat(141));
  assert.equal(over.isError, true);
  assert.match(over.content[0].text, /282\/280/);
  // A family emoji is one emoji to X (weight 2), even though it is 7 code points.
  assert.match((await schedule("👨‍👩‍👧‍👦".repeat(141))).content[0].text, /282\/280/);

  // Every link counts as 23, however long it is.
  const link = "https://example.com/" + "a".repeat(400);
  assert.equal((await schedule("a".repeat(256) + " " + link)).isError, undefined, "256 + 1 + 23 = 280");
  assert.match((await schedule("a".repeat(257) + " " + link)).content[0].text, /281\/280/);
});

test("a thread is posted as a chain of replies, with the image on the first post", async () => {
  const { mcp } = await xUser("thread@example.com");
  const img = mcpData(await mcp("upload_image", { filename: "cover.png", data_base64: PNG.toString("base64") }));
  const before = fakeX.tweets.length;

  const result = await mcp("publish_now", {
    platforms: ["x"], content: "1/ A thread about threads", thread: ["2/ The middle", "3/ The end"], media_url: img.url,
  });
  assert.equal(result.isError, undefined, result.content[0].text);
  const post = mcpData(result);
  assert.equal(post.status, "published");
  assert.deepEqual(post.thread, ["2/ The middle", "3/ The end"]);

  const sent = fakeX.tweets.slice(before);
  assert.equal(sent.length, 3, "three posts, three calls");
  assert.deepEqual(sent.map((t) => t.text), ["1/ A thread about threads", "2/ The middle", "3/ The end"]);
  const first = String(1000 + before + 1);
  assert.equal(sent[0].reply, undefined);
  assert.deepEqual(sent[0].media, { media_ids: [`xmedia-${fakeX.media.length}`] });
  assert.deepEqual(sent[1].reply, { in_reply_to_tweet_id: first });
  assert.deepEqual(sent[2].reply, { in_reply_to_tweet_id: String(1000 + before + 2) });
  assert.equal(sent[1].media, undefined);
  assert.equal(post.targets[0].url, `https://x.com/xtester/status/${first}`, "the link is the first post");
  assert.equal(post.targets[0].thread_posts_sent, 3);

  assert.deepEqual(mcpData(await mcp("get_post", { post_id: post.id })).thread, ["2/ The middle", "3/ The end"]);
});

test("a thread that fails halfway carries on from there when retried", async () => {
  const { c, x, mcp } = await xUser("thread-retry@example.com");
  const before = fakeX.tweets.length;
  fakeX.behavior.fail = (body) => body.text === "third";
  try {
    const failed = mcpData(await mcp("publish_now", { account_ids: [x], content: "first", thread: ["second", "third", "fourth"] }));
    const target = failed.targets[0];
    assert.equal(target.status, "pending", "the scheduler will try again");
    assert.match(target.error, /^Thread post 3 of 4 failed: 503 Service Unavailable\. Posts 1-2 are live \(https:\/\/x\.com\/xtester\/status\/\d+\)/);
    assert.equal(target.thread_posts_sent, 2);
    assert.equal(fakeX.tweets.length - before, 3);

    // X is back. A retry sends only what is missing, replying to the last post that went out.
    fakeX.behavior.fail = () => false;
    const retried = (await c.post(`/api/posts/${failed.id}/publish`)).data;
    assert.equal(retried.status, "published");
    const sent = fakeX.tweets.slice(before);
    assert.deepEqual(sent.map((t) => t.text), ["first", "second", "third", "third", "fourth"]);
    assert.deepEqual(sent[3].reply, { in_reply_to_tweet_id: String(1000 + before + 2) }, "replies to 'second'");
    assert.deepEqual(sent[4].reply, { in_reply_to_tweet_id: String(1000 + before + 4) }, "replies to the retried 'third'");
    assert.equal(retried.targets[0].remote_url, `https://x.com/xtester/status/${1000 + before + 1}`);
  } finally {
    fakeX.behavior.fail = () => false;
  }
});

test("every thread post is checked against the account's limit", async () => {
  const { c, x, mcp } = await xUser("thread-limits@example.com");
  const masto = await connectMastodon(c, fakeMastodon, "threadlimits");

  const tooLong = await mcp("schedule_post", { account_ids: [x], content: "ok", thread: ["fine", "b".repeat(281)], scheduled_at: inAnHour() });
  assert.equal(tooLong.isError, true);
  assert.match(tooLong.content[0].text, /X \(Twitter\) @xtester, thread post 3: 281\/280 characters/);

  await c.patch(`/api/accounts/${x}`, { premium: true });
  const premium = await mcp("schedule_post", { account_ids: [x, masto], content: "ok", thread: ["b".repeat(281)], scheduled_at: inAnHour() });
  assert.equal(premium.isError, undefined, premium.content[0].text);

  const noX = await mcp("schedule_post", { account_ids: [masto], content: "ok", thread: ["more"], scheduled_at: inAnHour() });
  assert.match(noX.content[0].text, /thread is only posted to X/);

  // update_post can replace or remove the thread.
  const id = mcpData(premium).post.id;
  assert.deepEqual(mcpData(await mcp("update_post", { post_id: id, thread: ["new second post"] })).post.thread, ["new second post"]);
  assert.deepEqual(mcpData(await mcp("update_post", { post_id: id, thread: [] })).post.thread, []);
});

test("the dashboard saves and returns a thread", async () => {
  const { c, x } = await xUser("thread-web@example.com");
  const saved = (await c.post("/api/posts", { content: "one", thread: ["two", "three"], scheduled_at: inAnHour(), targets: [{ account_id: x }] })).data;
  assert.deepEqual(saved.thread, ["two", "three"]);
  const edited = (await c.put(`/api/posts/${saved.id}`, { content: "one", thread: ["two"], scheduled_at: inAnHour(), targets: [{ account_id: x }] })).data;
  assert.deepEqual(edited.thread, ["two"]);
  const blank = await c.post("/api/posts", { content: "one", thread: ["  "], scheduled_at: inAnHour(), targets: [{ account_id: x }] });
  assert.match(blank.data.error, /needs text/);
});
