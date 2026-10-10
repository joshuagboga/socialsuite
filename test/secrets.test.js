import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
const { encrypt, decrypt, isEncrypted } = await import("../src/secrets.js");

test("encrypts and decrypts", () => {
  const secret = JSON.stringify({ access_token: "tok_123", refresh_token: "ref_456" });
  const stored = encrypt(secret, "account-1");
  assert.ok(isEncrypted(stored));
  assert.ok(!stored.includes("tok_123"));
  assert.equal(decrypt(stored, "account-1"), secret);
});

test("the same value encrypts differently each time", () => {
  assert.notEqual(encrypt("same", "a"), encrypt("same", "a"));
});

test("a value moved to another row will not decrypt", () => {
  assert.throws(() => decrypt(encrypt("secret", "account-1"), "account-2"), /Could not decrypt/);
});

test("tampering is detected", () => {
  const stored = encrypt("secret", "a");
  const flipped = stored.slice(0, -2) + (stored.at(-2) === "A" ? "B" : "A") + stored.at(-1);
  assert.throws(() => decrypt(flipped, "a"), /Could not decrypt/);
});

test("refuses plain text", () => {
  assert.throws(() => decrypt('{"access_token":"x"}', "a"), /not encrypted/);
});
