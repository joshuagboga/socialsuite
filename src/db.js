import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dataDir = path.resolve(process.env.DATA_DIR || "./data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "socialsuite.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    external_id TEXT NOT NULL,
    name TEXT NOT NULL,
    handle TEXT,
    avatar_url TEXT,
    credentials TEXT NOT NULL,       -- JSON: tokens, ids, instance urls
    token_expires_at INTEGER,        -- ms epoch, null if non-expiring
    created_at INTEGER NOT NULL,
    UNIQUE (platform, external_id)
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    media_url TEXT,
    scheduled_at INTEGER,            -- ms epoch; null = draft
    status TEXT NOT NULL,            -- draft | scheduled | publishing | published | partial | failed
    source TEXT NOT NULL DEFAULT 'web', -- web | claude
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS post_targets (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    content_override TEXT,           -- platform-specific variant
    status TEXT NOT NULL DEFAULT 'pending', -- pending | published | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    remote_id TEXT,
    remote_url TEXT,
    error TEXT,
    published_at INTEGER,
    PRIMARY KEY (post_id, account_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
db.exec("PRAGMA foreign_keys = ON;");

export const newId = () => crypto.randomUUID();

export function getSetting(key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

// ---------- accounts ----------

export function publicAccount(row) {
  if (!row) return null;
  const { credentials, ...rest } = row;
  return rest;
}

export function listAccounts() {
  return db.prepare("SELECT * FROM accounts ORDER BY platform, name").all().map(publicAccount);
}

export function getAccount(id) {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, credentials: JSON.parse(row.credentials) };
}

export function upsertAccount({ platform, external_id, name, handle, avatar_url, credentials, token_expires_at }) {
  const existing = db
    .prepare("SELECT id FROM accounts WHERE platform = ? AND external_id = ?")
    .get(platform, String(external_id));
  const id = existing?.id ?? newId();
  db.prepare(
    `INSERT INTO accounts (id, platform, external_id, name, handle, avatar_url, credentials, token_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, handle = excluded.handle,
       avatar_url = excluded.avatar_url, credentials = excluded.credentials,
       token_expires_at = excluded.token_expires_at`
  ).run(
    id, platform, String(external_id), name, handle ?? null, avatar_url ?? null,
    JSON.stringify(credentials), token_expires_at ?? null, Date.now()
  );
  return id;
}

export function updateAccountCredentials(id, credentials, token_expires_at) {
  db.prepare("UPDATE accounts SET credentials = ?, token_expires_at = ? WHERE id = ?").run(
    JSON.stringify(credentials), token_expires_at ?? null, id
  );
}

export function deleteAccount(id) {
  return db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
}

// ---------- posts ----------

function hydratePost(row) {
  if (!row) return null;
  const targets = db
    .prepare(
      `SELECT t.*, a.platform, a.name AS account_name, a.handle AS account_handle
       FROM post_targets t JOIN accounts a ON a.id = t.account_id WHERE t.post_id = ?`
    )
    .all(row.id);
  return { ...row, targets };
}

export function getPost(id) {
  return hydratePost(db.prepare("SELECT * FROM posts WHERE id = ?").get(id));
}

export function listPosts({ status, from, to, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push("status = ?"); args.push(status); }
  if (from) { where.push("scheduled_at >= ?"); args.push(from); }
  if (to) { where.push("scheduled_at < ?"); args.push(to); }
  const sql = `SELECT * FROM posts ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit).map(hydratePost);
}

/**
 * targets: [{ account_id, content_override? }]
 * scheduled_at: ms epoch, or null for a draft. Pass publish_now to schedule for "now".
 */
export function savePost({ id, content, media_url, scheduled_at, targets, source = "web", draft = false }) {
  const now = Date.now();
  const status = draft || scheduled_at == null ? "draft" : "scheduled";
  const postId = id ?? newId();

  db.exec("BEGIN");
  try {
    if (id) {
      const existing = db.prepare("SELECT status FROM posts WHERE id = ?").get(id);
      if (!existing) throw new Error("Post not found");
      if (!["draft", "scheduled", "failed"].includes(existing.status)) {
        throw new Error(`Cannot edit a post that is ${existing.status}`);
      }
      db.prepare(
        "UPDATE posts SET content = ?, media_url = ?, scheduled_at = ?, status = ?, updated_at = ? WHERE id = ?"
      ).run(content, media_url ?? null, scheduled_at ?? null, status, now, id);
      db.prepare("DELETE FROM post_targets WHERE post_id = ?").run(id);
    } else {
      db.prepare(
        `INSERT INTO posts (id, content, media_url, scheduled_at, status, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(postId, content, media_url ?? null, scheduled_at ?? null, status, source, now, now);
    }
    const ins = db.prepare(
      "INSERT INTO post_targets (post_id, account_id, content_override) VALUES (?, ?, ?)"
    );
    for (const t of targets) {
      if (!db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(t.account_id)) {
        throw new Error(`Unknown account ${t.account_id}`);
      }
      ins.run(postId, t.account_id, t.content_override || null);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return getPost(postId);
}

export function deletePost(id) {
  const row = db.prepare("SELECT status FROM posts WHERE id = ?").get(id);
  if (!row) return false;
  if (row.status === "publishing") throw new Error("Post is publishing right now");
  db.prepare("DELETE FROM posts WHERE id = ?").run(id);
  return true;
}

/** Atomically claim due posts so a post is never picked up twice. */
export function claimDuePosts(now = Date.now()) {
  const due = db
    .prepare("SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at")
    .all(now);
  const claimed = [];
  const claim = db.prepare("UPDATE posts SET status = 'publishing', updated_at = ? WHERE id = ? AND status = 'scheduled'");
  for (const { id } of due) {
    if (claim.run(now, id).changes) claimed.push(id);
  }
  return claimed;
}

export function updateTarget(post_id, account_id, fields) {
  const keys = Object.keys(fields);
  db.prepare(
    `UPDATE post_targets SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE post_id = ? AND account_id = ?`
  ).run(...keys.map((k) => fields[k]), post_id, account_id);
}

export function setPostStatus(id, status) {
  db.prepare("UPDATE posts SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
}

/** On boot, anything stuck in 'publishing' (crash mid-run) goes back to scheduled. */
export function recoverStuckPosts() {
  db.prepare("UPDATE posts SET status = 'scheduled' WHERE status = 'publishing'").run();
}
