# SocialSuite

A self-hosted social media scheduler with a built-in Claude connector.

- **Connect** X, LinkedIn, Facebook Pages, Instagram (business), Threads, Bluesky and Mastodon.
- **Compose** one post for many accounts, with per-platform text, live character counts and an image.
- **Schedule** on a calendar. A worker publishes due posts every 15 seconds and retries failures (3 attempts with backoff).
- **Write with Claude** drafts a version for each selected platform that fits its character limit.
- **Claude connector (MCP)** lets Claude (claude.ai, Claude Desktop, Claude Code) list accounts and schedule, edit, publish or cancel posts for you.

## Run it

Requires Node 22.5+ (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env   # then edit it
npm start              # http://localhost:3000
```

Open the app through the server URL, not by opening `public/index.html` directly. The dashboard needs the server for its data, and loading the file directly also breaks the stylesheet.

Data (SQLite database + uploaded images) lives in `./data`.

### Styles (Tailwind CSS)

Styles are written with Tailwind CSS v4 in `src/styles/input.css` and compiled by the Tailwind CLI to `public/styles.css` (generated, not committed).

- `npm start` builds the CSS automatically before starting.
- `npm run dev` rebuilds CSS and restarts the server whenever you change something.
- `npm run build:css` builds it once.

## Connecting accounts

| Platform | How | What you need |
|---|---|---|
| Bluesky | Accounts → Connect | Handle + an [app password](https://bsky.app/settings/app-passwords) |
| Mastodon | Accounts → Connect | Instance URL + access token (Preferences → Development → New application; scopes `read:accounts write:statuses write:media`) |
| X | OAuth | App at developer.x.com with OAuth 2.0 (Web App). Set `X_CLIENT_ID` / `X_CLIENT_SECRET`. Posting needs a paid API tier. |
| LinkedIn | OAuth | App with *Sign In with LinkedIn using OpenID Connect* + *Share on LinkedIn*. Tokens last 60 days; reconnect when prompted. |
| Facebook + Instagram | OAuth | Meta Business app with Facebook Login for Business and the `pages_*` + `instagram_*` permissions. One login connects every Page you admin and each Page's linked Instagram business account. |
| Threads | OAuth | Meta app with the Threads API use case. |

For every OAuth app, the redirect URL is `PUBLIC_URL/auth/<platform>/callback` (`x`, `linkedin`, `facebook`, `threads`). The Accounts page shows the exact URLs.

**Images:** Instagram, Threads and Facebook fetch images by URL, so `PUBLIC_URL` must be publicly reachable for uploaded images to work on those platforms. Instagram posts need an image.

## The Claude connector

Open **Claude connector** in the sidebar. It shows your connector URL, which includes a secret key.

- **claude.ai / Claude apps:** Settings → Connectors → Add custom connector → paste the URL. claude.ai has to reach your server over the internet, so deploy SocialSuite or use a tunnel (`cloudflared tunnel --url http://localhost:3000`) and set `PUBLIC_URL` to the HTTPS address.
- **Claude Code:** `claude mcp add --transport http socialsuite <PUBLIC_URL>/mcp --header "Authorization: Bearer <key>"`
- **Claude Desktop:** the page gives you a ready-made `claude_desktop_config.json` snippet.

Tools: `list_accounts`, `list_posts`, `get_post`, `schedule_post`, `publish_now`, `update_post`, `delete_post`. Posts made through Claude are tagged “via Claude” in the dashboard.

Example prompt: *"Look at my connected accounts, write a launch post for our new dark mode (short for X and Bluesky, longer for LinkedIn) and schedule it for Tuesday at 9am New York time."*

## Write with Claude

Set `ANTHROPIC_API_KEY` in `.env`. The composer then shows a **Write with Claude** panel:
- **Draft for my platforms** writes from a short brief.
- **Improve mine** rewrites your draft.

It uses `claude-opus-5-5` (override with `CLAUDE_MODEL`), with server-side refusal fallbacks enabled.

## Deploying

Any host that runs a long-lived Node process with a persistent disk works, for example a VPS, Fly.io, Railway or Render with a volume. Mount the volume at `./data` or set `DATA_DIR`. Serverless platforms are a poor fit because the scheduler runs in the process. Always set `APP_PASSWORD` and an HTTPS `PUBLIC_URL` in production.

## Project layout

```
src/server.js      Express app: auth, REST API, OAuth callbacks, uploads
src/platforms.js   One adapter per network (OAuth, token refresh, publish)
src/scheduler.js   Publishes due posts, refreshes tokens, retries failures
src/mcp.js         MCP server (Streamable HTTP) for the Claude connector
src/ai.js          "Write with Claude" via the Anthropic API
src/db.js          SQLite schema and queries
public/            Single-page dashboard (no build step)
```
