// Test helpers: start the real server on a temp data folder, plus a tiny fake Mastodon
// instance so posts can be "published" without touching a real social network.

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "socialsuite-test-"));

const freePort = () => new Promise((resolve) => {
  const s = http.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

export async function startServer({ dataDir = tmpDir(), env = {} } = {}) {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const encryptionKey = env.ENCRYPTION_KEY ?? crypto.randomBytes(32).toString("hex");
  const child = spawn(process.execPath, ["--no-warnings", "src/server.js"], {
    cwd: root,
    env: {
      PATH: process.env.PATH, PORT: String(port), PUBLIC_URL: url, DATA_DIR: dataDir,
      DOTENV_CONFIG_PATH: "/dev/null", ...env, ENCRYPTION_KEY: encryptionKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error("Server exited during startup:\n" + log);
    try { if ((await fetch(url + "/healthz")).ok) break; } catch {}
    if (i > 100) throw new Error("Server did not start:\n" + log);
    await sleep(50);
  }
  return {
    url, dataDir, child, exited, encryptionKey,
    log: () => log,
    async stop(signal = "SIGTERM") { child.kill(signal); await exited; },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 5000, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A signed-in browser, more or less: remembers its session cookie. */
export function client(baseUrl) {
  let cookie = "";
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(baseUrl + path, {
      method, redirect: "manual",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.().find((c) => c.startsWith("ss_session="));
    if (set) cookie = set.split(";")[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, headers: res.headers };
  };
  return {
    cookie: () => cookie,
    get: (p, h) => call("GET", p, undefined, h),
    post: (p, b = {}, h) => call("POST", p, b, h),
    put: (p, b, h) => call("PUT", p, b, h),
    del: (p, h) => call("DELETE", p, undefined, h),
    signUp(email, password = "correct horse battery") { return call("POST", "/api/signup", { email, password, name: email.split("@")[0] }); },
    logIn(email, password = "correct horse battery") { return call("POST", "/api/login", { email, password }); },
  };
}

/**
 * Fake Mastodon. `behavior.status` decides what POST /api/v1/statuses does:
 *   "ok" (default) | "fail" (HTTP 500) | "hang" (never answers)
 */
export async function startFakeMastodon() {
  const posts = []; // every status-create request received
  const media = []; // every image upload received
  const behavior = { status: "ok" };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = raw.toString();
    const json = (code, data) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (req.url === "/api/v1/accounts/verify_credentials") {
      const name = token.split("-")[0]; // a real instance never echoes the token back
      return json(200, { id: name, username: name, acct: name, display_name: name, avatar: null });
    }
    if (req.url === "/api/v2/media" && req.method === "POST") {
      media.push({ token, bytes: raw.length, contentType: req.headers["content-type"], raw });
      return json(200, { id: `media-${media.length}` });
    }
    if (req.url === "/api/v1/statuses" && req.method === "POST") {
      posts.push({ token, text: JSON.parse(body).status, mediaIds: JSON.parse(body).media_ids, idempotencyKey: req.headers["idempotency-key"] });
      if (behavior.status === "hang") return; // leave the request open
      if (behavior.status === "fail") return json(500, { error: "Fake instance is down" });
      return json(200, { id: String(posts.length), url: `${url}/@${token.split("-")[0]}/${posts.length}` });
    }
    json(404, { error: "not found" });
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  return {
    url, posts, media, behavior,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

export async function connectMastodon(c, fake, token) {
  const r = await c.post("/api/accounts/connect/mastodon", { instance: fake.url, access_token: token });
  if (r.status !== 200) throw new Error("connect failed: " + JSON.stringify(r.data));
  return r.data.ids[0];
}

export const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();
