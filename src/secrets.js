// Encryption for secrets stored in the database (platform tokens, app passwords, connector keys).
//
// AES-256-GCM: each value gets a fresh random 12-byte IV, and the 16-byte auth tag makes any
// tampering fail on decrypt. Stored as "enc:v1:" + base64url(iv | tag | ciphertext).
// `context` (e.g. the account id) is bound in as additional authenticated data, so a ciphertext
// copied onto a different row will not decrypt.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, IS_PROD } from "./config.js";

const PREFIX = "enc:v1:";
const HOW_TO = `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

function parseKey(value) {
  const v = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be 32 bytes (64 hex characters). Generate one with:\n  ${HOW_TO}`);
  }
  return key;
}

function loadKey() {
  if (process.env.ENCRYPTION_KEY) return parseKey(process.env.ENCRYPTION_KEY);
  if (IS_PROD) {
    throw new Error(
      `ENCRYPTION_KEY is not set. It encrypts the social account tokens in the database.\n` +
      `Generate one and add it to your environment:\n  ${HOW_TO}\n` +
      `Keep it safe: if you lose it, every account has to be reconnected.`
    );
  }
  // Development convenience: keep a generated key next to the database so restarts still decrypt.
  // In production the key must come from the environment, so a leaked database file or backup
  // does not also contain the key that unlocks it.
  const file = path.join(DATA_DIR, "encryption.key");
  try {
    return parseKey(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, key.toString("hex") + "\n", { mode: 0o600 });
  console.warn(`[secrets] ENCRYPTION_KEY is not set; generated a development key at ${file}. Set ENCRYPTION_KEY before deploying.`);
  return key;
}

let key;
const getKey = () => (key ??= loadKey());

/** Fail at startup, not at the first token read, if the key is missing or malformed. */
export const assertEncryptionReady = () => void getKey();

export const isEncrypted = (value) => typeof value === "string" && value.startsWith(PREFIX);

export function encrypt(plaintext, context = "") {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  cipher.setAAD(Buffer.from(String(context)));
  const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function decrypt(value, context = "") {
  if (!isEncrypted(value)) throw new Error("Value is not encrypted");
  const raw = Buffer.from(value.slice(PREFIX.length), "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(String(context)));
  decipher.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Could not decrypt a stored secret. ENCRYPTION_KEY does not match the one this data was saved with.");
  }
}
