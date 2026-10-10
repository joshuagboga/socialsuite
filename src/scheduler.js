import fs from "node:fs/promises";
import path from "node:path";
import {
  db, claimDuePosts, getPost, getAccount, updateTarget, setPostStatus,
  updateAccountCredentials, recoverStuckPosts,
} from "./db.js";
import { platforms } from "./platforms.js";

const TICK_MS = 15_000;
const MAX_ATTEMPTS = 3;
const REFRESH_WINDOW_MS = 5 * 60_000;
export const UPLOAD_DIR = path.resolve(process.env.DATA_DIR || "./data", "uploads");

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

async function loadMedia(mediaUrl) {
  if (!mediaUrl) return null;
  // Files uploaded through this app: read from disk; platforms that fetch by URL still get the public URL.
  const local = mediaUrl.match(/\/uploads\/([\w.-]+)$/);
  if (local) {
    try {
      const bytes = await fs.readFile(path.join(UPLOAD_DIR, local[1]));
      return { url: mediaUrl, bytes, mime: MIME[path.extname(local[1]).toLowerCase()] || "application/octet-stream" };
    } catch {}
  }
  const res = await fetch(mediaUrl);
  if (!res.ok) throw new Error(`Could not download media (${res.status})`);
  return {
    url: mediaUrl,
    bytes: Buffer.from(await res.arrayBuffer()),
    mime: res.headers.get("content-type")?.split(";")[0] || "image/jpeg",
  };
}

async function ensureFreshToken(account) {
  const p = platforms[account.platform];
  if (!account.token_expires_at || account.token_expires_at - Date.now() > REFRESH_WINDOW_MS) return account;
  const refreshed = await p.refresh(account);
  if (!refreshed) {
    if (account.token_expires_at < Date.now()) {
      throw new Error("Access token expired — reconnect this account.");
    }
    return account;
  }
  updateAccountCredentials(account.id, refreshed.credentials, refreshed.token_expires_at);
  return { ...account, ...refreshed };
}

export async function publishPost(postId) {
  const post = getPost(postId);
  if (!post) return;
  const log = (...a) => console.log(`[scheduler] post ${postId.slice(0, 8)}`, ...a);

  let media = null;
  let mediaError = null;
  try { media = await loadMedia(post.media_url); } catch (e) { mediaError = e.message; }

  for (const target of post.targets) {
    if (target.status === "published") continue;
    const attempts = target.attempts + 1;
    try {
      if (mediaError) throw new Error(mediaError);
      let account = getAccount(target.account_id);
      if (!account) throw new Error("Account was disconnected");
      account = await ensureFreshToken(account);
      const text = target.content_override || post.content;
      const result = await platforms[account.platform].publish(account, { text, media });
      updateTarget(postId, target.account_id, {
        status: "published", attempts, error: null, published_at: Date.now(),
        remote_id: result.remote_id ?? null, remote_url: result.remote_url ?? null,
      });
      log(`published to ${account.platform}`);
    } catch (err) {
      const final = attempts >= MAX_ATTEMPTS;
      updateTarget(postId, target.account_id, {
        status: final ? "failed" : "pending", attempts, error: String(err.message || err),
      });
      log(`${target.platform} attempt ${attempts} failed: ${err.message}`);
    }
  }

  const targets = getPost(postId).targets;
  const published = targets.filter((t) => t.status === "published").length;
  const pending = targets.filter((t) => t.status === "pending").length;

  if (pending) {
    // Retry remaining targets with backoff: 2 min, then 6 min.
    const maxAttempts = Math.max(...targets.filter((t) => t.status === "pending").map((t) => t.attempts));
    db.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?")
      .run(Date.now() + 2 * 60_000 * maxAttempts ** 1.6, Date.now(), postId);
  } else if (published === targets.length) {
    setPostStatus(postId, "published");
  } else {
    setPostStatus(postId, published ? "partial" : "failed");
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    for (const id of claimDuePosts()) {
      try { await publishPost(id); }
      catch (e) { console.error("[scheduler] unexpected error", e); setPostStatus(id, "failed"); }
    }
  } finally {
    running = false;
  }
}

export function startScheduler() {
  recoverStuckPosts();
  setInterval(tick, TICK_MS).unref?.();
  tick();
  console.log(`[scheduler] running every ${TICK_MS / 1000}s`);
}

/** Run a tick immediately (used by "Post now"). */
export const runSchedulerNow = () => tick();
