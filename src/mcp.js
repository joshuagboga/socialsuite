import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  listAccounts, listPosts, getPost, savePost, deletePost, queuePostNow, getUserByMcpKey, listImages, getImage,
} from "./db.js";
import { publicImage, previewBytes } from "./images.js";
import { platforms } from "./platforms.js";
import { runSchedulerNow } from "./scheduler.js";
import { createLimiter, tooMany } from "./ratelimit.js";

// Every user has their own connector key (see getMcpKey / rotateMcpKey in db.js). The key decides
// whose accounts and posts a request can see; nothing here ever reads another user's data.

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

function summarizePost(p) {
  return {
    id: p.id,
    status: p.status,
    scheduled_at: p.scheduled_at ? new Date(p.scheduled_at).toISOString() : null,
    content: p.content,
    media_url: p.media_url,
    targets: p.targets.map((t) => ({
      account_id: t.account_id, platform: t.platform, account: t.account_handle || t.account_name,
      status: t.status, content_override: t.content_override, url: t.remote_url, error: t.error,
    })),
  };
}

function parseWhen(when) {
  if (!when || when === "now") return Date.now();
  const ms = Date.parse(when);
  if (Number.isNaN(ms)) throw new Error(`Could not parse time "${when}". Use ISO 8601 with a timezone offset.`);
  return ms;
}

/** Resolve account ids and/or platform names to concrete account ids. */
function resolveTargets(userId, account_ids = [], platformNames = []) {
  const accounts = listAccounts(userId);
  const ids = new Set(account_ids);
  for (const id of account_ids) {
    if (!accounts.some((a) => a.id === id)) throw new Error(`Unknown account_id ${id}. Call list_accounts.`);
  }
  for (const name of platformNames) {
    const matches = accounts.filter((a) => a.platform === name);
    if (!matches.length) throw new Error(`No connected ${name} account.`);
    matches.forEach((a) => ids.add(a.id));
  }
  if (!ids.size) throw new Error("Choose at least one account (account_ids) or platform (platforms).");
  return [...ids].map((id) => ({ id, platform: accounts.find((a) => a.id === id).platform }));
}

function checkLimits(targets, content, variants, media_url) {
  const problems = [];
  for (const t of targets) {
    const text = variants?.[t.platform] || content;
    const p = platforms[t.platform];
    if ([...text].length > p.limit) problems.push(`${p.label}: ${[...text].length}/${p.limit} characters`);
    if (p.requiresMedia && !media_url) problems.push(`${p.label}: needs media_url (an image)`);
  }
  return problems;
}

const platformEnum = z.enum(Object.keys(platforms));

function buildServer(user) {
  const userId = user.id;
  const server = new McpServer(
    { name: "socialsuite", version: "1.0.0" },
    {
      instructions:
        "SocialSuite schedules posts to the user's connected social accounts. Call list_accounts first. " +
        "Times are ISO 8601; always include the user's timezone offset. Respect each platform's character limit " +
        "and pass per-platform text in `variants` when one post does not fit everywhere. To attach a picture, call " +
        "list_images to see the user's image library, optionally view_image to look at one, then pass that image's " +
        "`url` as `media_url`. You cannot upload files yourself; if the picture is not in the library, ask the user " +
        "to add it on the Images page of SocialSuite. Confirm the final text, image and time with the user before " +
        "calling schedule_post or publish_now.",
    }
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List connected accounts",
      description: "List the social media accounts connected to SocialSuite, with each platform's character limit.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok(listAccounts(userId).map((a) => ({
        account_id: a.id, platform: a.platform, name: a.name, handle: a.handle,
        char_limit: platforms[a.platform].limit, requires_image: !!platforms[a.platform].requiresMedia,
      })))
  );

  server.registerTool(
    "list_posts",
    {
      title: "List posts",
      description: "List scheduled, draft, published or failed posts. Defaults to upcoming scheduled posts.",
      inputSchema: {
        status: z.enum(["draft", "scheduled", "published", "partial", "failed"]).optional()
          .describe("Filter by status. Defaults to 'scheduled'."),
        from: z.string().optional().describe("ISO time; only posts scheduled at or after this"),
        to: z.string().optional().describe("ISO time; only posts scheduled before this"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status = "scheduled", from, to, limit = 50 }) =>
      ok(listPosts(userId, { status, from: from ? parseWhen(from) : undefined, to: to ? parseWhen(to) : undefined, limit })
        .map(summarizePost))
  );

  server.registerTool(
    "get_post",
    {
      title: "Get post",
      description: "Get one post with per-account publish status, links and errors.",
      inputSchema: { post_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ post_id }) => {
      const p = getPost(userId, post_id);
      return p ? ok(summarizePost(p)) : fail("Post not found");
    }
  );

  const describeImage = (row) => {
    const img = publicImage(row);
    return {
      image_id: img.id, name: img.name, url: img.url, type: img.mime, size_kb: Math.round(img.size / 1024),
      added: new Date(img.created_at).toISOString(), from: img.source === "drive" ? "Google Drive" : "upload",
    };
  };

  server.registerTool(
    "list_images",
    {
      title: "List images",
      description:
        "List the pictures in the user's SocialSuite image library (uploaded or picked from their Google Drive), " +
        "newest first. To attach one to a post, pass its `url` as `media_url`.",
      inputSchema: {
        query: z.string().optional().describe("Only images whose name contains this text"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit = 50 }) => ok(listImages(userId, { query, limit }).map(describeImage))
  );

  server.registerTool(
    "view_image",
    {
      title: "View image",
      description: "Look at one image from the library (a small preview) to check it suits the post before attaching it.",
      inputSchema: { image_id: z.string().describe("image_id from list_images") },
      annotations: { readOnlyHint: true },
    },
    async ({ image_id }) => {
      const row = getImage(userId, image_id);
      if (!row) return fail("Image not found. Call list_images.");
      const preview = previewBytes(row);
      const info = JSON.stringify(describeImage(row), null, 2);
      if (!preview) return ok({ ...describeImage(row), note: "No preview is available for this image; go by its name." });
      return {
        content: [
          { type: "image", data: preview.bytes.toString("base64"), mimeType: preview.mime },
          { type: "text", text: info },
        ],
      };
    }
  );

  const postFields = {
    content: z.string().min(1).describe("Main post text, used for every account without a variant"),
    account_ids: z.array(z.string()).optional().describe("Account ids from list_accounts"),
    platforms: z.array(platformEnum).optional().describe("Post to every connected account on these platforms"),
    variants: z.record(platformEnum, z.string()).optional()
      .describe("Optional per-platform text, e.g. {\"x\": \"short version\"}"),
    media_url: z.string().url().optional()
      .describe("URL of one image to attach (required for Instagram). Use the `url` of an image from list_images, or any public image URL."),
  };

  server.registerTool(
    "schedule_post",
    {
      title: "Schedule post",
      description:
        "Schedule a post to one or more connected accounts at a specific time, or save it as a draft. " +
        "Fails without creating anything if text exceeds a platform's limit.",
      inputSchema: {
        ...postFields,
        scheduled_at: z.string().optional()
          .describe("ISO 8601 time with timezone offset, e.g. 2026-10-12T09:00:00-04:00. Omit with draft=true."),
        draft: z.boolean().optional().describe("Save as a draft instead of scheduling"),
      },
    },
    async ({ content, account_ids, platforms: pf, variants, media_url, scheduled_at, draft }) => {
      try {
        const targets = resolveTargets(userId, account_ids, pf);
        const problems = checkLimits(targets, content, variants, media_url);
        if (problems.length) return fail("Not scheduled. Fix these first:\n" + problems.join("\n"));
        if (!draft && !scheduled_at) return fail("Provide scheduled_at, or set draft=true.");
        const when = draft ? null : parseWhen(scheduled_at);
        if (when && when < Date.now() - 60_000) return fail("scheduled_at is in the past. Use publish_now to post immediately.");
        const post = savePost({
          user_id: userId, content, media_url, scheduled_at: when, draft: !!draft, source: "claude",
          targets: targets.map((t) => ({ account_id: t.id, content_override: variants?.[t.platform] })),
        });
        return ok({ message: draft ? "Draft saved" : "Scheduled", post: summarizePost(post) });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "publish_now",
    {
      title: "Publish now",
      description: "Publish a new post immediately, or publish an existing draft/scheduled post now (pass post_id).",
      inputSchema: {
        post_id: z.string().optional().describe("Existing post to publish now"),
        ...Object.fromEntries(Object.entries(postFields).map(([k, v]) => [k, v.optional()])),
      },
    },
    async ({ post_id, content, account_ids, platforms: pf, variants, media_url }) => {
      try {
        let id = post_id;
        if (id) {
          const p = getPost(userId, id);
          if (!p) return fail("Post not found");
          if (!["draft", "scheduled", "failed", "partial"].includes(p.status)) return fail(`Post is already ${p.status}`);
          queuePostNow(userId, id);
        } else {
          if (!content) return fail("Provide content or post_id.");
          const targets = resolveTargets(userId, account_ids, pf);
          const problems = checkLimits(targets, content, variants, media_url);
          if (problems.length) return fail("Not published. Fix these first:\n" + problems.join("\n"));
          id = savePost({
            user_id: userId, content, media_url, scheduled_at: Date.now(), source: "claude",
            targets: targets.map((t) => ({ account_id: t.id, content_override: variants?.[t.platform] })),
          }).id;
        }
        await runSchedulerNow();
        return ok(summarizePost(getPost(userId, id)));
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "update_post",
    {
      title: "Update post",
      description: "Change the text, time, accounts or image of a draft, scheduled or failed post. Omitted fields keep their current value.",
      inputSchema: {
        post_id: z.string(),
        content: z.string().optional(),
        scheduled_at: z.string().optional().describe("New ISO 8601 time with offset"),
        account_ids: z.array(z.string()).optional(),
        platforms: z.array(platformEnum).optional(),
        variants: z.record(platformEnum, z.string()).optional(),
        media_url: z.string().url().nullable().optional().describe("New image URL, or null to remove it"),
        draft: z.boolean().optional().describe("true to unschedule into a draft"),
      },
    },
    async ({ post_id, content, scheduled_at, account_ids, platforms: pf, variants, media_url, draft }) => {
      try {
        const p = getPost(userId, post_id);
        if (!p) return fail("Post not found");
        const targets = account_ids || pf
          ? resolveTargets(userId, account_ids, pf)
          : p.targets.map((t) => ({ id: t.account_id, platform: t.platform }));
        const newContent = content ?? p.content;
        const newMedia = media_url === undefined ? p.media_url : media_url;
        const oldVariants = Object.fromEntries(p.targets.filter((t) => t.content_override).map((t) => [t.platform, t.content_override]));
        const newVariants = { ...oldVariants, ...variants };
        const problems = checkLimits(targets, newContent, newVariants, newMedia);
        if (problems.length) return fail("Not updated. Fix these first:\n" + problems.join("\n"));
        const when = draft ? null : scheduled_at ? parseWhen(scheduled_at) : p.scheduled_at;
        const post = savePost({
          user_id: userId, id: post_id, content: newContent, media_url: newMedia, scheduled_at: when,
          draft: draft ?? p.status === "draft",
          targets: targets.map((t) => ({ account_id: t.id, content_override: newVariants[t.platform] })),
        });
        return ok({ message: "Updated", post: summarizePost(post) });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "delete_post",
    {
      title: "Delete post",
      description: "Delete a draft or scheduled post so it will not be published. Does not delete anything already live on a platform.",
      inputSchema: { post_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ post_id }) => {
      try {
        return deletePost(userId, post_id) ? ok({ message: "Deleted" }) : fail("Post not found");
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  return server;
}

// Wrong keys: 10 per 15 minutes per IP address, so keys cannot be guessed by brute force.
const badKeyLimiter = createLimiter({ windowMs: 15 * 60_000, max: 10 });
// Valid traffic: 120 requests per minute per user.
const userLimiter = createLimiter({ windowMs: 60_000, max: 120 });

/** Stateless Streamable HTTP endpoint: a fresh server + transport per request. */
export async function handleMcp(req, res) {
  const blocked = badKeyLimiter.check(req.ip);
  if (!blocked.allowed) return tooMany(res, blocked.retryAfter, "Too many failed attempts. Try again later.");

  const given = req.params.key || req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const user = getUserByMcpKey(given);
  if (!user) {
    badKeyLimiter.hit(req.ip);
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }
  const usage = userLimiter.check(user.id);
  if (!usage.allowed) return tooMany(res, usage.retryAfter);
  userLimiter.hit(user.id);

  if (req.method !== "POST") {
    return res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  }
  const server = buildServer(user);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
