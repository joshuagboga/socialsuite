// Upgrading a database made by the original single-user version (APP_PASSWORD, plain-text tokens).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer, startFakeMastodon, client, tmpDir } from "./helpers.js";

// The schema exactly as the first release created it.
const OLD_SCHEMA = `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT NOT NULL, handle TEXT,
    avatar_url TEXT, credentials TEXT NOT NULL, token_expires_at INTEGER, created_at INTEGER NOT NULL,
    UNIQUE (platform, external_id)
  );
  CREATE TABLE posts (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, media_url TEXT, scheduled_at INTEGER, status TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'web', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE post_targets (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    content_override TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    remote_id TEXT, remote_url TEXT, error TEXT, published_at INTEGER,
    PRIMARY KEY (post_id, account_id)
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

test("an old single-user database is upgraded, encrypted, and handed to the first sign-up", async () => {
  const fake = await startFakeMastodon();
  const dataDir = tmpDir();
  const when = Date.now() + 3600_000;
  const old = new DatabaseSync(path.join(dataDir, "socialsuite.db"));
  old.exec(OLD_SCHEMA);
  old.prepare("INSERT INTO accounts VALUES ('acct-1', 'mastodon', 'me@old', 'Old Me', '@me', NULL, ?, NULL, 1)")
    .run(JSON.stringify({ instance: fake.url, access_token: "legacy-plain-token-77" }));
  old.prepare("INSERT INTO posts VALUES ('post-1', 'written before the upgrade', NULL, ?, 'scheduled', 'web', 1, 1)").run(when);
  old.exec("INSERT INTO post_targets (post_id, account_id) VALUES ('post-1', 'acct-1')");
  old.exec("INSERT INTO settings VALUES ('mcp_api_key', 'ss_legacy_connector_key')");
  old.close();

  const app = await startServer({ dataDir });
  try {
    // The stored token is encrypted as soon as the new version boots.
    const raw = fs.readdirSync(dataDir).filter((f) => f.startsWith("socialsuite.db"))
      .map((f) => fs.readFileSync(path.join(dataDir, f)).toString("latin1")).join("");
    assert.ok(raw.includes("enc:v1:"));
    assert.match(app.log(), /encrypted stored credentials for 1 account/);

    // The first person to sign up owns everything that was there.
    const owner = client(app.url);
    await owner.signUp("owner@example.com");
    assert.deepEqual((await owner.get("/api/accounts")).data.map((a) => a.id), ["acct-1"]);
    const post = (await owner.get("/api/posts/post-1")).data;
    assert.equal(post.content, "written before the upgrade");
    assert.equal(post.scheduled_at, when);
    assert.equal(post.targets[0].account_id, "acct-1");
    assert.equal((await owner.get("/api/settings")).data.mcp.key, "ss_legacy_connector_key", "the existing Claude connector keeps working");

    // The migrated token still decrypts and publishes.
    assert.equal((await owner.post("/api/posts/post-1/publish")).data.status, "published");
    assert.equal(fake.posts[0].token, "legacy-plain-token-77");

    // A later sign-up starts empty.
    const second = client(app.url);
    await second.signUp("second@example.com");
    assert.deepEqual((await second.get("/api/accounts")).data, []);
    assert.deepEqual((await second.get("/api/posts")).data, []);
  } finally {
    await app.stop(); await fake.close();
  }

  // After a clean shutdown the plain-text token is gone from the files on disk.
  const raw = fs.readdirSync(dataDir).filter((f) => f.startsWith("socialsuite.db"))
    .map((f) => fs.readFileSync(path.join(dataDir, f)).toString("latin1")).join("");
  assert.ok(!raw.includes("legacy-plain-token-77"));
});
