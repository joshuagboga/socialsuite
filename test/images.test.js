// The image library and the connector tools that let Claude attach images.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, startFakeMastodon, client, connectMastodon, inAnHour, mcpCall, mcpData } from "./helpers.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG_THUMB = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

let app, fake;
before(async () => { app = await startServer(); fake = await startFakeMastodon(); });
after(async () => { await app.stop(); await fake.close(); });

async function signedIn(email) {
  const c = client(app.url);
  await c.signUp(email);
  return c;
}

// Raw (non-JSON) upload, using the session cookie the client holds.
async function upload(c, { bytes = PNG, type = "image/png", name, source, path = "/api/images", method = "POST" } = {}) {
  const res = await fetch(app.url + path, {
    method,
    headers: { "Content-Type": type, Cookie: c.cookie(), ...(name ? { "X-File-Name": encodeURIComponent(name) } : {}), ...(source ? { "X-Image-Source": source } : {}) },
    body: bytes,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const mcp = (key, name, args) => mcpCall(app.url, key, name, args);

test("upload, list, rename and delete an image", async () => {
  const c = await signedIn("img-owner@example.com");
  const up = await upload(c, { name: "launch banner é.png" });
  assert.equal(up.status, 200);
  assert.equal(up.data.image.name, "launch banner é.png");
  assert.equal(up.data.url, up.data.image.url);
  assert.match(up.data.url, /\/uploads\/[\w-]+\.png$/);

  // The file is served publicly (platforms fetch it by URL).
  const served = await fetch(up.data.url);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

  const list = (await c.get("/api/images")).data;
  assert.deepEqual(list.map((i) => i.name), ["launch banner é.png"]);

  const renamed = await fetch(`${app.url}/api/images/${up.data.image.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: c.cookie() }, body: JSON.stringify({ name: "  Launch   banner  " }),
  });
  assert.equal((await renamed.json()).name, "Launch banner");

  assert.equal((await c.del(`/api/images/${up.data.image.id}`)).status, 200);
  assert.deepEqual((await c.get("/api/images")).data, []);
  assert.equal((await fetch(up.data.url)).status, 404, "the file is removed from disk");
});

test("rejects files that are not images", async () => {
  const c = await signedIn("img-bad@example.com");
  const r = await upload(c, { bytes: Buffer.from("hello"), type: "text/plain", name: "notes.txt" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /PNG, JPEG, GIF or WebP/);
});

test("the composer's old upload address still works and adds to the library", async () => {
  const c = await signedIn("img-compat@example.com");
  const r = await upload(c, { path: "/api/upload" });
  assert.match(r.data.url, /\/uploads\//);
  assert.equal((await c.get("/api/images")).data.length, 1);
});

test("images are private to their owner", async () => {
  const alice = await signedIn("img-alice@example.com"), bob = await signedIn("img-bob@example.com");
  const img = (await upload(alice, { name: "alice.png" })).data.image;

  assert.deepEqual((await bob.get("/api/images")).data, []);
  assert.equal((await bob.del(`/api/images/${img.id}`)).status, 404);
  const rename = await fetch(`${app.url}/api/images/${img.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: bob.cookie() }, body: JSON.stringify({ name: "stolen" }),
  });
  assert.equal(rename.status, 404);
  assert.equal((await upload(bob, { path: `/api/images/${img.id}/thumb`, method: "PUT", bytes: JPEG_THUMB, type: "image/jpeg" })).status, 404);

  const bobKey = (await bob.get("/api/settings")).data.mcp.key;
  assert.deepEqual(JSON.parse((await mcp(bobKey, "list_images")).content[0].text), []);
  assert.equal((await mcp(bobKey, "view_image", { image_id: img.id })).isError, true);
  assert.equal((await alice.get("/api/images")).data[0].name, "alice.png", "untouched");
});

test("an image attached to a scheduled post cannot be deleted", async () => {
  const c = await signedIn("img-inuse@example.com");
  const account = await connectMastodon(c, fake, "imguser");
  const img = (await upload(c, { name: "in use.png" })).data.image;
  const post = (await c.post("/api/posts", {
    content: "with picture", media_url: img.url, scheduled_at: inAnHour(), targets: [{ account_id: account }],
  })).data;

  const blocked = await c.del(`/api/images/${img.id}`);
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /attached to 1 draft or scheduled post/);

  await c.del(`/api/posts/${post.id}`);
  assert.equal((await c.del(`/api/images/${img.id}`)).status, 200);
});

test("Claude can find an image, look at it, and attach it to a post", async () => {
  const c = await signedIn("img-claude@example.com");
  const account = await connectMastodon(c, fake, "claudeuser");
  await upload(c, { name: "team photo.png" });
  const logo = (await upload(c, { name: "SocialSuite logo.png", source: "drive" })).data.image;
  const key = (await c.get("/api/settings")).data.mcp.key;

  // Find it by name.
  const found = JSON.parse((await mcp(key, "list_images", { query: "LOGO" })).content[0].text);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "SocialSuite logo.png");
  assert.equal(found[0].from, "Google Drive");
  assert.equal(found[0].url, logo.url);
  assert.equal(JSON.parse((await mcp(key, "list_images")).content[0].text).length, 2);

  // Look at it: without a thumbnail a small original is sent...
  let view = await mcp(key, "view_image", { image_id: logo.id });
  assert.equal(view.content[0].type, "image");
  assert.equal(view.content[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(view.content[0].data, "base64"), PNG);
  // ...and once the browser has stored a thumbnail, that is sent instead.
  const thumb = await upload(c, { path: `/api/images/${logo.id}/thumb`, method: "PUT", bytes: JPEG_THUMB, type: "image/jpeg" });
  assert.match(thumb.data.thumb_url, /\.thumb\.jpg$/);
  view = await mcp(key, "view_image", { image_id: logo.id });
  assert.equal(view.content[0].mimeType, "image/jpeg");

  // Attach it by passing its url as media_url.
  const scheduled = JSON.parse((await mcp(key, "schedule_post", {
    content: "Our new logo", account_ids: [account], media_url: found[0].url, scheduled_at: inAnHour(),
  })).content[0].text);
  assert.equal(scheduled.post.media_url, logo.url);
  assert.equal((await c.get(`/api/posts/${scheduled.post.id}`)).data.media_url, logo.url);
});

test("a post with a library image sends the image to the platform", async () => {
  const c = await signedIn("img-publish@example.com");
  const account = await connectMastodon(c, fake, "publisher");
  const img = (await upload(c, { name: "to publish.png" })).data.image;
  const post = (await c.post("/api/posts", {
    content: "picture post", media_url: img.url, scheduled_at: inAnHour(), targets: [{ account_id: account }],
  })).data;

  const before = fake.media.length;
  const result = (await c.post(`/api/posts/${post.id}/publish`)).data;
  assert.equal(result.status, "published");
  assert.equal(fake.media.length, before + 1);
  assert.ok(fake.media.at(-1).raw.includes(PNG), "the exact image bytes were uploaded");
  assert.deepEqual(fake.posts.at(-1).mediaIds, [`media-${fake.media.length}`]);

  // Once published, the post no longer holds the image in the library.
  assert.equal((await c.del(`/api/images/${img.id}`)).status, 200);
});

// ---------------------------------------------------------------- upload_image (Claude adds a picture)

test("Claude can upload a picture and it shows up in the library", async () => {
  const c = await signedIn("img-upload@example.com");
  const key = (await c.get("/api/settings")).data.mcp.key;

  const result = await mcp(key, "upload_image", { filename: "chart.png", data_base64: PNG.toString("base64"), name: "Q3 chart" });
  assert.equal(result.isError, undefined, result.content[0].text);
  const up = mcpData(result);
  assert.equal(up.name, "Q3 chart");
  assert.match(up.image_id, /^[\w-]{36}$/);
  assert.match(up.url, /\/uploads\/[\w-]+\.png$/);
  assert.deepEqual(Buffer.from(await (await fetch(up.url)).arrayBuffer()), PNG, "served exactly as sent");

  const listed = mcpData(await mcp(key, "list_images"));
  assert.deepEqual(listed.map((i) => [i.image_id, i.name, i.url, i.type]), [[up.image_id, "Q3 chart", up.url, "image/png"]]);
  assert.equal((await c.get("/api/images")).data[0].id, up.image_id, "the dashboard sees it too");

  // The name defaults to the file name, and a data: URL prefix is accepted.
  const named = mcpData(await mcp(key, "upload_image", { filename: "logo.PNG", data_base64: "data:image/png;base64," + PNG.toString("base64") }));
  assert.equal(named.name, "logo.PNG");
});

test("upload_image goes by the file's bytes, not its name", async () => {
  const c = await signedIn("img-sniff@example.com");
  const key = (await c.get("/api/settings")).data.mcp.key;

  const fake = await mcp(key, "upload_image", { filename: "photo.png", data_base64: Buffer.from("#!/bin/sh\necho not a picture\n").toString("base64") });
  assert.equal(fake.isError, true);
  assert.match(fake.content[0].text, /not a PNG, JPEG, GIF or WebP/);

  // A real JPEG named .png is stored as the JPEG it is.
  const jpeg = mcpData(await mcp(key, "upload_image", { filename: "wrong-name.png", data_base64: JPEG_THUMB.toString("base64") }));
  assert.equal(jpeg.type, "image/jpeg");
  assert.match(jpeg.url, /\.jpg$/);

  const badName = await mcp(key, "upload_image", { filename: "notes.txt", data_base64: PNG.toString("base64") });
  assert.equal(badName.isError, true);
  assert.match(badName.content[0].text, /must end in \.png/);
  for (const data_base64 of ["", "   ", "not base64 at all!"]) {
    const r = await mcp(key, "upload_image", { filename: "x.png", data_base64 });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /data_base64 is (empty|not valid base64)/);
  }
  assert.equal(mcpData(await mcp(key, "list_images")).length, 1, "only the real JPEG was saved");
});

test("upload_image takes pictures up to 8 MB and refuses bigger ones", async () => {
  const c = await signedIn("img-big@example.com");
  const key = (await c.get("/api/settings")).data.mcp.key;
  const sized = (n) => Buffer.concat([PNG, Buffer.alloc(n - PNG.length, 7)]);

  // About 11 MB of JSON: the connector's request size limit has to allow it.
  const big = await mcp(key, "upload_image", { filename: "big.png", data_base64: sized(8 * 1024 * 1024).toString("base64") });
  assert.equal(big.isError, undefined, big.content[0].text);
  assert.equal(mcpData(big).size_kb, 8192);

  const tooBig = await mcp(key, "upload_image", { filename: "huge.png", data_base64: sized(8 * 1024 * 1024 + 1).toString("base64") });
  assert.equal(tooBig.isError, true);
  assert.match(tooBig.content[0].text, /over 8 MB/);
});

test("a picture Claude uploads is private to that user", async () => {
  const alice = await signedIn("img-up-alice@example.com"), bob = await signedIn("img-up-bob@example.com");
  const aliceKey = (await alice.get("/api/settings")).data.mcp.key;
  const bobKey = (await bob.get("/api/settings")).data.mcp.key;
  const img = mcpData(await mcp(aliceKey, "upload_image", { filename: "alice-secret.png", data_base64: PNG.toString("base64") }));

  assert.deepEqual(mcpData(await mcp(bobKey, "list_images")), []);
  assert.equal((await mcp(bobKey, "view_image", { image_id: img.image_id })).isError, true);
  assert.deepEqual((await bob.get("/api/images")).data, []);
  assert.equal((await bob.del(`/api/images/${img.image_id}`)).status, 404);
  assert.equal(mcpData(await mcp(aliceKey, "list_images")).length, 1);
});
