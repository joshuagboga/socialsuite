# SocialSuite

A self-hosted, multi-user social media scheduler with a built-in Claude connector.

- **Accounts** for each person: sign up with an email and password, and see only your own connected profiles and posts.
- **Connect** X, LinkedIn, Facebook Pages, Instagram (business), Threads, Bluesky and Mastodon.
- **Compose** one post for many accounts, with per-platform text, live character counts and an image.
- **Schedule** on a calendar. A worker publishes due posts every 15 seconds and retries failures (3 attempts with backoff) without moving the time you picked.
- **Write with Claude** drafts a version for each selected platform that fits its character limit.
- **Claude connector (MCP)** lets Claude (claude.ai, Claude Desktop, Claude Code) list accounts and schedule, edit, publish or cancel posts for you.

## Run it

Requires Node 22.5+ (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env   # then edit it
npm start              # http://localhost:3000
```

Open the app and choose **Create an account**. The first account can always be created; set `ALLOW_SIGNUP=false` afterwards if you want to keep everyone else out.

Open the app through the server URL, not by opening `public/index.html` directly. The dashboard needs the server for its data, and loading the file directly also breaks the stylesheet.

Data (SQLite database + uploaded images) lives in `./data`.

Run the tests with `npm test`. They start the real server against a throwaway data folder and a fake Mastodon instance, so nothing is posted anywhere.

## Users and security

- **Separate data per user.** Every connected account, post and Claude connector key belongs to one user. Every query is filtered by the signed-in user, so one person can never read, edit, publish or delete another person's things.
- **Passwords** are hashed with scrypt. Sessions are random tokens in an HttpOnly cookie; only a hash of the token is stored. There is no email sending yet, so a locked-out user is reset from the server: `npm run reset-password -- someone@example.com "new password"`.
- **Tokens are encrypted.** Platform access tokens, the Bluesky app password and connector keys are stored with AES-256-GCM using `ENCRYPTION_KEY`. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. It is required when `NODE_ENV=production`; on your own computer a development key is created in `./data/encryption.key`. Back the key up: without it every account has to be reconnected.
- **Rate limits** (per server process, in memory):

  | What | Limit |
  |---|---|
  | Failed sign-ins, same email from the same address | 5 per 15 minutes |
  | Failed sign-ins from one address | 30 per 15 minutes |
  | Sign-up attempts from one address | 20 per hour |
  | Any `/api` or `/auth` request from one address | 300 per minute |
  | Write with Claude | 30 per hour per user |
  | Image uploads | 60 per hour per user |
  | Claude connector | 120 per minute per user; 10 wrong keys per 15 minutes per address |

  Limits by address rely on `TRUST_PROXY` being right when the app sits behind a proxy (see `.env.example`).

### Upgrading from the single-user version

Start the new version on your existing `./data` folder. The database is upgraded in place, stored tokens are encrypted, and **the first person to sign up takes over the existing accounts, posts and Claude connector key**, so sign up yourself before sharing the link. `APP_PASSWORD` and `MCP_API_KEY` are no longer used; remove them from `.env`. Copy `./data` somewhere first if you want a way back.

### How publishing stays safe

- A retry is tracked in its own `next_attempt_at` field, so a post stays on the calendar at the time you scheduled it while it is retried.
- Before a post is sent to a platform it is marked as in flight. If the server dies before the answer is saved, the next start does **not** resend it, because it may already be live. It shows under **Failed** with a note to check the account, and you press Retry if it is not there. On a normal restart or deploy (SIGTERM) the server finishes the send in progress before it exits.
- Requests to platforms time out after 60 seconds so one stuck network call cannot hold up everyone's queue.

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

Open **Claude connector** in the sidebar. It shows your connector URL, which includes a secret key. Each user has their own key, and it only reaches that user's accounts and posts.

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

SocialSuite needs a server that stays on, with a disk that survives restarts: the scheduler runs inside the app and checks for due posts every 15 seconds, and the data is a SQLite file. That rules out serverless hosts such as **Vercel** and Netlify, where code only runs while a request is being handled and files are not kept. Free tiers that put the app to sleep when idle have the same problem: nothing is published while it sleeps.

In production always set `ENCRYPTION_KEY` and an HTTPS `PUBLIC_URL`.

### Docker on a VPS (any provider)

`docker-compose.yml` runs the app plus Caddy, which gets an HTTPS certificate for your domain automatically.

```bash
# 1. Point your domain's DNS A record at the server, then on the server:
git clone https://github.com/joshuagboga/socialsuite && cd socialsuite
cp .env.example .env
# 2. In .env set DOMAIN=social.example.com and ENCRYPTION_KEY=..., plus the platform keys you use
docker compose up -d --build
```

Data lives in the `socialsuite-data` volume. To upgrade: `git pull && docker compose up -d --build`.

### Fly.io

`fly.toml` is ready to use, with a volume for the data and the machine set to never auto-stop. The commands are at the top of that file.

### Railway, Render and similar

Deploy from the `Dockerfile`, attach a persistent volume mounted at `/data`, set `ENCRYPTION_KEY` and `PUBLIC_URL`, and use an always-on plan. The health check path is `/healthz`.

### Without Docker

Any machine with Node 22.5+: `npm ci && NODE_ENV=production npm start`, behind a reverse proxy that provides HTTPS. Set `DATA_DIR` to a folder that is backed up.

## Project layout

```
src/server.js      Express app: sign-up/login, REST API, OAuth callbacks, uploads
src/auth.js        Password hashing, sessions, the signed-in-user check
src/db.js          SQLite schema, upgrades and queries (every user-facing query takes a user id)
src/secrets.js     AES-256-GCM encryption for stored tokens
src/ratelimit.js   In-memory rate limiter
src/platforms.js   One adapter per network (OAuth, token refresh, publish)
src/scheduler.js   Publishes due posts, refreshes tokens, retries failures, crash recovery
src/mcp.js         MCP server (Streamable HTTP) for the Claude connector, one key per user
src/ai.js          "Write with Claude" via the Anthropic API
src/config.js      Settings read from the environment
public/            Single-page dashboard (no build step)
test/              node:test suites
Dockerfile, docker-compose.yml, fly.toml   Deployment
```
