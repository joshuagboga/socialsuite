// Each platform exposes:
//   label, limit (chars), kind: "oauth" | "credentials", requiresMedia?
//   oauth: { authorizeUrl(state, redirectUri, pkce), exchange(code, redirectUri, pkce) -> [account] }
//   connect(fields) -> [account]                    (credentials platforms)
//   refresh(account) -> { credentials, token_expires_at } | null
//   publish(account, { text, media }) -> { remote_id, remote_url }
// `media` is { url, bytes, mime } when the post has an image, else null.

const env = (k) => process.env[k] || "";

class PlatformError extends Error {}

async function http(url, { method = "GET", headers = {}, json, form, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers["Content-Type"] = "application/json";
  } else if (form !== undefined) {
    init.body = new URLSearchParams(form);
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(url, init);
  const text = await res.text();
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

const x = {
  label: "X (Twitter)",
  limit: 280,
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
      const { data } = await http("https://api.x.com/2/users/me?user.fields=profile_image_url", {
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
  async publish(account, { text, media }) {
    const auth = { Authorization: `Bearer ${account.credentials.access_token}` };
    const payload = { text };
    if (media) {
      const fd = new FormData();
      fd.append("media", new Blob([media.bytes], { type: media.mime }), "upload");
      fd.append("media_category", "tweet_image");
      const { data } = await http("https://api.x.com/2/media/upload", { method: "POST", headers: auth, body: fd });
      payload.media = { media_ids: [data.data.id] };
    }
    const { data } = await http("https://api.x.com/2/tweets", { method: "POST", headers: auth, json: payload });
    const handle = (account.handle || "").replace(/^@/, "") || "i";
    return { remote_id: data.data.id, remote_url: `https://x.com/${handle}/status/${data.data.id}` };
  },
};

async function xToken(form) {
  const headers = {};
  if (env("X_CLIENT_SECRET")) {
    headers.Authorization = "Basic " + Buffer.from(`${env("X_CLIENT_ID")}:${env("X_CLIENT_SECRET")}`).toString("base64");
  }
  const { data } = await http("https://api.x.com/2/oauth2/token", { method: "POST", headers, form });
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
        scope: [
          "pages_show_list", "pages_manage_posts", "pages_read_engagement", "business_management",
          "instagram_basic", "instagram_content_publish",
        ].join(","),
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
  async publish(account, { text, media }) {
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
      method: "POST", headers: { ...auth, "Idempotency-Key": crypto.randomUUID() }, json: payload,
    });
    return { remote_id: data.id, remote_url: data.url };
  },
};

export const platforms = { x, linkedin, facebook, instagram, threads, bluesky, mastodon };
export { PlatformError };

export function platformSummary() {
  return Object.entries(platforms).map(([id, p]) => ({
    id, label: p.label, limit: p.limit, kind: p.kind, configured: p.configured(),
    requiresMedia: !!p.requiresMedia, connectVia: p.connectVia ?? null, fields: p.fields ?? null,
  }));
}
