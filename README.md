# Seven Stones

A self-hosted 15×15 freestyle Gomoku game with ranked games against the NOVA AI, local practice, human duels, daily leaderboards, seven-day seasons, and invitation-only challenges.

Virtual chips only. There are no purchases, cash prizes, real-money wagering, fake players, fake online counts, or invented champions.

## Rules

- 15×15 board, black moves first.
- Five or more stones in a row win. Overlines count. No forbidden moves.
- Ranked games are against NOVA. Practice and human duels never enter the ranked leaderboard.
- Every UTC day starts with a 300-chip baseline. Active stakes are reserved until the game settles.
- Stakes are 25 / 50 / 100 / 200 / 300 / 500.
  - 25 and 50 are available immediately.
  - 100 unlocks after 3 qualifying ranked AI games in the day.
  - 200 after 5, 300 after 7, and 500 after 10.
  - Resignations count as losses but not as qualifying games.
- A ranked win adds the stake, a loss subtracts it, and a draw or refund changes nothing.
- The daily leaderboard ranks settled ranked AI results by net chips, then wins, then losses, then name.
- Seasons are seven-day UTC blocks anchored when the database is first created. Empty days and empty seasons produce no winners.
- Reach 1,000 points in a single UTC day to unlock invitations permanently. Score is 300 plus that day's settled AI net.
- An unlocked player may challenge a top-three player from today or the season. Both players must be online, free, and able to cover the chosen stake. Invitations expire at the next 00:00 UTC and are limited to five per hour per sender.
- Human turns have a 90-second deadline. A timeout settles the game.
- Practice is local to the browser and never touches the server ledger.

## Quick start on Windows

Requirements: Node.js 24 or newer.

1. Double-click `START-GAME.cmd`, or run:

   ```powershell
   .\start.ps1
   ```

2. Open <http://localhost:8787>.
3. Press `Ctrl+C` in the console to stop the server.

`start.ps1` creates `.env` from `.env.example` when needed, installs dependencies with pnpm 11.25.0 when `node_modules` is missing, and opens the browser.

### Manual start

```powershell
corepack pnpm@11.25.0 install --frozen-lockfile
Copy-Item .env.example .env
node --env-file-if-exists=.env server.cjs
```

Then open <http://localhost:8787>. The SQLite database is created at `./data/league.sqlite` by default.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `HOST` | `0.0.0.0` | Listen address |
| `DB_PATH` | `./data/league.sqlite` | SQLite database file; its parent directory is created |
| `COOKIE_SECURE` | `0` | Set to `1` when the site is served over HTTPS |
| `GOOGLE_CLIENT_ID` | empty | Optional Google OAuth Web client ID |

Do not enable `COOKIE_SECURE=1` on a plain HTTP origin: the browser will not send the session cookie. Always use HTTPS in production.

## Google sign-in (optional)

1. Create an OAuth 2.0 Web application client in Google Cloud Console.
2. Add the exact site origin under **Authorized JavaScript origins**, for example `https://stones.example.com` or `http://localhost:8787`.
3. Set `GOOGLE_CLIENT_ID` and restart the server.
4. Google ID tokens are verified server-side with `google-auth-library` (signature, audience, issuer, expiry, verified email, and the server-issued nonce). Existing players are linked only through a signed-in session; accounts are never merged by email.

Without a client ID, the Google button is replaced with a clear notice and name/password login continues to work.

## Tests

```powershell
corepack pnpm@11.25.0 test
```

or directly:

```powershell
node --test test/league.test.cjs
```

The suite covers rules and unlocks, win detection, ranking order, UTC dates and seasons, NOVA move legality, account and session flow, ranked AI settlement, resignation handling, human duels, invitation authorization and settlement, restart backfill of invitation unlocks, restart recovery of a pending NOVA turn, and midnight/season archives. There are 10 tests.

Tests use temporary databases and do not touch `./data/league.sqlite`.

## Docker

```powershell
Copy-Item .env.example .env
docker compose up -d --build
```

The app is published only on `127.0.0.1:8787` and stores its database in the named volume `seven-stones-data`. Put a TLS reverse proxy in front of it before exposing it to the internet.

Health check: `GET /api/health` returns `{"ok":true,"app":"seven-stones"}`.

To back up, stop the app and copy the whole volume, or copy `league.sqlite`, `league.sqlite-wal`, and `league.sqlite-shm` together while the app is stopped.

## Deployment

For a step-by-step free deployment and Google account linking guide in Traditional Chinese, see [`DEPLOY-FREE.md`](./DEPLOY-FREE.md). For GitHub upload instructions, see [`GITHUB-UPLOAD.md`](./GITHUB-UPLOAD.md).

### Oracle Cloud VM with Docker and Caddy

See [`ORACLE-DEPLOY.txt`](./ORACLE-DEPLOY.txt). It includes firewall, DNS, HTTPS, update, and backup steps.

The short version:

```bash
cp .env.oracle.example .env
# Edit DOMAIN and optional GOOGLE_CLIENT_ID.
docker compose -f compose.yaml -f compose.oracle.yaml up -d --build
```

Caddy obtains and renews the TLS certificate and proxies to the app over the private Compose network.

### Northflank

Northflank can build the included `Dockerfile` directly.

1. Create a project and a service from this repository, choosing **Dockerfile** as the build type.
2. Set the service port to `8787` and the health check path to `/api/health`.
3. Add a persistent volume mounted at `/app/data`.
4. Set `DB_PATH=/app/data/league.sqlite`, `COOKIE_SECURE=1`, `HOST=0.0.0.0`, and optionally `GOOGLE_CLIENT_ID`.
5. Add the generated HTTPS origin to the Google OAuth authorized origins if Google sign-in is enabled.

As of 1 November 2026, Northflank's free Sandbox tier advertises two services, two jobs, one addon, and always-on compute. Resource limits and plan details can change; check <https://northflank.com/pricing> before relying on the free tier.

### Any other host

The service is a single Node.js process. Persist the directory containing `DB_PATH`, set `COOKIE_SECURE=1` behind HTTPS, and forward `/` and `/api/*` to port 8787. Do not run multiple replicas against the same SQLite file.

## Security notes

- Passwords use scrypt with a per-user salt; sessions are random 256-bit tokens stored only as SHA-256 hashes.
- Session cookies are `HttpOnly`, `SameSite=Strict`, and optionally `Secure`.
- All game, stake, settlement, invitation, and wallet decisions are made by the server. Client-supplied boards and results are not trusted.
- Account names are validated and case-insensitively unique. Unknown login names still perform a password hash to reduce timing differences.
- The server sends CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, and `Referrer-Policy` headers.
- Keep `.env` and the database private. Never commit either one.
- The app does not include an email provider, payment provider, or external analytics. There is no password-reset email flow.

## API summary

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/state` | Session, wallet, game, boards, history, invitations |
| `POST` | `/api/register` | Create an account |
| `POST` | `/api/login` / `/api/logout` | Session management |
| `GET` | `/api/google/challenge` | One-time Google nonce |
| `POST` | `/api/google` | Verify a Google credential and sign in or link |
| `POST` | `/api/start-ai` | Start a ranked game against NOVA |
| `POST` | `/api/move` | Submit a move with revision checking |
| `POST` | `/api/resign` | Resign an active game |
| `POST` | `/api/invite` | Send a top-three challenge |
| `POST` | `/api/invite-accept` / `decline` / `cancel` | Respond to an invitation |
| `POST` | `/api/queue` / `/api/cancel` | Legacy human matchmaking endpoints |

All mutating endpoints require a session and validate ownership, turn order, stake unlocks, wallet balance, and revision.

## Project layout

```text
server.cjs          HTTP server, SQLite schema, auth, games, settlement, tick
game.cjs            board, win, date, season, and ranking primitives
invitations.cjs     presence, expiry, busy checks, and pending invitations
google-auth.cjs     Google ID-token verification
ai-worker.cjs       worker-thread adapter for NOVA
public/             browser UI, shared rules, and shared AI engine
test/               automated tests
Dockerfile          production image
compose.yaml        local/self-hosted app service and volume
compose.oracle.yaml optional Caddy TLS front end
Caddyfile           Caddy reverse-proxy configuration
```

## Limits and honest status

- The game is complete and tested locally. No public URL is included because no hosting account or domain credentials were provided.
- Google OAuth cannot be accepted end-to-end until a real client ID and matching authorized origin are supplied.
- Chips are virtual and have no cash value. Nothing in the UI or API offers purchases or withdrawals.
- Leaderboards, online dots, announcements, and champions are derived only from real settled server records. Empty periods stay empty.
