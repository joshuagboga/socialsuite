// The image library: pictures a user has uploaded (or imported from Google Drive) to attach to posts.
// Files live in UPLOAD_DIR under a random name and are served publicly at /uploads/<file>, because
// Instagram, Threads and Facebook fetch images by URL. The database row says who owns each one.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PUBLIC_URL, UPLOAD_DIR } from "./config.js";
import { addImage, countImages, getImage, deleteImageRow, setImageThumb, db } from "./db.js";

export const IMAGE_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
export const MAX_IMAGES = 500;
const THUMB = ".thumb.jpg";

export const imageUrl = (file) => `${PUBLIC_URL}/uploads/${file}`;

export function publicImage(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, url: imageUrl(row.file),
    thumb_url: row.has_thumb ? imageUrl(row.file + THUMB) : null,
    mime: row.mime, size: row.size, source: row.source, created_at: row.created_at,
  };
}

/** Keep names short and free of control characters; they are shown in the dashboard and to Claude. */
export function cleanName(name) {
  return String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

export function saveImage({ userId, bytes, mime, name, source }) {
  const ext = IMAGE_TYPES[mime];
  if (!ext || !bytes?.length) throw new Error("Upload a PNG, JPEG, GIF or WebP image (max 8 MB)");
  if (countImages(userId) >= MAX_IMAGES) {
    throw new Error(`Your image library is full (${MAX_IMAGES} images). Delete some before adding more.`);
  }
  const file = crypto.randomUUID() + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), bytes);
  return addImage({
    user_id: userId, file, mime, size: bytes.length,
    name: cleanName(name) || `Image ${new Date().toISOString().slice(0, 10)}`,
    source: source === "drive" ? "drive" : "upload",
  });
}

export function saveThumb(userId, id, bytes) {
  const row = getImage(userId, id);
  if (!row) return null;
  fs.writeFileSync(path.join(UPLOAD_DIR, row.file + THUMB), bytes);
  setImageThumb(row.id);
  return getImage(userId, id);
}

/** Posts that still need this image: deleting it would make them fail when they are due. */
function postsUsing(userId, file) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND media_url LIKE ? ESCAPE '\\'
     AND status IN ('draft', 'scheduled', 'publishing')`
  ).get(userId, "%/uploads/" + file.replace(/[\\%_]/g, "\\$&")).n;
}

export function removeImage(userId, id) {
  const row = getImage(userId, id);
  if (!row) return false;
  const inUse = postsUsing(userId, row.file);
  if (inUse) {
    throw new Error(`This image is attached to ${inUse} draft or scheduled post${inUse === 1 ? "" : "s"}. Remove it from ${inUse === 1 ? "that post" : "those posts"} first.`);
  }
  deleteImageRow(row.id);
  for (const f of [row.file, row.file + THUMB]) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch {}
  }
  return true;
}

/** A small picture of the image for Claude to look at: the thumbnail if there is one, else the original if it is small. */
export function previewBytes(row) {
  const candidates = row.has_thumb ? [[row.file + THUMB, "image/jpeg"]] : [];
  if (row.size <= 1_000_000) candidates.push([row.file, row.mime]);
  for (const [file, mime] of candidates) {
    try { return { bytes: fs.readFileSync(path.join(UPLOAD_DIR, file)), mime }; } catch {}
  }
  return null;
}
