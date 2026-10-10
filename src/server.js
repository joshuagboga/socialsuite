import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listAccounts, upsertAccount, deleteAccount, listPosts, getPost, savePost, deletePost,
  getSetting, setSetting, db,
} from "./db.js";
import { platforms, platformSummary } from "./platforms.js";
import { startScheduler, runSchedulerNow, UPLOAD_DIR } from "./scheduler.js";
import { handleMcp, getMcpKey, rotateMcpKey } from "./mcp.js";
import { draftPosts, aiEnabled } from "./ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const APP_PASSWORD = process.env.APP_PASSWORD || "";

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.set("trust proxy", 1);
app.use(cookieParser());

// ---------------------------------------------------------------- MCP (Claude connector)
// Mounted before the session check: it authenticates with its own API key.
app.all(["/mcp", "/mcp/:key"], express.json({ limit: "2mb" }), (req, res, next) =>
  handleMcp(req, res).catch(next)
);

app.use(express.json({ limit: "2mb" }));

// ---------------------------------------------------------------- session auth

const SESSION_SECRET = process.env.SESSION_SECRET || getSetting("session_secret") || (() => {
  const s = crypto.randomBytes(32).toString("hex");
  setSetting("session_secret", s);
  return s;
})();
const sign = (v) => v + "." + crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("base64url");
const verify = (signed) => {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  const v = signed.slice(0, i);
  const expected = Buffer.from(sign(v));
  const given = Buffer.from(signed);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? v : null;
};
const SESSION_DAYS = 30;

function isLoggedIn(req) {
  if (!APP_PASSWORD) return true;
  const v = verify(req.cookies.ss_session);
  return !!v && Number(v) > Date.now();
}

app.post("/api/login", (req, res) => {
  const given = Buffer.from(String(req.body?.password ?? ""));
  const want = Buffer.from(APP_PASSWORD);
  if (!APP_PASSWORD || (given.length === want.length && crypto.timingSafeEqual(given, want))) {
    const exp = Date.now() + SESSION_DAYS * 864e5;
    res.cookie("ss_session", sign(String(exp)), {
      httpOnly: true, sameSite: "lax", secure: PUBLIC_URL.startsWith("https"), maxAge: SESSION_DAYS * 864e5,
    });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Wrong password" });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("ss_session");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => res.json({ loggedIn: isLoggedIn(req), passwordRequired: !!APP_PASSWORD }));

// Uploaded media must stay publicly reachable: Instagram, Threads and Facebook fetch it by URL.
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d" }));
app.use(express.static(path.join(here, "..", "public")));

const requireAuth = (req, res, next) => {
  if (isLoggedIn(req)) return next();
  if (req.path.startsWith("/auth/")) return res.redirect("/");
  res.status(401).json({ error: "Not logged in" });
};
app.use(["/api", "/auth"], requireAuth);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message || String(e) }));

// ---------------------------------------------------------------- platforms & accounts

app.get("/api/platforms", (req, res) => res.json(platformSummary()));
app.get("/api/accounts", (req, res) => res.json(listAccounts()));

app.delete("/api/accounts/:id", (req, res) => {
  deleteAccount(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
});

app.post("/api/accounts/connect/:platform", wrap(async (req, res) => {
  const p = platforms[req.params.platform];
  if (!p?.connect) throw new Error("This platform connects through OAuth");
  for (const f of p.fields) {
    if (!f.label.includes("optional") && !req.body?.[f.name]) throw new Error(`${f.label} is required`);
  }
  const accounts = await p.connect(req.body);
  res.json({ ids: accounts.map(upsertAccount) });
}));

// OAuth: state → { platform, verifier } held for 10 minutes.
const oauthStates = new Map();
const redirectUri = (platform) => `${PUBLIC_URL}/auth/${platform}/callback`;

app.get("/auth/:platform/start", (req, res) => {
  const id = platforms[req.params.platform]?.connectVia || req.params.platform;
  const p = platforms[id];
  if (!p?.oauth) return res.status(404).send("Unknown platform");
  if (!p.configured()) return res.redirect(`/#/accounts?error=${encodeURIComponent(`${p.label} app credentials are not set in .env`)}`);
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  oauthStates.set(state, { platform: id, verifier, at: Date.now() });
  for (const [k, v] of oauthStates) if (Date.now() - v.at > 10 * 60_000) oauthStates.delete(k);
  res.redirect(p.oauth.authorizeUrl(state, redirectUri(id), challenge));
});

app.get("/auth/:platform/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const saved = oauthStates.get(state);
  oauthStates.delete(state);
  const back = (q) => res.redirect(`/#/accounts?${q}`);
  if (error) return back(`error=${encodeURIComponent(error_description || error)}`);
  if (!saved || saved.platform !== req.params.platform) return back("error=" + encodeURIComponent("Login expired, try again"));
  try {
    const p = platforms[saved.platform];
    const accounts = await p.oauth.exchange(code, redirectUri(saved.platform), saved.verifier);
    accounts.forEach(upsertAccount);
    back(`connected=${accounts.length}`);
  } catch (e) {
    console.error("[oauth]", saved.platform, e);
    back("error=" + encodeURIComponent(e.message));
  }
});

// ---------------------------------------------------------------- posts

function postInput(body) {
  const { content, media_url, scheduled_at, targets, draft } = body || {};
  if (!content?.trim()) throw new Error("Post text is empty");
  if (!Array.isArray(targets) || !targets.length) throw new Error("Pick at least one account");
  const when = scheduled_at ? Date.parse(scheduled_at) : null;
  if (scheduled_at && Number.isNaN(when)) throw new Error("Invalid schedule time");
  if (!draft && !when) throw new Error("Pick a time, or save as draft");
  if (!draft && when < Date.now() - 60_000) throw new Error("That time is in the past");
  return { content, media_url: media_url || null, scheduled_at: when, targets, draft: !!draft };
}

app.get("/api/posts", (req, res) => {
  const { status, from, to } = req.query;
  res.json(listPosts({ status, from: from && Number(from), to: to && Number(to), limit: 500 }));
});

app.get("/api/posts/:id", (req, res) => {
  const p = getPost(req.params.id);
  p ? res.json(p) : res.status(404).json({ error: "Not found" });
});

app.post("/api/posts", wrap((req, res) => res.json(savePost(postInput(req.body)))));
app.put("/api/posts/:id", wrap((req, res) => res.json(savePost({ id: req.params.id, ...postInput(req.body) }))));

app.delete("/api/posts/:id", wrap((req, res) => {
  deletePost(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
}));

app.post("/api/posts/:id/publish", wrap(async (req, res) => {
  const p = getPost(req.params.id);
  if (!p) throw new Error("Not found");
  if (!["draft", "scheduled", "failed", "partial"].includes(p.status)) throw new Error(`Post is ${p.status}`);
  db.prepare("UPDATE post_targets SET status='pending', attempts=0, error=NULL WHERE post_id=? AND status!='published'").run(p.id);
  db.prepare("UPDATE posts SET status='scheduled', scheduled_at=?, updated_at=? WHERE id=?").run(Date.now(), Date.now(), p.id);
  await runSchedulerNow();
  res.json(getPost(p.id));
}));

// ---------------------------------------------------------------- media upload

const EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
app.post("/api/upload", express.raw({ type: Object.keys(EXT), limit: "8mb" }), (req, res) => {
  const ext = EXT[req.headers["content-type"]];
  if (!ext || !req.body?.length) return res.status(400).json({ error: "Upload a PNG, JPEG, GIF or WebP image (max 8 MB)" });
  const name = crypto.randomUUID() + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
  res.json({ url: `${PUBLIC_URL}/uploads/${name}` });
});

// ---------------------------------------------------------------- Claude writing assistant

app.post("/api/ai/draft", wrap(async (req, res) => {
  if (!aiEnabled()) throw new Error("Set ANTHROPIC_API_KEY in .env to use Write with Claude");
  const { brief, draft, platforms: platformIds, tone } = req.body || {};
  if (!brief?.trim() && !draft?.trim()) throw new Error("Describe the post, or write a draft first");
  res.json({ variants: await draftPosts({ brief, draft, platformIds, tone }) });
}));

// ---------------------------------------------------------------- settings

app.get("/api/settings", (req, res) => {
  const key = getMcpKey();
  res.json({
    publicUrl: PUBLIC_URL,
    aiEnabled: aiEnabled(),
    mcp: { url: `${PUBLIC_URL}/mcp`, key, urlWithKey: `${PUBLIC_URL}/mcp/${key}`, fromEnv: !!process.env.MCP_API_KEY },
    redirectUris: Object.fromEntries(
      Object.entries(platforms).filter(([, p]) => p.oauth).map(([id]) => [id, redirectUri(id)])
    ),
  });
});

app.post("/api/settings/rotate-mcp-key", (req, res) => {
  if (process.env.MCP_API_KEY) return res.status(400).json({ error: "MCP_API_KEY is set in .env; change it there" });
  res.json({ key: rotateMcpKey() });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: "Server error" });
});

// Express 5 passes listen errors (e.g. port in use) to this callback instead of throwing.
app.listen(PORT, (err) => {
  if (err) {
    console.error(err.code === "EADDRINUSE"
      ? `Port ${PORT} is already in use. Stop the other process or set PORT in .env.`
      : `Could not start server: ${err.message}`);
    process.exit(1);
  }
  console.log(`SocialSuite running at ${PUBLIC_URL}`);
  if (!APP_PASSWORD) console.warn("⚠  APP_PASSWORD is not set — anyone who can reach this server can use it.");
  startScheduler();
});
