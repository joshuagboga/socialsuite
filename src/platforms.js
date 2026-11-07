// Each platform exposes:
//   label, limit (chars), kind: "oauth" | "credentials", requiresMedia?
//   oauth: { authorizeUrl(state, redirectUri, pkce), exchange(code, redirectUri, pkce) -> [account] }
//   connect(fields) -> [account]                    (credentials platforms)
//   refresh(account) -> { credentials, token_expires_at } | null
//   publish(account, { text, media, idempotencyKey }) -> { remote_id, remote_url }
// `media` is { url, bytes, mime } when the post has an image, else null.
// `idempotencyKey` is stable for a given post + account + text; pass it on where the platform supports one.
// X also takes { thread, threadIds, onThreadProgress } to post a thread (see x.publish).

import { createHash } from "node:crypto";
import { xLength } from "./xcount.js";

const env = (k) => process.env[k] || "";

class PlatformError extends Error {}
const HTTP_TIMEOUT_MS = 60_000;

async function http(url, { method = "GET", headers = {}, json, form, body } = {}) {
  // Never wait forever: one stuck request would hold up every user's queue.
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers["Content-Type"] = "application/json";
  } else if (form !== undefined) {
    init.body = new URLSearchParams(form);
  } else if (body !== undefined) {
    init.body = body;
  }
  let res, text;
  try {
    res = await fetch(url, init);
    text = await res.text();
  } catch (e) {
    const host = new URL(url).host;
    throw new PlatformError(e.name === "TimeoutError" ? `${host} did not respond in time` : `Could not reach ${host}: ${e.cause?.code || e.message}`);
  }
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error_description || data?.detail || data?.message ||
      (typeof data?.error === "string" ? data.error : null) || text.slice(0, 300);
    throw new PlatformError(`${res.status} ${msg}`);
  }
  return { data, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qs = (o) => new URLSearchParams(o).toString();

// ---------------------------------------------------------------- X (Twitter)

// X_API_URL points the API calls somewhere else (a fake X in the tests, or a proxy).
const X_API = () => (env("X_API_URL") || "https://api.x.com").replace(/\/$/, "");

const x = {
  label: "X (Twitter)",
  limit: 280,
  premiumLimit: 25000, // accounts marked Premium on the Accounts page
  kind: "oauth",
  configured: () => !!env("X_CLIENT_ID"),
  oauth: {
    pkce: true,
    authorizeUrl: (state, redirectUri, challenge) =>
      "https://x.com/i/oauth2/authorize?" + qs({
        response_type: "code",
        client_id: env("X_CLIENT_ID"),
        redirect_uri: redirectUri,
        scope: "tweet.read tweet.write users.read media.write offline.access",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    async exchange(code, redirectUri, verifier) {
      const tok = await xToken({
        grant_type: "authorization_code", code, redirect_uri: redirectUri,
        code_verifier: verifier, client_id: env("X_CLIENT_ID"),
      });
      const { data } = await http(`${X_API()}/2/users/me?user.fields=profile_image_url`, {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      return [{
        platform: "x", external_id: data.data.id, name: data.data.name,
        handle: "@" + data.data.username, avatar_url: data.data.profile_image_url,
        credentials: { access_token: tok.access_token, refresh_token: tok.refresh_token },
        token_expires_at: Date.now() + tok.expires_in * 1000,
      }];
    },
  },
  async refresh(account) {
    const tok = await xToken({
      grant_type: "refresh_token", refresh_token: account.credentials.refresh_token,
      client_id: env("X_CLIENT_ID"),
    });
    return {
      credentials: { access_token: tok.access_token, refresh_token: tok.refresh_token ?? account.credentials.refresh_token },
      token_expires_at: Date.now() + tok.expires_in * 1000,
    };
  },
  /**
   * A single post, or a thread: `text` first (with the image), then each item of `thread` as a
   * reply to the post before it. `threadIds` are posts a previous attempt already sent; they are
   * skipped, so a retry carries on where it stopped. `onThreadProgress(ids)` runs after each post
   * goes out, so the ids can be saved before the next request.
   */
  async publish(account, { text, media, thread = [], threadIds = [], onThreadProgress }) {
    const auth = { Authorization: `Bearer ${account.credentials.access_token}` };
    const handle = (account.handle || "").replace(/^@/, "") || "i";
    const postUrl = (id) => `https://x.com/${handle}/status/${id}`;
    const items = [text, ...thread];
    const ids = threadIds.slice(0, items.length);

    for (let i = ids.length; i < items.length; i++) {
      const payload = { text: items[i] };
      try {
        if (i === 0 && media) {
          const fd = new FormData();
          fd.append("media", new Blob([media.bytes], { type: media.mime }), "upload");
          fd.append("media_category", "tweet_image");
          const { data } = await http(`${X_API()}/2/media/upload`, { method: "POST", headers: auth, body: fd });
          payload.media = { media_ids: [data.data.id] };
        }
        if (i > 0) payload.reply = { in_reply_to_tweet_id: ids[i - 1] };
        const { data } = await http(`${X_API()}/2/tweets`, { method: "POST", headers: auth, json: payload });
        ids.push(data.data.id);
      } catch (err) {
        if (items.length === 1) throw err;
        const sent = i ? ` Posts 1-${i} are live (${postUrl(ids[0])}) and will not be posted again on retry.` : "";
        throw new PlatformError(`Thread post ${i + 1} of ${items.length} failed: ${String(err.message).replace(/\.$/, "")}.${sent}`);
      }
      if (items.length > 1) onThreadProgress?.([...ids]);
    }
    return { remote_id: ids[0], remote_url: postUrl(ids[0]) };
  },
};

async function xToken(form) {
  const headers = {};
  if (env("X_CLIENT_SECRET")) {
    headers.Authorization = "Basic " + Buffer.from(`${env("X_CLIENT_ID")}:${env("X_CLIENT_SECRET")}`).toString("base64");
  }
  const { data } = await http(`${X_API()}/2/oauth2/token`, { method: "POST", headers, form });
  return data;
}

// ---------------------------------------------------------------- LinkedIn

const LI_VERSION = () => env("LINKEDIN_API_VERSION") || "202606";

const linkedin = {
  label: "LinkedIn",
  limit: 3000,
  kind: "oauth",
  configured: () => !!env("LINKEDIN_CLIENT_ID"),
  oauth: {
    authorizeUrl: (state, redirectUri) =>
      "https://www.linkedin.com/oauth/v2/authorization?" + qs({
        response_type: "code",
        client_id: env("LINKEDIN_CLIENT_ID"),
        redirect_uri: redirectUri,
        scope: "openid profile w_member_social",
        state,
      }),
    async exchange(code, redirectUri) {
      const { data: tok } = await http("https://www.linkedin.com/oauth/v2/accessToken", {
        method: "POST",
        form: {
          grant_type: "authorization_code", code, redirect_uri: redirectUri,
          client_id: env("LINKEDIN_CLIENT_ID"), client_secret: env("LINKEDIN_CLIENT_SECRET"),
        },
      });
      const { data: me } = await http("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      return [{
        platform: "linkedin", external_id: me.sub, name: me.name, handle: null, avatar_url: me.picture,
        credentials: { access_token: tok.access_token, refresh_token: tok.refresh_token ?? null, author: `urn:li:person:${me.sub}` },
        token_expires_at: Date.now() + tok.expires_in * 1000,
      }];
    },
  },
  async refresh(account) {
    // Refresh tokens are only issued to approved LinkedIn partners; otherwise reconnect every 60 days.
    if (!account.credentials.refresh_token) return null;
    const { data: tok } = await http("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      form: {
        grant_type: "refresh_token", refresh_token: account.credentials.refresh_token,
        client_id: env("LINKEDIN_CLIENT_ID"), client_secret: env("LINKEDIN_CLIENT_SECRET"),
      },
    });
    return {
      credentials: { ...account.credentials, access_token: tok.access_token, refresh_token: tok.refresh_token ?? account.credentials.refresh_token },
      token_expires_at: Date.now() + tok.expires_in * 1000,
    };
  },
  async publish(account, { text, media }) {
    const headers = {
      Authorization: `Bearer ${account.credentials.access_token}`,
      "LinkedIn-Version": LI_VERSION(),
      "X-Restli-Protocol-Version": "2.0.0",
    };
    const author = account.credentials.author;
    const post = {
      author,
      commentary: escapeLinkedIn(text),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    if (media) {
      const { data } = await http("https://api.linkedin.com/rest/images?action=initializeUpload", {
        method: "POST", headers, json: { initializeUploadRequest: { owner: author } },
      });
      const put = await fetch(data.value.uploadUrl, {
        method: "PUT", headers: { Authorization: headers.Authorization }, body: media.bytes,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!put.ok) throw new PlatformError(`LinkedIn image upload failed (${put.status})`);
      post.content = { media: { id: data.value.image } };
    }
    const { headers: resHeaders } = await http("https://api.linkedin.com/rest/posts", { method: "POST", headers, json: post });
    const urn = resHeaders.get("x-restli-id");
    return { remote_id: urn, remote_url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null };
  },
};

// LinkedIn "little text" format treats these characters as markup.
const escapeLinkedIn = (s) => s.replace(/[\\|{}@\[\]()<>#*_~]/g, (c) => "\\" + c);

// ---------------------------------------------------------------- Meta (Facebook Pages + Instagram)

const GRAPH = "https://graph.facebook.com/v23.0";

// Permissions asked for when someone connects Facebook. Meta rejects the whole login with
// "Invalid Scopes" if the app has not been given one of them, so only Page permissions are
// requested by default. Once your Meta app has the Instagram permissions, turn them on with
// META_INSTAGRAM=true, or set META_SCOPES to an exact comma-separated list.
const PAGE_SCOPES = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "business_management"];
const INSTAGRAM_SCOPES = ["instagram_basic", "instagram_content_publish"];
export function metaScopes() {
  const custom = env("META_SCOPES").split(",").map((x) => x.trim()).filter(Boolean);
  if (custom.length) return custom;
  return /^(true|1|yes|on)$/i.test(env("META_INSTAGRAM")) ? [...PAGE_SCOPES, ...INSTAGRAM_SCOPES] : PAGE_SCOPES;
}

const facebook = {
  label: "Facebook Page",
  limit: 63206,
  kind: "oauth",
  configured: () => !!env("META_APP_ID"),
  oauth: {
    authorizeUrl: (state, redirectUri) =>
      "https://www.facebook.com/v23.0/dialog/oauth?" + qs({
        client_id: env("META_APP_ID"),
        redirect_uri: redirectUri,
        state,
        scope: metaScopes().join(","),
      }),
    async exchange(code, redirectUri) {
      const { data: short } = await http(`${GRAPH}/oauth/access_token?` + qs({
        client_id: env("META_APP_ID"), client_secret: env("META_APP_SECRET"), redirect_uri: redirectUri, code,
      }));
      const { data: long } = await http(`${GRAPH}/oauth/access_token?` + qs({
        grant_type: "fb_exchange_token", client_id: env("META_APP_ID"),
        client_secret: env("META_APP_SECRET"), fb_exchange_token: short.access_token,
      }));
      // Page tokens derived from a long-lived user token do not expire.
      const { data: pages } = await http(`${GRAPH}/me/accounts?` + qs({
        access_token: long.access_token,
        fields: "id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}",
        limit: "100",
      }));
      const accounts = [];
      for (const p of pages.data || []) {
        accounts.push({
          platform: "facebook", external_id: p.id, name: p.name, avatar_url: p.picture?.data?.url,
          credentials: { page_id: p.id, access_token: p.access_token },
        });
        const ig = p.instagram_business_account;
        if (ig) {
          accounts.push({
            platform: "instagram", external_id: ig.id, name: ig.username, handle: "@" + ig.username,
            avatar_url: ig.profile_picture_url,
            credentials: { ig_user_id: ig.id, access_token: p.access_token },
          });
        }
      }
      if (!accounts.length) throw new PlatformError("No Facebook Pages found. You need admin access to a Page.");
      return accounts;
    },
  },
  refresh: async () => null,
  async publish(account, { text, media }) {
    const { page_id, access_token } = account.credentials;
    if (media) {
      const { data } = await http(`${GRAPH}/${page_id}/photos`, {
        method: "POST", form: { url: media.url, caption: text, access_token },
      });
      const id = data.post_id || data.id;
      return { remote_id: id, remote_url: `https://www.facebook.com/${id}` };
    }
    const { data } = await http(`${GRAPH}/${page_id}/feed`, { method: "POST", form: { message: text, access_token } });
    return { remote_id: data.id, remote_url: `https://www.facebook.com/${data.id}` };
  },
};

const instagram = {
  label: "Instagram",
  limit: 2200,
  kind: "oauth",
  requiresMedia: true,
  connectVia: "facebook", // IG business accounts come through the Facebook Page connection
  configured: () => !!env("META_APP_ID"),
  refresh: async () => null,
  async publish(account, { text, media }) {
    if (!media) throw new PlatformError("Instagram posts need an image.");
    const { ig_user_id, access_token } = account.credentials;
    const { data: container } = await http(`${GRAPH}/${ig_user_id}/media`, {
      method: "POST", form: { image_url: media.url, caption: text, access_token },
    });
    await waitForContainer(`${GRAPH}/${container.id}?` + qs({ fields: "status_code", access_token }));
    const { data } = await http(`${GRAPH}/${ig_user_id}/media_publish`, {
      method: "POST", form: { creation_id: container.id, access_token },
    });
    let url = null;
    try {
      const { data: m } = await http(`${GRAPH}/${data.id}?` + qs({ fields: "permalink", access_token }));
      url = m.permalink;
    } catch {}
    return { remote_id: data.id, remote_url: url };
  },
};

async function waitForContainer(statusUrl, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const { data } = await http(statusUrl);
    const s = data.status_code || data.status;
    if (s === "FINISHED" || s === "PUBLISHED") return;
    if (s === "ERROR" || s === "EXPIRED") throw new PlatformError(`Media container ${s}: ${data.error_message || ""}`);
    await sleep(3000);
  }
  throw new PlatformError("Timed out waiting for media to process");
}

// ---------------------------------------------------------------- Threads

const THREADS = "https://graph.threads.net/v1.0";

const threads = {
  label: "Threads",
  limit: 500,
  kind: "oauth",
  configured: () => !!env("THREADS_APP_ID"),
  oauth: {
    authorizeUrl: (state, redirectUri) =>
      "https://threads.net/oauth/authorize?" + qs({
        client_id: env("THREADS_APP_ID"), redirect_uri: redirectUri,
        scope: "threads_basic,threads_content_publish", response_type: "code", state,
      }),
    async exchange(code, redirectUri) {
      const { data: short } = await http("https://graph.threads.net/oauth/access_token", {
        method: "POST",
        form: {
          client_id: env("THREADS_APP_ID"), client_secret: env("THREADS_APP_SECRET"),
          grant_type: "authorization_code", redirect_uri: redirectUri, code,
        },
      });
      const { data: long } = await http("https://graph.threads.net/access_token?" + qs({
        grant_type: "th_exchange_token", client_secret: env("THREADS_APP_SECRET"), access_token: short.access_token,
      }));
      const { data: me } = await http(`${THREADS}/me?` + qs({
        fields: "id,username,threads_profile_picture_url", access_token: long.access_token,
      }));
      return [{
        platform: "threads", external_id: me.id, name: me.username, handle: "@" + me.username,
        avatar_url: me.threads_profile_picture_url,
        credentials: { user_id: me.id, access_token: long.access_token },
        token_expires_at: Date.now() + long.expires_in * 1000,
      }];
    },
  },
  async refresh(account) {
    const { data } = await http("https://graph.threads.net/refresh_access_token?" + qs({
      grant_type: "th_refresh_token", access_token: account.credentials.access_token,
    }));
    return {
      credentials: { ...account.credentials, access_token: data.access_token },
      token_expires_at: Date.now() + data.expires_in * 1000,
    };
  },
  async publish(account, { text, media }) {
    const { access_token } = account.credentials;
    const form = media
      ? { media_type: "IMAGE", image_url: media.url, text, access_token }
      : { media_type: "TEXT", text, access_token };
    const { data: container } = await http(`${THREADS}/me/threads`, { method: "POST", form });
    if (media) await waitForContainer(`${THREADS}/${container.id}?` + qs({ fields: "status,error_message", access_token }));
    const { data } = await http(`${THREADS}/me/threads_publish`, {
      method: "POST", form: { creation_id: container.id, access_token },
    });
    let url = null;
    try {
      const { data: m } = await http(`${THREADS}/${data.id}?` + qs({ fields: "permalink", access_token }));
      url = m.permalink;
    } catch {}
    return { remote_id: data.id, remote_url: url };
  },
};

// ---------------------------------------------------------------- Bluesky

const bluesky = {
  label: "Bluesky",
  limit: 300,
  kind: "credentials",
  configured: () => true,
  fields: [
    { name: "identifier", label: "Handle or email", placeholder: "you.bsky.social" },
    { name: "app_password", label: "App password", type: "password", help: "Settings → Privacy and security → App passwords" },
    { name: "service", label: "PDS URL (optional)", placeholder: "https://bsky.social" },
  ],
  async connect({ identifier, app_password, service }) {
    const svc = (service || "https://bsky.social").replace(/\/$/, "");
    const session = await bskySession(svc, identifier, app_password);
    let avatar = null, name = session.handle;
    try {
      const { data } = await http(`${svc}/xrpc/app.bsky.actor.getProfile?actor=${session.did}`, {
        headers: { Authorization: `Bearer ${session.accessJwt}` },
      });
      avatar = data.avatar; name = data.displayName || session.handle;
    } catch {}
    return [{
      platform: "bluesky", external_id: session.did, name, handle: "@" + session.handle, avatar_url: avatar,
      credentials: { service: svc, identifier, app_password, did: session.did, handle: session.handle },
    }];
  },
  refresh: async () => null,
  async publish(account, { text, media }) {
    const { service, identifier, app_password, did } = account.credentials;
    const s = await bskySession(service, identifier, app_password);
    const auth = { Authorization: `Bearer ${s.accessJwt}` };
    const record = {
      $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString(), facets: bskyFacets(text),
    };
    if (media) {
      const { data } = await http(`${service}/xrpc/com.atproto.repo.uploadBlob`, {
        method: "POST", headers: { ...auth, "Content-Type": media.mime }, body: media.bytes,
      });
      record.embed = { $type: "app.bsky.embed.images", images: [{ alt: "", image: data.blob }] };
    }
    const { data } = await http(`${service}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST", headers: auth, json: { repo: did, collection: "app.bsky.feed.post", record },
    });
    const rkey = data.uri.split("/").pop();
    return { remote_id: data.uri, remote_url: `https://bsky.app/profile/${s.handle}/post/${rkey}` };
  },
};

async function bskySession(service, identifier, password) {
  const { data } = await http(`${service}/xrpc/com.atproto.server.createSession`, {
    method: "POST", json: { identifier, password },
  });
  return data;
}

// Bluesky needs explicit byte-offset facets for links and hashtags to be clickable.
function bskyFacets(text) {
  const enc = new TextEncoder();
  const byteIndex = (i) => enc.encode(text.slice(0, i)).length;
  const facets = [];
  for (const m of text.matchAll(/https?:\/\/[^\s)]+[^\s).,!?:;'"]/g)) {
    facets.push({
      index: { byteStart: byteIndex(m.index), byteEnd: byteIndex(m.index + m[0].length) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }],
    });
  }
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)) {
    const start = m.index + m[1].length;
    facets.push({
      index: { byteStart: byteIndex(start), byteEnd: byteIndex(start + 1 + m[2].length) },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag: m[2] }],
    });
  }
  return facets.length ? facets : undefined;
}

// ---------------------------------------------------------------- Mastodon

const mastodon = {
  label: "Mastodon",
  limit: 500,
  kind: "credentials",
  configured: () => true,
  fields: [
    { name: "instance", label: "Instance URL", placeholder: "https://mastodon.social" },
    { name: "access_token", label: "Access token", type: "password",
      help: "Preferences → Development → New application (scopes: read:accounts write:statuses write:media)" },
  ],
  async connect({ instance, access_token }) {
    const base = instance.replace(/\/$/, "");
    const { data } = await http(`${base}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const host = new URL(base).host;
    return [{
      platform: "mastodon", external_id: `${data.id}@${host}`, name: data.display_name || data.username,
      handle: `@${data.acct}@${host}`, avatar_url: data.avatar,
      credentials: { instance: base, access_token },
    }];
  },
  refresh: async () => null,
  async publish(account, { text, media, idempotencyKey }) {
    const { instance, access_token } = account.credentials;
    const auth = { Authorization: `Bearer ${access_token}` };
    const payload = { status: text };
    if (media) {
      const fd = new FormData();
      fd.append("file", new Blob([media.bytes], { type: media.mime }), "upload");
      const { data } = await http(`${instance}/api/v2/media`, { method: "POST", headers: auth, body: fd });
      payload.media_ids = [data.id];
    }
    const { data } = await http(`${instance}/api/v1/statuses`, {
      method: "POST", headers: { ...auth, "Idempotency-Key": idempotencyKey || crypto.randomUUID() }, json: payload,
    });
    return { remote_id: data.id, remote_url: data.url };
  },
};

// ---------------------------------------------------------------- Binance Square
// Uses Binance Square's official OpenAPI, the same calls as Binance's own square-post skill
// (github.com/binance/binance-skills-hub, skills/binance/square-post/scripts/lib.mjs).
// Auth is one key from the Square Creator Center, sent as X-Square-OpenAPI-Key. The key can only
// publish to Square: it cannot trade, withdraw or read the Binance account.
// Image post: /image/presignedUrl -> PUT the bytes -> poll /image/imageStatus -> /content/add.

// BINANCE_SQUARE_API_URL points the calls somewhere else (a fake Square in the tests).
const SQUARE_API = () => (env("BINANCE_SQUARE_API_URL") || "https://www.binance.com/bapi/composite").replace(/\/$/, "");
const SQUARE_POLL_MS = () => Number(env("BINANCE_SQUARE_POLL_MS")) || 3000;
const SQUARE_POLL_TRIES = 10;

// Codes where trying again cannot help (bad key, banned, content refused), so the post fails
// at once with the reason instead of being retried.
const SQUARE_FINAL_CODES = {
  "10005": "Binance identity verification (KYC) is required to post",
  "20002": "Binance Square refused the text: it contains words it treats as sensitive",
  "20013": "The post is too long for Binance Square",
  "20020": "Binance Square does not accept empty posts",
  "20022": "Binance Square refused the text: it contains words it treats as sensitive",
  "20041": "Binance Square flagged a link in the post as a possible security risk",
  "30004": "Binance could not find the user for this key",
  "30008": "This Binance Square account is restricted from posting",
  "220003": "The Binance Square API key was not found. Create a new one in the Creator Center and reconnect",
  "220004": "The Binance Square API key has expired. Create a new one in the Creator Center and reconnect",
  "220009": "Binance Square's daily limit of 100 API posts is used up; try again tomorrow",
  "220010": "Binance Square does not support this content type",
  "220011": "Binance Square does not accept empty posts",
  "220014": "Binance Square's daily upload limit (400) is used up; try again tomorrow",
  "2000001": "This Binance account is permanently blocked from posting",
  "2000002": "This device is permanently blocked from posting on Binance Square",
};

class SquareError extends PlatformError {
  constructor(message, { code = null, noRetry = false } = {}) {
    super(message);
    this.code = code;
    this.noRetry = noRetry; // the scheduler marks the post failed at once instead of retrying
  }
}

async function squareApi(version, endpoint, apiKey, body) {
  const url = `${SQUARE_API()}/${version}/public/pgc/openApi${endpoint}`;
  const publishing = endpoint === "/content/add";
  let res, raw;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "X-Square-OpenAPI-Key": apiKey, "Content-Type": "application/json", clienttype: "binanceSkill" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    raw = await res.text();
  } catch (e) {
    // A publish request that got no answer may still have gone live, so it is not sent again.
    if (publishing && e.name === "TimeoutError") {
      throw new SquareError("Binance Square did not answer in time. The post may be live: check your Square profile, and press Retry only if it is not there.", { noRetry: true });
    }
    throw new SquareError(`Could not reach Binance Square: ${e.cause?.code || e.message}`);
  }
  // Binance's own skill treats a 504 from /content/add as published without an id.
  if (publishing && res.status === 504) return { id: null, shareLink: null };
  let json;
  try { json = JSON.parse(raw); } catch {
    throw new SquareError(`Binance Square answered ${res.status} ${res.statusText || ""}`.trim());
  }
  if (json.code !== "000000") {
    const code = String(json.code);
    const known = SQUARE_FINAL_CODES[code];
    throw new SquareError(`${known || json.message || "Binance Square error"} [${code}]`, { code, noRetry: !!known });
  }
  return json.data ?? {};
}

const SQUARE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

async function squareUploadImage(apiKey, media) {
  const ext = SQUARE_EXT[media.mime];
  if (!ext) throw new SquareError(`Binance Square takes JPG, PNG, GIF or WebP images, not ${media.mime}`, { noRetry: true });
  const { presignedUrl, fileTicket } = await squareApi("v2", "/image/presignedUrl", apiKey, { imageName: `socialsuite.${ext}` });
  let put;
  try {
    put = await fetch(presignedUrl, {
      method: "PUT", headers: { "Content-Type": media.mime }, body: media.bytes, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new SquareError(`Image upload to Binance Square failed: ${e.cause?.code || e.message}`);
  }
  if (!put.ok) throw new SquareError(`Image upload to Binance Square failed: ${put.status}`);
  for (let i = 0; i < SQUARE_POLL_TRIES; i++) {
    const s = await squareApi("v2", "/image/imageStatus", apiKey, { fileTicket });
    if (s.status === 1) return s.imageUrl;
    if (s.status === 2) throw new SquareError(`Binance Square could not process the image: ${s.failedReason || "unknown reason"}`, { noRetry: true });
    await sleep(SQUARE_POLL_MS());
  }
  throw new SquareError("Binance Square took too long to process the image");
}

const binance_square = {
  label: "Binance Square",
  limit: 4000,
  kind: "credentials",
  configured: () => true,
  fields: [
    { name: "api_key", label: "Square OpenAPI key", type: "password",
      help: "binance.com/square/creator-center/home → Create API Key. It can only post to Square: it cannot trade or withdraw." },
    { name: "name", label: "Your Square name (optional)", placeholder: "Big Josh Codes",
      help: "Binance does not share your profile with apps, so this is just the name shown here." },
  ],
  async connect({ api_key, name }) {
    const key = String(api_key || "").trim();
    if (!key) throw new Error("Square OpenAPI key is required");
    // There is no "who am I" call, so check the key with a publish request that has no text:
    // Binance refuses an empty post, but it says which problem it found first. An unknown or
    // expired key is reported as such; any other answer means the key itself was accepted.
    try {
      await squareApi("v1", "/content/add", key, { contentType: 1, bodyTextOnly: "" });
    } catch (e) {
      if (e.code === "220003" || e.code === "220004" || e.code === "10005") throw e;
      if (!e.code) throw e; // Binance could not be reached: do not save a key we could not check
    }
    const masked = key.length > 9 ? `${key.slice(0, 5)}…${key.slice(-4)}` : "key …" + key.slice(-2);
    return [{
      platform: "binance_square",
      // The key is the only identity Binance gives an app, so a hash of it tells accounts apart.
      external_id: createHash("sha256").update(key).digest("hex").slice(0, 24),
      name: String(name || "").trim() || "Binance Square",
      handle: masked,
      avatar_url: null,
      credentials: { api_key: key },
    }];
  },
  refresh: async () => null,
  async publish(account, { text, media }) {
    const { api_key } = account.credentials;
    const body = { contentType: 1, bodyTextOnly: text };
    if (media) body.imageList = [await squareUploadImage(api_key, media)];
    const data = await squareApi("v1", "/content/add", api_key, body);
    const id = data.id ? String(data.id) : null;
    return {
      remote_id: id,
      remote_url: data.shareLink || (id ? `https://www.binance.com/square/post/${id}` : null),
    };
  },
};

export const platforms = { x, linkedin, facebook, instagram, threads, bluesky, mastodon, binance_square };
export { PlatformError };

/** The character limit for one account: X Premium accounts get the long-post limit. */
export function charLimit(account) {
  const p = platforms[account.platform];
  return account.premium && p.premiumLimit ? p.premiumLimit : p.limit;
}

/** Characters as the platform counts them: X weighs emoji and links (see xcount.js). */
export function countChars(platform, text, limit) {
  return platform === "x" ? xLength(text, limit) : [...text].length;
}

export function platformSummary() {
  return Object.entries(platforms).map(([id, p]) => ({
    id, label: p.label, limit: p.limit, premiumLimit: p.premiumLimit ?? null, kind: p.kind, configured: p.configured(),
    requiresMedia: !!p.requiresMedia, connectVia: p.connectVia ?? null, fields: p.fields ?? null,
  }));
}
