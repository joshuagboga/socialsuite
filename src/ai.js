import Anthropic from "@anthropic-ai/sdk";
import { platforms } from "./platforms.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

let client;
const getClient = () => (client ??= new Anthropic());

export const aiEnabled = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const SYSTEM = `You write social media posts for the user of a post scheduler.
Write in the user's voice: natural and specific, not salesy, no filler phrases like "Exciting news!" unless asked.
Adapt each version to the platform's culture and hard character limit — never exceed the limit.
Use hashtags sparingly and only where they fit the platform (rarely on X or LinkedIn, more on Instagram).
Do not invent facts, stats, links or quotes that the user did not provide.`;

const SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          platform: { type: "string" },
          text: { type: "string" },
        },
        required: ["platform", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["variants"],
  additionalProperties: false,
};

/**
 * mode: "write" (from a brief) | "rewrite" (improve the given draft)
 * Returns [{ platform, text }] — one per requested platform.
 */
export async function draftPosts({ brief, draft, platformIds, tone }) {
  const ids = [...new Set(platformIds)].filter((id) => platforms[id]);
  if (!ids.length) throw new Error("Pick at least one platform");

  const targets = ids.map((id) => `- ${id}: ${platforms[id].label}, max ${platforms[id].limit} characters`).join("\n");
  const parts = [];
  if (brief) parts.push(`What the post is about:\n${brief}`);
  if (draft) parts.push(`My current draft (keep its meaning; improve and adapt it):\n${draft}`);
  if (tone) parts.push(`Tone: ${tone}`);
  parts.push(`Write one version for each of these platforms, using the platform id exactly as given:\n${targets}`);

  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: SCHEMA },
    },
    system: SYSTEM,
    messages: [{ role: "user", content: parts.join("\n\n") }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to write this post. Try rephrasing the brief.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude's response was cut off. Try a shorter brief.");
  }
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const { variants } = JSON.parse(text);
  return variants.filter((v) => ids.includes(v.platform));
}
