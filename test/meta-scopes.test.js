import { test } from "node:test";
import assert from "node:assert/strict";
import { metaScopes, platforms } from "../src/platforms.js";

const reset = () => { delete process.env.META_SCOPES; delete process.env.META_INSTAGRAM; };

test("Facebook asks for Page permissions only by default", () => {
  reset();
  assert.deepEqual(metaScopes(), ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "business_management"]);
  const url = new URL(platforms.facebook.oauth.authorizeUrl("state", "https://example.com/auth/facebook/callback"));
  assert.ok(!url.searchParams.get("scope").includes("instagram"));
});

test("META_INSTAGRAM=true adds the Instagram permissions", () => {
  reset();
  process.env.META_INSTAGRAM = "true";
  assert.ok(metaScopes().includes("instagram_basic") && metaScopes().includes("instagram_content_publish"));
  reset();
});

test("META_SCOPES overrides the list", () => {
  reset();
  process.env.META_SCOPES = " pages_show_list , pages_manage_posts ";
  assert.deepEqual(metaScopes(), ["pages_show_list", "pages_manage_posts"]);
  reset();
});
