import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./config.js";
import { encrypt, decrypt, isEncrypted, assertEncryptionReady } from "./secrets.js";

fs.mkdirSync(DATA_DIR, { recursive: true });
try {
  assertEncryptionReady();
} catch (err) {
  // A setup problem, not a bug: show the instructions without a stack trace.
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

export const db = new DatabaseSync(path.join(DATA_DIR, "socialsuite.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA secure_delete = ON;"); // zero out deleted rows instead of leaving them in the file

// ---------------------------------------------------------------- schema

const accountsTable = (name) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE, -- owner; NULL only for old single-user data nobody has claimed yet
    platform TEXT NOT NULL,
    external_id TEXT NOT NULL,
    name TEXT NOT NULL,
    handle TEXT,
    avatar_url TEXT,
    credentials TEXT NOT NULL,       -- encrypted JSON: tokens, ids, instance urls (see secrets.js)
    token_expires_at INTEGER,        -- ms epoch, null if non-expiring
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, platform, external_id)
  );`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,     -- scrypt, see auth.js
    mcp_key_hash TEXT UNIQUE,        -- sha256 of the Claude connector key, for lookup
    mcp_key_enc TEXT,                -- the same key encrypted, so the dashboard can show it again
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,     -- sha256 of the cookie value; the raw token is never stored
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  ${accountsTable("accounts")}

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    media_url TEXT,
    scheduled_at INTEGER,            -- ms epoch the user picked; null = draft. Never moved by retries.
    status TEXT NOT NULL,            -- draft | scheduled | publishing | published | partial | failed
    source TEXT NOT NULL DEFAULT 'web', -- web | claude
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    next_attempt_at INTEGER          -- ms epoch of the next retry; null = use scheduled_at
  );

  CREATE TABLE IF NOT EXISTS post_targets (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    content_override TEXT,           -- platform-specific variant
    status TEXT NOT NULL DEFAULT 'pending', -- pending | publishing | published | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    remote_id TEXT,
    remote_url TEXT,
    error TEXT,
    published_at INTEGER,
    PRIMARY KEY (post_id, account_id)
  );

  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,              -- what the user (and Claude) call it
    file TEXT NOT NULL UNIQUE,       -- random file name inside the uploads folder
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,           -- bytes
    source TEXT NOT NULL DEFAULT 'upload', -- upload | drive
    has_thumb INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
  CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, next_attempt_at, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_images_user ON images(user_id, created_at);
`;

const SCHEMA_VERSION = 1;

/**
 * Version 0 is the original single-user database (one APP_PASSWORD, no users table).
 * Upgrade it in place: add owners to accounts and posts, and add next_attempt_at.
 * SQLite cannot change a UNIQUE constraint, so the accounts table is rebuilt.
 */
function migrateFromSingleUser() {
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("BEGIN");
  try {
    db.exec(accountsTable("accounts_new"));
    db.exec(`
      INSERT INTO accounts_new (id, user_id, platform, external_id, name, handle, avatar_url, credentials, token_expires_at, created_at)
        SELECT id, NULL, platform, external_id, name, handle, avatar_url, credentials, token_expires_at, created_at FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_new RENAME TO accounts;
      ALTER TABLE posts ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE posts ADD COLUMN next_attempt_at INTEGER;
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
  console.log("[db] upgraded the database for user accounts. The first person to sign up takes over the existing accounts and posts.");
}

const version = db.prepare("PRAGMA user_version").get().user_version;
const hasOldTables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get();
if (version === 0 && hasOldTables) migrateFromSingleUser();
db.exec(SCHEMA);
db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
db.exec("PRAGMA foreign_keys = ON;");

// Encrypt any credentials saved before encryption existed.
{
  const plain = db.prepare("SELECT id, credentials FROM accounts WHERE credentials NOT LIKE 'enc:v1:%'").all();
  const update = db.prepare("UPDATE accounts SET credentials = ? WHERE id = ?");
  for (const row of plain) update.run(encrypt(row.credentials, row.id), row.id);
  if (plain.length) {
    // Overwriting a row leaves the old plain-text bytes behind in freed pages and in the
    // write-ahead log. Rebuild the file and empty the log so they are really gone from disk.
    db.exec("VACUUM;");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    console.log(`[db] encrypted stored credentials for ${plain.length} account(s)`);
  }
}

export const newId = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function transaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getSetting(key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

// ---------------------------------------------------------------- users

export function publicUser(row) {
  return row ? { id: row.id, email: row.email, name: row.name } : null;
}

export const countUsers = () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
export const getUserByEmail = (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).trim()) ?? null;
export const getUserById = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id) ?? null;

/**
 * Create a user. The first user on a database upgraded from the single-user version takes
 * ownership of the accounts, posts and Claude connector key that already exist.
 */
export function createUser({ email, name, password_hash }) {
  return transaction(() => {
    const id = newId();
    const first = countUsers() === 0;
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, email.trim(), name.trim(), password_hash, Date.now());
    if (first) {
      db.prepare("UPDATE accounts SET user_id = ? WHERE user_id IS NULL").run(id);
      db.prepare("UPDATE posts SET user_id = ? WHERE user_id IS NULL").run(id);
      const oldKey = getSetting("mcp_api_key");
      if (oldKey) {
        setMcpKey(id, oldKey);
        db.prepare("DELETE FROM settings WHERE key = 'mcp_api_key'").run();
      }
    }
    return getUserById(id);
  });
}

export function setUserPassword(id, password_hash) {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(password_hash, id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id); // sign out everywhere
}

// ---------------------------------------------------------------- sessions

/** Returns the raw token to put in the cookie. Only its hash is stored. */
export function createSession(userId, ttlMs) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(sha256(token), userId, Date.now() + ttlMs, Date.now());
  return token;
}

export function getSessionUser(token) {
  if (!token) return null;
  return db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`
  ).get(sha256(String(token)), Date.now()) ?? null;
}

export function deleteSession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(String(token)));
}

export const deleteExpiredSessions = () => db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());

// ---------------------------------------------------------------- Claude connector keys (one per user)

function setMcpKey(userId, key) {
  db.prepare("UPDATE users SET mcp_key_hash = ?, mcp_key_enc = ? WHERE id = ?")
    .run(sha256(key), encrypt(key, userId), userId);
}

export function rotateMcpKey(userId) {
  const key = "ss_" + crypto.randomBytes(24).toString("base64url");
  setMcpKey(userId, key);
  return key;
}

export function getMcpKey(userId) {
  const row = db.prepare("SELECT mcp_key_enc FROM users WHERE id = ?").get(userId);
  if (!row) throw new Error("User not found");
  return row.mcp_key_enc ? decrypt(row.mcp_key_enc, userId) : rotateMcpKey(userId);
}

export function getUserByMcpKey(key) {
  if (!key) return null;
  return db.prepare("SELECT * FROM users WHERE mcp_key_hash = ?").get(sha256(String(key))) ?? null;
}

// ---------------------------------------------------------------- accounts

export function publicAccount(row) {
  if (!row) return null;
  const { credentials, user_id, ...rest } = row;
  return rest;
}

export function listAccounts(userId) {
  return db.prepare("SELECT * FROM accounts WHERE user_id = ? ORDER BY platform, name").all(userId).map(publicAccount);
}

/** Internal (scheduler): full account with decrypted credentials. Not scoped to a user. */
export function getAccount(id) {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, credentials: JSON.parse(decrypt(row.credentials, row.id)) };
}

export function upsertAccount({ user_id, platform, external_id, name, handle, avatar_url, credentials, token_expires_at }) {
  if (!user_id) throw new Error("upsertAccount needs a user_id");
  const existing = db
    .prepare("SELECT id FROM accounts WHERE user_id = ? AND platform = ? AND external_id = ?")
    .get(user_id, platform, String(external_id));
  const id = existing?.id ?? newId();
  db.prepare(
    `INSERT INTO accounts (id, user_id, platform, external_id, name, handle, avatar_url, credentials, token_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, handle = excluded.handle,
       avatar_url = excluded.avatar_url, credentials = excluded.credentials,
       token_expires_at = excluded.token_expires_at`
  ).run(
    id, user_id, platform, String(external_id), name, handle ?? null, avatar_url ?? null,
    encrypt(JSON.stringify(credentials), id), token_expires_at ?? null, Date.now()
  );
  return id;
}

export function updateAccountCredentials(id, credentials, token_expires_at) {
  db.prepare("UPDATE accounts SET credentials = ?, token_expires_at = ? WHERE id = ?").run(
    encrypt(JSON.stringify(credentials), id), token_expires_at ?? null, id
  );
}

export function deleteAccount(userId, id) {
  return db.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

// ---------------------------------------------------------------- image library

export const countImages = (userId) => db.prepare("SELECT COUNT(*) AS n FROM images WHERE user_id = ?").get(userId).n;

export function addImage({ user_id, name, file, mime, size, source = "upload" }) {
  const id = newId();
  db.prepare(
    "INSERT INTO images (id, user_id, name, file, mime, size, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, user_id, name, file, mime, size, source, Date.now());
  return getImage(user_id, id);
}

/** An image, only if it belongs to this user. */
export function getImage(userId, id) {
  return db.prepare("SELECT * FROM images WHERE id = ? AND user_id = ?").get(String(id), userId) ?? null;
}

/** Newest first. `query` matches any part of the name, ignoring case. */
export function listImages(userId, { query, limit = 500 } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return db.prepare("SELECT * FROM images WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit);
  return db.prepare(
    "SELECT * FROM images WHERE user_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?"
  ).all(userId, "%" + q.replace(/[\\%_]/g, "\\$&") + "%", limit);
}

export function renameImage(userId, id, name) {
  return db.prepare("UPDATE images SET name = ? WHERE id = ? AND user_id = ?").run(name, String(id), userId).changes > 0;
}

export const setImageThumb = (id) => db.prepare("UPDATE images SET has_thumb = 1 WHERE id = ?").run(id);
export const deleteImageRow = (id) => db.prepare("DELETE FROM images WHERE id = ?").run(id);

// ---------------------------------------------------------------- posts

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

/** A post, only if it belongs to this user. */
export function getPost(userId, id) {
  return hydratePost(db.prepare("SELECT * FROM posts WHERE id = ? AND user_id = ?").get(id, userId));
}

/** Internal (scheduler): a post by id, whoever owns it. */
export function getPostById(id) {
  return hydratePost(db.prepare("SELECT * FROM posts WHERE id = ?").get(id));
}

export function listPosts(userId, { status, from, to, limit = 200 } = {}) {
  const where = ["user_id = ?"];
  const args = [userId];
  if (status) { where.push("status = ?"); args.push(status); }
  if (from) { where.push("scheduled_at >= ?"); args.push(from); }
  if (to) { where.push("scheduled_at < ?"); args.push(to); }
  const sql = `SELECT * FROM posts WHERE ${where.join(" AND ")}
               ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit).map(hydratePost);
}

/**
 * targets: [{ account_id, content_override? }]
 * scheduled_at: ms epoch, or null for a draft.
 * Pass `id` to edit an existing post. Both the post and every target account must belong to user_id.
 */
export function savePost({ user_id, id, content, media_url, scheduled_at, targets, source = "web", draft = false }) {
  if (!user_id) throw new Error("savePost needs a user_id");
  const now = Date.now();
  const status = draft || scheduled_at == null ? "draft" : "scheduled";
  const postId = id ?? newId();

  transaction(() => {
    if (id) {
      const existing = db.prepare("SELECT status FROM posts WHERE id = ? AND user_id = ?").get(id, user_id);
      if (!existing) throw new Error("Post not found");
      if (!["draft", "scheduled", "failed"].includes(existing.status)) {
        throw new Error(`Cannot edit a post that is ${existing.status}`);
      }
      db.prepare(
        `UPDATE posts SET content = ?, media_url = ?, scheduled_at = ?, next_attempt_at = NULL, status = ?, updated_at = ?
         WHERE id = ?`
      ).run(content, media_url ?? null, scheduled_at ?? null, status, now, id);
      db.prepare("DELETE FROM post_targets WHERE post_id = ?").run(id);
    } else {
      db.prepare(
        `INSERT INTO posts (id, user_id, content, media_url, scheduled_at, status, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(postId, user_id, content, media_url ?? null, scheduled_at ?? null, status, source, now, now);
    }
    const owns = db.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?");
    const ins = db.prepare("INSERT INTO post_targets (post_id, account_id, content_override) VALUES (?, ?, ?)");
    for (const t of targets) {
      if (!owns.get(String(t.account_id), user_id)) throw new Error(`Unknown account ${t.account_id}`);
      ins.run(postId, String(t.account_id), t.content_override || null);
    }
  });
  return getPost(user_id, postId);
}

export function deletePost(userId, id) {
  const row = db.prepare("SELECT status FROM posts WHERE id = ? AND user_id = ?").get(id, userId);
  if (!row) return false;
  if (row.status === "publishing") throw new Error("Post is publishing right now");
  db.prepare("DELETE FROM posts WHERE id = ?").run(id);
  return true;
}

/**
 * "Post now" / "Retry": make a post due immediately. Targets that already went out stay
 * published; everything else gets a fresh set of attempts.
 */
export function queuePostNow(userId, id) {
  const post = db.prepare("SELECT status FROM posts WHERE id = ? AND user_id = ?").get(id, userId);
  if (!post) throw new Error("Post not found");
  if (!["draft", "scheduled", "failed", "partial"].includes(post.status)) throw new Error(`Post is ${post.status}`);
  const now = Date.now();
  transaction(() => {
    db.prepare("UPDATE post_targets SET status = 'pending', attempts = 0, error = NULL WHERE post_id = ? AND status != 'published'").run(id);
    db.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(now, now, id);
  });
}

// ---------------------------------------------------------------- scheduler queries

/** Atomically claim due posts so a post is never picked up twice. */
export function claimDuePosts(now = Date.now()) {
  const due = db
    .prepare(
      `SELECT id FROM posts WHERE status = 'scheduled' AND COALESCE(next_attempt_at, scheduled_at) <= ?
       ORDER BY COALESCE(next_attempt_at, scheduled_at)`
    )
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

/** Put a post back in the queue for a retry. scheduled_at (what the user picked) is left alone. */
export function scheduleRetry(id, at) {
  db.prepare("UPDATE posts SET status = 'scheduled', next_attempt_at = ?, updated_at = ? WHERE id = ?").run(at, Date.now(), id);
}

export const INTERRUPTED_MESSAGE =
  "SocialSuite stopped while this was being sent, so it may or may not have gone out. Check the account, then press Retry only if the post is not there.";

/**
 * Called on boot. A target still marked 'publishing' means the process died between sending
 * the request to the platform and recording the answer. We cannot know whether the post went
 * out, and sending again could publish it twice, so we stop and let the user decide.
 * Returns the ids of posts that were mid-publish, for the scheduler to settle.
 */
export function recoverInterrupted() {
  const interrupted = db.prepare(
    "UPDATE post_targets SET status = 'failed', error = ? WHERE status = 'publishing'"
  ).run(INTERRUPTED_MESSAGE).changes;
  const posts = db.prepare("SELECT id FROM posts WHERE status = 'publishing'").all().map((r) => r.id);
  return { interrupted, posts };
}
