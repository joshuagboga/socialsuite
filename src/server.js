import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, PUBLIC_URL, UPLOAD_DIR, ALLOW_SIGNUP, TRUST_PROXY, IS_PROD, CLIENT_IP_HEADER } from "./config.js";
import {
  listAccounts, upsertAccount, deleteAccount, listPosts, getPost, savePost, deletePost, queuePostNow,
  getMcpKey, rotateMcpKey, publicUser, listImages, getImage, renameImage,
} from "./db.js";
import { IMAGE_TYPES, publicImage, saveImage, saveThumb, removeImage, cleanName } from "./images.js";
import { platforms, platformSummary } from "./platforms.js";
import { startScheduler, stopScheduler, runSchedulerNow } from "./scheduler.js";
import { handleMcp } from "./mcp.js";
import { draftPosts, aiEnabled } from "./ai.js";
import { signUp, checkLogin, startSession, endSession, loadUser, requireUser, hasUsers } from "./auth.js";
import { rateLimit, createLimiter, tooMany } from "./ratelimit.js";

const here = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.set("trust proxy", TRUST_PROXY);
app.disable("x-powered-by");
if (CLIENT_IP_HEADER) {
  // Rate limits key on req.ip, so make it the address the host's proxy reports.
  app.use((req, res, next) => {
    const ip = req.headers[CLIENT_IP_HEADER];
    if (typeof ip === "string" && ip) Object.defineProperty(req, "ip", { value: ip.trim(), configurable: true });
    next();
  });
}
app.use(cookieParser());

// ---------------------------------------------------------------- privacy policy
// Public page. The operator's name and contact address come from .env so the same code can be
// hosted by anyone. Review the text in src/pages/privacy.html before you open sign-ups.
const htmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PRIVACY_UPDATED = "11 October 2026"; // change this when you change the policy text
const privacyPage = fs.readFileSync(path.join(here, "pages", "privacy.html"), "utf8")
  .replaceAll("{{UPDATED}}", PRIVACY_UPDATED)
  .replaceAll("{{SITE}}", htmlEscape(new URL(PUBLIC_URL).host))
  .replaceAll("{{OPERATOR}}", htmlEscape(process.env.OPERATOR_NAME || "the person or team who gave you access to it"))
  .replaceAll("{{CONTACT}}", process.env.CONTACT_EMAIL
    ? `Questions or requests about your data: <a href="mailto:${htmlEscape(process.env.CONTACT_EMAIL)}">${htmlEscape(process.env.CONTACT_EMAIL)}</a>.`
    : "For questions or requests about your data, contact the person or team who gave you access to this site.");
app.get("/privacy", (req, res) => res.type("html").send(privacyPage));

// For load balancers and uptime checks.
app.get("/healthz", (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------- MCP (Claude connector)
// Mounted before the session check: it authenticates with each user's own connector key.
app.all(["/mcp", "/mcp/:key"], express.json({ limit: "2mb" }), (req, res, next) =>
  handleMcp(req, res).catch(next)
);

// ---------------------------------------------------------------- rate limits
// A ceiling on everything under /api and /auth, per IP address. Tighter limits for the
// expensive or guessable endpoints are next to those routes.
app.use(["/api", "/auth"], rateLimit({ windowMs: 60_000, max: 300 }));

app.use(express.json({ limit: "2mb" }));
app.use(loadUser);

// Turn anything a handler throws (sync or async) into a 400 with the message.
const wrap = (fn) => (req, res) =>
  new Promise((resolve) => resolve(fn(req, res))).catch((e) => res.status(400).json({ error: e.message || String(e) }));

// ---------------------------------------------------------------- sign up, log in, log out

const signupAllowed = () => ALLOW_SIGNUP || !hasUsers();

app.get("/api/me", (req, res) =>
  res.json({ user: publicUser(req.user), signupAllowed: signupAllowed(), hasUsers: hasUsers() })
);

app.post("/api/signup",
  rateLimit({ windowMs: 60 * 60_000, max: 20, message: "Too many sign-up attempts from this network. Try again in an hour." }),
  wrap(async (req, res) => {
    if (!signupAllowed()) return res.status(403).json({ error: "Sign-ups are closed on this server" });
    const user = await signUp(req.body || {});
    startSession(res, user);
    res.json({ user: publicUser(user) });
  })
);

// Only failed logins count. Five wrong passwords for the same email from the same address lock
// that pair out for 15 minutes; 30 failures from one address lock the address out, which stops
// someone trying one password against many emails.
const LOGIN_WINDOW = 15 * 60_000;
const loginByPair = createLimiter({ windowMs: LOGIN_WINDOW, max: 5 });
const loginByIp = createLimiter({ windowMs: LOGIN_WINDOW, max: 30 });

app.post("/api/login", wrap(async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const pair = `${req.ip}|${email}`;
  const blocked = [loginByPair.check(pair), loginByIp.check(req.ip)].find((c) => !c.allowed);
  if (blocked) {
    const mins = Math.ceil(blocked.retryAfter / 60);
    return tooMany(res, blocked.retryAfter, `Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
  }
  const user = await checkLogin(email, req.body?.password);
  if (!user) {
    loginByPair.hit(pair);
    loginByIp.hit(req.ip);
    return res.status(401).json({ error: "Wrong email or password" });
  }
  loginByPair.reset(pair);
  startSession(res, user);
  res.json({ user: publicUser(user) });
}));

app.post("/api/logout", (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

// Uploaded media must stay publicly reachable: Instagram, Threads and Facebook fetch it by URL.
// File names are random UUIDs, so a URL cannot be guessed.
app.use("/uploads", express.static(UPLOAD_DIR, {
  maxAge: "7d", setHeaders: (res) => res.set("X-Content-Type-Options", "nosniff"),
}));
app.use(express.static(path.join(here, "..", "public")));

// Everything below needs a signed-in user, and only ever touches req.user's own data.
app.use(["/api", "/auth"], requireUser);

// ---------------------------------------------------------------- platforms & accounts

app.get("/api/platforms", (req, res) => res.json(platformSummary()));
app.get("/api/accounts", (req, res) => res.json(listAccounts(req.user.id)));

app.delete("/api/accounts/:id", (req, res) => {
  deleteAccount(req.user.id, req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
});

app.post("/api/accounts/connect/:platform", wrap(async (req, res) => {
  const p = platforms[req.params.platform];
  if (!p?.connect) throw new Error("This platform connects through OAuth");
  for (const f of p.fields) {
    if (!f.label.includes("optional") && !req.body?.[f.name]) throw new Error(`${f.label} is required`);
  }
  const accounts = await p.connect(req.body);
  res.json({ ids: accounts.map((a) => upsertAccount({ ...a, user_id: req.user.id })) });
}));

// OAuth: state → { platform, verifier, userId } held for 10 minutes.
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
  oauthStates.set(state, { platform: id, verifier, userId: req.user.id, at: Date.now() });
  for (const [k, v] of oauthStates) if (Date.now() - v.at > 10 * 60_000) oauthStates.delete(k);
  res.redirect(p.oauth.authorizeUrl(state, redirectUri(id), challenge));
});

app.get("/auth/:platform/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const saved = oauthStates.get(state);
  oauthStates.delete(state);
  const back = (q) => res.redirect(`/#/accounts?${q}`);
  if (error) return back(`error=${encodeURIComponent(error_description || error)}`);
  // The account is attached to whoever started the flow, and only if they are still the one signed in.
  if (!saved || saved.platform !== req.params.platform || saved.userId !== req.user.id) return back("error=" + encodeURIComponent("Login expired, try again"));
  try {
    const p = platforms[saved.platform];
    const accounts = await p.oauth.exchange(code, redirectUri(saved.platform), saved.verifier);
    accounts.forEach((a) => upsertAccount({ ...a, user_id: req.user.id }));
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
  res.json(listPosts(req.user.id, { status, from: from && Number(from), to: to && Number(to), limit: 500 }));
});

app.get("/api/posts/:id", (req, res) => {
  const p = getPost(req.user.id, req.params.id);
  p ? res.json(p) : res.status(404).json({ error: "Not found" });
});

app.post("/api/posts", wrap((req, res) => res.json(savePost({ ...postInput(req.body), user_id: req.user.id }))));
app.put("/api/posts/:id", wrap((req, res) =>
  res.json(savePost({ ...postInput(req.body), id: req.params.id, user_id: req.user.id }))));

app.delete("/api/posts/:id", wrap((req, res) => {
  deletePost(req.user.id, req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
}));

app.post("/api/posts/:id/publish", wrap(async (req, res) => {
  queuePostNow(req.user.id, req.params.id);
  await runSchedulerNow();
  res.json(getPost(req.user.id, req.params.id));
}));

// ---------------------------------------------------------------- media upload

// The image library. Uploading from the composer and from the Images page both land here, so every
// uploaded picture can be reused and can be attached by Claude through the connector.
const perUser = (req) => req.user.id;
const uploadLimit = rateLimit({ windowMs: 60 * 60_000, max: 120, key: perUser });

function headerText(req, name) {
  try { return decodeURIComponent(String(req.headers[name] || "")); } catch { return ""; }
}

app.get("/api/images", (req, res) => res.json(listImages(req.user.id, { query: req.query.q }).map(publicImage)));

// Body is the raw image. Optional headers: X-File-Name (URL-encoded) and X-Image-Source: drive.
app.post(["/api/images", "/api/upload"], uploadLimit, express.raw({ type: Object.keys(IMAGE_TYPES), limit: "8mb" }), wrap((req, res) => {
  const image = publicImage(saveImage({
    userId: req.user.id, bytes: Buffer.isBuffer(req.body) ? req.body : null, mime: req.headers["content-type"],
    name: headerText(req, "x-file-name"), source: req.headers["x-image-source"],
  }));
  res.json({ url: image.url, image });
}));

// A small JPEG made in the browser, used for the grid and for Claude's preview.
app.put("/api/images/:id/thumb", express.raw({ type: "image/jpeg", limit: "300kb" }), wrap((req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error("Send a JPEG thumbnail (max 300 KB)");
  const row = saveThumb(req.user.id, req.params.id, req.body);
  row ? res.json(publicImage(row)) : res.status(404).json({ error: "Not found" });
}));

app.patch("/api/images/:id", wrap((req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) throw new Error("Give the image a name");
  renameImage(req.user.id, req.params.id, name)
    ? res.json(publicImage(getImage(req.user.id, req.params.id)))
    : res.status(404).json({ error: "Not found" });
}));

app.delete("/api/images/:id", wrap((req, res) => {
  removeImage(req.user.id, req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
}));

// ---------------------------------------------------------------- Claude writing assistant

// Drafting spends the server's Anthropic credit, so each user gets 30 drafts an hour.
const aiLimit = rateLimit({
  windowMs: 60 * 60_000, max: 30, key: perUser, message: "You've used Write with Claude a lot this hour. Try again later.",
});
app.post("/api/ai/draft", aiLimit, wrap(async (req, res) => {
  if (!aiEnabled()) throw new Error("Set ANTHROPIC_API_KEY in .env to use Write with Claude");
  const { brief, draft, platforms: platformIds, tone } = req.body || {};
  if (!brief?.trim() && !draft?.trim()) throw new Error("Describe the post, or write a draft first");
  res.json({ variants: await draftPosts({ brief, draft, platformIds, tone }) });
}));

// ---------------------------------------------------------------- settings

app.get("/api/settings", (req, res) => {
  const key = getMcpKey(req.user.id);
  res.json({
    publicUrl: PUBLIC_URL,
    aiEnabled: aiEnabled(),
    // Both values are public by design: the browser needs them to open Google's file picker.
    google: { clientId: process.env.GOOGLE_CLIENT_ID || "", apiKey: process.env.GOOGLE_API_KEY || "" },
    mcp: { url: `${PUBLIC_URL}/mcp`, key, urlWithKey: `${PUBLIC_URL}/mcp/${key}` },
    redirectUris: Object.fromEntries(
      Object.entries(platforms).filter(([, p]) => p.oauth).map(([id]) => [id, redirectUri(id)])
    ),
  });
});

app.post("/api/settings/rotate-mcp-key", (req, res) => {
  res.json({ key: rotateMcpKey(req.user.id) });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: "Server error" });
});

// Express 5 passes listen errors (e.g. port in use) to this callback instead of throwing.
const server = app.listen(PORT, (err) => {
  if (err) {
    console.error(err.code === "EADDRINUSE"
      ? `Port ${PORT} is already in use. Stop the other process or set PORT in .env.`
      : `Could not start server: ${err.message}`);
    process.exit(1);
  }
  console.log(`SocialSuite running at ${PUBLIC_URL}`);
  if (process.env.APP_PASSWORD) {
    console.warn("APP_PASSWORD is no longer used. People now sign up with their own email and password; remove it from .env.");
  }
  if (IS_PROD && !process.env.CONTACT_EMAIL) {
    console.warn("CONTACT_EMAIL is not set, so the privacy policy at /privacy has no contact address. Add it to your environment.");
  }
  if (!hasUsers()) console.log("No accounts yet. Open the app and sign up to create the first one.");
  startScheduler();
});

// On a deploy or restart the host sends SIGTERM. Finish the publish in progress before exiting,
// so a post is not cut off halfway through being sent.
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, finishing in-flight work…`);
  server.close();
  server.closeIdleConnections?.();
  const giveUp = setTimeout(() => process.exit(1), 25_000);
  giveUp.unref();
  await stopScheduler();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
