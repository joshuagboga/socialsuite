import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { UPLOAD_DIR } from "./config.js";
import {
  claimDuePosts, getPostById, getAccount, updateTarget, setPostStatus, scheduleRetry,
  updateAccountCredentials, recoverInterrupted, deleteExpiredSessions,
} from "./db.js";
import { platforms } from "./platforms.js";

const TICK_MS = 15_000;
const MAX_ATTEMPTS = 3;
const REFRESH_WINDOW_MS = 5 * 60_000;

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
  const res = await fetch(mediaUrl, { signal: AbortSignal.timeout(30_000) });
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

// Wait before retry n: about 2 minutes, then about 6.
const retryDelay = (attempts) => 2 * 60_000 * attempts ** 1.6;

/**
 * Decide a post's status from its targets once nothing is in flight:
 * still-pending targets -> back in the queue for a retry; otherwise published / partial / failed.
 */
export function settlePost(postId, { retryAt } = {}) {
  const targets = getPostById(postId)?.targets;
  if (!targets) return;
  const published = targets.filter((t) => t.status === "published").length;
  const pending = targets.filter((t) => t.status === "pending");

  if (pending.length) {
    // Retries use next_attempt_at, so the time the user scheduled stays put on the calendar.
    scheduleRetry(postId, retryAt ?? Date.now() + retryDelay(Math.max(1, ...pending.map((t) => t.attempts))));
  } else if (published === targets.length) {
    setPostStatus(postId, "published");
  } else {
    setPostStatus(postId, published ? "partial" : "failed");
  }
}

export async function publishPost(postId) {
  const post = getPostById(postId);
  if (!post) return;
  const log = (...a) => console.log(`[scheduler] post ${postId.slice(0, 8)}`, ...a);

  let media = null;
  let mediaError = null;
  try { media = await loadMedia(post.media_url); } catch (e) { mediaError = e.message; }

  for (const target of post.targets) {
    if (target.status !== "pending") continue; // published, or failed for good
    const attempts = target.attempts + 1;
    try {
      if (mediaError) throw new Error(mediaError);
      let account = getAccount(target.account_id);
      if (!account) throw new Error("Account was disconnected");
      account = await ensureFreshToken(account);
      const text = target.content_override || post.content;

      // Write down that this target is in flight *before* calling the platform. If the process
      // dies before the answer is recorded, boot recovery finds this mark and refuses to resend
      // blindly (see recoverInterrupted) instead of publishing the same post twice.
      updateTarget(postId, target.account_id, { status: "publishing", attempts });
      const result = await platforms[account.platform].publish(account, {
        text, media,
        // Stable per post + account + text, so platforms that support idempotency keys (Mastodon)
        // return the original post instead of creating a duplicate.
        idempotencyKey: crypto.createHash("sha256").update(`${postId}:${target.account_id}:${text}`).digest("hex"),
      });
      updateTarget(postId, target.account_id, {
        status: "published", attempts, error: null, published_at: Date.now(),
        remote_id: result.remote_id ?? null, remote_url: result.remote_url ?? null,
      });
      log(`published to ${account.platform}`);
    } catch (err) {
      // The platform answered with an error (or we never reached it), so retrying is safe.
      const final = attempts >= MAX_ATTEMPTS;
      updateTarget(postId, target.account_id, {
        status: final ? "failed" : "pending", attempts, error: String(err.message || err),
      });
      log(`${target.platform} attempt ${attempts} failed: ${err.message}`);
    }
  }

  settlePost(postId);
}

let timer = null;
let current = null; // the tick in progress, if any

async function runTick() {
  for (const id of claimDuePosts()) {
    try { await publishPost(id); }
    catch (e) { console.error("[scheduler] unexpected error", e); setPostStatus(id, "failed"); }
  }
}

function tick() {
  // One tick at a time. A caller that arrives mid-tick waits for it, then runs its own so that
  // anything it just queued ("Post now") is picked up before it gets its answer.
  const next = (current ?? Promise.resolve()).then(runTick);
  const mine = next.catch((e) => console.error("[scheduler] tick failed", e)).finally(() => {
    if (current === mine) current = null;
  });
  current = mine;
  return mine;
}

export function startScheduler() {
  const { interrupted, posts } = recoverInterrupted();
  // Other targets of an interrupted post were not in flight, so they can carry on right away.
  for (const id of posts) settlePost(id, { retryAt: Date.now() });
  if (interrupted) {
    console.warn(`[scheduler] ${interrupted} send(s) were interrupted by a restart and need a manual check (see the Failed tab).`);
  }
  let ticks = 0;
  timer = setInterval(() => {
    if (!current) tick();
    if (++ticks % 240 === 0) deleteExpiredSessions(); // about once an hour
  }, TICK_MS);
  tick();
  console.log(`[scheduler] running every ${TICK_MS / 1000}s`);
}

/** Stop picking up new posts and wait for any publish in progress to finish. */
export async function stopScheduler() {
  clearInterval(timer);
  timer = null;
  await current;
}

/** Run a tick immediately (used by "Post now"). */
export const runSchedulerNow = () => tick();
