// Binance Square: connect with an OpenAPI key, publish text and image posts, and fail
// at once (no retry) when Binance says retrying cannot help.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, client, inAnHour, mcpCall, mcpData } from "./helpers.js";

const GOOD = "sq_good_key_123456789";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64");

/** Fake Square OpenAPI. `behavior.publish` = "ok" | "sensitive" | "504". */
async function startFakeSquare() {
  const posts = [], uploads = [], calls = [];
  const behavior = { publish: "ok" };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const json = (code, data) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    const ok = (data) => json(200, { code: "000000", message: null, data });
    const fail = (code, message) => json(200, { code, message, data: null });
    calls.push(req.url);

    if (req.url === "/s3/put" && req.method === "PUT") {
      uploads.push({ bytes: raw.length, type: req.headers["content-type"] });
      res.writeHead(200); return res.end();
    }
    const key = req.headers["x-square-openapi-key"];
    if (req.headers.clienttype !== "binanceSkill") return fail("400", "missing clienttype");
    if (key !== GOOD) return fail("220003", "API Key not found");
    const body = JSON.parse(raw.toString() || "{}");

    if (req.url === "/v2/public/pgc/openApi/image/presignedUrl") return ok({ presignedUrl: `${url}/s3/put`, fileTicket: "ticket-1" });
    if (req.url === "/v2/public/pgc/openApi/image/imageStatus") return ok({ status: 1, imageUrl: "https://public.bnbstatic.com/img/1.png" });
    if (req.url === "/v1/public/pgc/openApi/content/add") {
      if (!body.bodyTextOnly) return fail("220011", "Content body must not be empty");
      posts.push(body);
      if (behavior.publish === "sensitive") return fail("20002", "Detected sensitive words");
      if (behavior.publish === "504") { res.writeHead(504); return res.end("Gateway Timeout"); }
      return ok({ id: String(298177291743000 + posts.length) });
    }
    json(404, { code: "404", message: "not found" });
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  return { url, posts, uploads, calls, behavior, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

let app, sq, c, accountId;
before(async () => {
  sq = await startFakeSquare();
  app = await startServer({ env: { BINANCE_SQUARE_API_URL: sq.url, BINANCE_SQUARE_POLL_MS: "10" } });
  c = client(app.url);
  await c.signUp("josh@example.com");
});
after(async () => { await app.stop(); await sq.close(); });

const postNow = async (body) => {
  const p = (await c.post("/api/posts", { scheduled_at: inAnHour(), targets: [{ account_id: accountId }], ...body })).data;
  assert.ok(p.id, "post created: " + JSON.stringify(p));
  return (await c.post(`/api/posts/${p.id}/publish`)).data;
};

test("Binance Square shows up as a key-based platform", async () => {
  const p = (await c.get("/api/platforms")).data.find((x) => x.id === "binance_square");
  assert.equal(p.kind, "credentials");
  assert.equal(p.limit, 4000);
  assert.deepEqual(p.fields.map((f) => f.name), ["api_key", "name"]);
});

test("a wrong key is refused and nothing is saved", async () => {
  const r = await c.post("/api/accounts/connect/binance_square", { api_key: "sq_wrong", name: "" });
  assert.notEqual(r.status, 200);
  assert.match(r.data.error, /key was not found/);
  assert.equal((await c.get("/api/accounts")).data.length, 0);
});

test("a good key connects without publishing anything", async () => {
  const r = await c.post("/api/accounts/connect/binance_square", { api_key: GOOD, name: "Big Josh Codes" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  accountId = r.data.ids[0];
  const a = (await c.get("/api/accounts")).data.find((x) => x.id === accountId);
  assert.equal(a.platform, "binance_square");
  assert.equal(a.name, "Big Josh Codes");
  assert.equal(a.handle, "sq_go…6789", "only a masked key is shown");
  assert.equal(sq.posts.length, 0, "the key check does not create a post");

  // Connecting the same key again updates the account instead of adding a second one.
  const again = await c.post("/api/accounts/connect/binance_square", { api_key: GOOD, name: "Renamed" });
  assert.equal(again.data.ids[0], accountId);
});

test("publishes a text post with cashtags and hashtags untouched", async () => {
  const text = "Binance withdrawals are back 🔓 $BTC $BNB #BinanceReopensWithdrawalsForMoreAssets";
  const post = await postNow({ content: text });
  assert.equal(post.status, "published");
  assert.deepEqual(sq.posts.at(-1), { contentType: 1, bodyTextOnly: text });
  assert.match(post.targets[0].remote_url, /^https:\/\/www\.binance\.com\/square\/post\/\d+$/);
});

test("publishes an image post through the upload flow", async () => {
  const up = await fetch(`${app.url}/api/images`, {
    method: "POST", headers: { Cookie: c.cookie(), "Content-Type": "image/png", "X-File-Name": "chart.png" }, body: PNG,
  });
  const img = await up.json();
  const mediaUrl = img.url;
  assert.ok(mediaUrl, "image uploaded: " + JSON.stringify(img));

  const post = await postNow({ content: "Chart of the day $BTC", media_url: mediaUrl });
  assert.equal(post.status, "published", JSON.stringify(post.targets));
  assert.equal(sq.uploads.length, 1);
  assert.equal(sq.uploads[0].type, "image/png");
  assert.deepEqual(sq.posts.at(-1).imageList, ["https://public.bnbstatic.com/img/1.png"]);
});

test("refused content fails at once with the reason, no retries", async () => {
  sq.behavior.publish = "sensitive";
  const before = sq.posts.length;
  const post = await postNow({ content: "something Binance does not like $BNB" });
  sq.behavior.publish = "ok";
  assert.equal(post.status, "failed");
  assert.match(post.targets[0].error, /sensitive/);
  assert.equal(post.targets[0].attempts, 1);
  assert.equal(sq.posts.length - before, 1, "sent exactly once");
});

test("a 504 from publish counts as published (Binance's own rule)", async () => {
  sq.behavior.publish = "504";
  const post = await postNow({ content: "Gateway hiccup $ETH" });
  sq.behavior.publish = "ok";
  assert.equal(post.status, "published");
  assert.equal(post.targets[0].remote_url, null);
});

test("Claude can schedule to Binance Square through the connector", async () => {
  const key = (await c.get("/api/settings")).data.mcp.key;
  const accounts = mcpData(await mcpCall(app.url, key, "list_accounts"));
  const sqAcct = accounts.find((a) => a.platform === "binance_square");
  assert.ok(sqAcct);
  assert.equal(sqAcct.char_limit, 4000);
  const tooLong = await mcpCall(app.url, key, "schedule_post", {
    content: "x".repeat(4001), platforms: ["binance_square"], scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  assert.ok(tooLong.isError, "posts over 4000 characters are refused before sending");
});
