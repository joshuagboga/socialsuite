// Sign-up, login and sessions.
//
// Passwords are hashed with scrypt (built into Node, deliberately slow to make guessing costly).
// A session is a random token in an HttpOnly cookie; the database only keeps its SHA-256 hash,
// so someone who reads the database cannot log in as anyone.

import crypto from "node:crypto";
import { promisify } from "node:util";
import { PUBLIC_URL } from "./config.js";
import {
  createUser, getUserByEmail, getSessionUser, createSession, deleteSession, countUsers, setUserPassword,
} from "./db.js";

const scrypt = promisify(crypto.scrypt);
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32;
const SCRYPT_OPTS = { N, r: R, p: P, maxmem: 128 * N * R * 2 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, n, r, p, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt") return false;
  const want = Buffer.from(hash, "base64url");
  const got = await scrypt(password, Buffer.from(salt, "base64url"), want.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return crypto.timingSafeEqual(want, got);
}

// Compared against when the email is unknown, so "no such user" takes as long as "wrong password".
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 8;

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  }
  if (password.length > 200) throw new Error("Password is too long");
}

export async function signUp({ email, password, name }) {
  email = String(email ?? "").trim().toLowerCase();
  name = String(name ?? "").trim().slice(0, 80) || email.split("@")[0];
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error("Enter a valid email address");
  validatePassword(password);
  if (getUserByEmail(email)) throw new Error("An account with that email already exists");
  return createUser({ email, name, password_hash: await hashPassword(password) });
}

/** Returns the user, or null if the email or password is wrong. */
export async function checkLogin(email, password) {
  const user = getUserByEmail(String(email ?? "").trim().toLowerCase());
  const ok = await verifyPassword(String(password ?? ""), user?.password_hash ?? (await DUMMY_HASH));
  return user && ok ? user : null;
}

export async function resetPassword(email, password) {
  validatePassword(password);
  const user = getUserByEmail(email);
  if (!user) throw new Error(`No account with email ${email}`);
  setUserPassword(user.id, await hashPassword(password));
  return user;
}

// ---------------------------------------------------------------- session cookie

const COOKIE = "ss_session";
const SESSION_DAYS = 30;
const cookieOptions = { httpOnly: true, sameSite: "lax", secure: PUBLIC_URL.startsWith("https"), path: "/" };

export function startSession(res, user) {
  const token = createSession(user.id, SESSION_DAYS * 864e5);
  res.cookie(COOKIE, token, { ...cookieOptions, maxAge: SESSION_DAYS * 864e5 });
}

export function endSession(req, res) {
  deleteSession(req.cookies?.[COOKIE]);
  res.clearCookie(COOKIE, cookieOptions);
}

/** Sets req.user (or null) on every request. */
export function loadUser(req, res, next) {
  req.user = getSessionUser(req.cookies?.[COOKIE]);
  next();
}

export function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.originalUrl.startsWith("/auth/")) return res.redirect("/");
  res.status(401).json({ error: "Not logged in" });
}

export const hasUsers = () => countUsers() > 0;
