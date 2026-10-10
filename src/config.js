// One place for settings read from the environment, so every module agrees on them.
import "dotenv/config";
import path from "node:path";

export const PORT = Number(process.env.PORT || 3000);
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
export const IS_PROD = process.env.NODE_ENV === "production";
export const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

// Set ALLOW_SIGNUP=false to close registration. The very first account can always be created.
export const ALLOW_SIGNUP = !/^(false|0|no|off)$/i.test(process.env.ALLOW_SIGNUP || "");

// How many reverse proxies sit in front of the app. Rate limits are per IP address, and behind a
// proxy the real address arrives in X-Forwarded-For, which is only safe to read when a proxy we
// trust wrote it. An HTTPS PUBLIC_URL almost always means a proxy terminates TLS, so default to 1.
export const TRUST_PROXY = process.env.TRUST_PROXY !== undefined
  ? (/^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : /^(true|yes|on)$/i.test(process.env.TRUST_PROXY))
  : PUBLIC_URL.startsWith("https") ? 1 : false;

// Some hosts put the visitor's real address in their own header, which is more reliable than
// X-Forwarded-For (Fly.io: "fly-client-ip", Cloudflare: "cf-connecting-ip"). Only set this when
// the app can be reached exclusively through that host's proxy, because the proxy is what
// stops visitors from sending the header themselves.
export const CLIENT_IP_HEADER = (process.env.CLIENT_IP_HEADER || "").trim().toLowerCase();
