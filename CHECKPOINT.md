# Seven Stones — Build Checkpoint

Date: 2026-11-01
Workspace: `C:\Users\kisk3\Documents\預設專案`

## Status

The game is implemented, tested, documented, and verified in the in-app browser. It is runnable locally on Node.js 24 with native SQLite. Docker and Oracle deployment files are included but were not executed because Docker is not installed on this machine. No public URL exists because no hosting, DNS, or OAuth credentials were provided.

## What was delivered

- 15×15 freestyle Gomoku board with coordinates, responsive layout, and larger-board toggle.
- Ranked games against NOVA with server-side settlement and a 300-chip daily UTC baseline.
- Stakes 25/50/100/200/300/500, unlocked at 3/5/7/10 qualifying ranked AI games.
- Human duels with 90-second turns, invitations, presence checks, stake/affordability checks, and five-per-hour sender limit.
- Daily and seven-day season leaderboards derived only from settled AI games.
- Permanent invitation unlock at 1,000 points in one UTC day.
- Local practice with Standard/Advanced NOVA and browser-only records.
- Name/password accounts (scrypt, hashed session tokens) and optional server-verified Google sign-in.
- Expected empty states: no fake players, online counts, winners, bonuses, or real-money claims.
- Restart safety: sessions persist, pending NOVA turns resume, invitations unlock backfill, active games settle at midnight.
- Dockerfile, Compose files, Caddy TLS proxy, Windows start scripts, environment templates, README, and Oracle deployment guide.
- `DEPLOY-FREE.md` and `GITHUB-UPLOAD.md`, plus a clean GitHub upload package at `dist/seven-stones-github.zip` (excludes `.env`, `data/`, and `node_modules/`).

## Verification performed

### Automated tests

Command:

```powershell
corepack pnpm@11.25.0 test
```

Result: **10 passed, 0 failed** (latest run 2026-11-01).

Coverage includes:

- stake tiers and next-tier messaging;
- five-in-a-row in all directions, overlines, full-board draws;
- ranking contract and UTC date/season math;
- NOVA legality and immediate win/block behavior;
- account creation and session persistence;
- ranked start/reserve, move, NOVA response, resignation loss;
- human duel invitation, acceptance, rejection of sender-side acceptance, settlement for both players;
- restart backfill of invitation unlocks;
- restart resumption of a game waiting on NOVA;
- midnight rollover, daily top-three archive, seven-day season archive;
- empty day/season behavior.

### Browser verification

Against `http://localhost:8787`:

- Registered an account through the dialog.
- Started a 25-chip ranked game; wallet correctly showed 275 reserved.
- Played H8; NOVA replied; turn returned to the player.
- Resigned; result banner showed `You lost −25 chips. Resignation.`; wallet 275, AI net −25.
- Checked Leaderboard, History, and Invitations tabs; empty-state text was correct and no fake data appeared.
- Started Advanced practice; player move and NOVA response worked without sign-in.
- Browser console: **0 errors** on the final build.
- Lighthouse: Accessibility **1.00**, Best Practices **1.00**, SEO **1.00**, no failed audits.
- Board DOM: 15 rows, 225 gridcells, no horizontal overflow.
- HTTP headers confirmed: CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`.
- `START-GAME.cmd` / `start.ps1` verified: creates `.env`, finds Node 24, starts the server, opens the configured port.
- Final clean launch through `start.ps1` responded on <http://localhost:8787> with an empty database; the test account used during verification was removed.
- Final restart after the Google duplicate-link fix: `/api/health` returned `{"ok":true,"app":"seven-stones"}`, the page returned 200 with `Cache-Control: no-store`, the board rendered 15 rows / 225 cells with no horizontal overflow, and the browser console had **0 errors**.

### Not verified

- Docker image build and `docker compose` startup: Docker CLI is not installed here. Files were reviewed but not executed.
- Oracle/Caddy live TLS: requires an OCI account, public IP, and domain.
- Google OAuth acceptance: requires a real `GOOGLE_CLIENT_ID` and matching authorized JavaScript origin.

## Northflank status checked (2026-11-01)

Northflank's public pricing page and docs currently describe the free **Sandbox** tier as including:

- 2 services
- 2 jobs
- 1 addon
- always-on compute (no sleeping)

Volumes and persistence are advertised as included. Exact CPU/RAM allowances and plan terms can change, so verify in the Northflank console before relying on the free tier. No Northflank deployment was attempted because credentials were not provided.

Source: <https://northflank.com/pricing>

## Key files

```text
server.cjs            HTTP API, SQLite schema, auth, games, settlement, tick
game.cjs              board/win/date/season/ranking primitives
invitations.cjs       presence, expiry, busy checks
google-auth.cjs       Google ID-token verification
ai-worker.cjs         worker-thread adapter for NOVA
public/index.html     English UI structure
public/app.js         UI state, polling, board, auth, practice, invitations
public/styles.css     responsive dark theme
public/engine.js      shared NOVA AI
public/rules.js       shared stakes and unlock rules
test/league.test.cjs  10 automated tests
Dockerfile            Node 24 production image
compose.yaml          app + persistent volume
compose.oracle.yaml   optional Caddy TLS service
Caddyfile             reverse proxy and HSTS
.env.example          local defaults
.env.oracle.example   production template
ORACLE-DEPLOY.txt     Oracle Cloud deployment runbook
README.md             rules, setup, tests, deployment, limits
start.ps1             Windows launcher
START-GAME.cmd        double-click launcher
```

## How to run

```powershell
.\START-GAME.cmd
```

or:

```powershell
corepack pnpm@11.25.0 install --frozen-lockfile
Copy-Item .env.example .env
node --env-file-if-exists=.env server.cjs
```

Open <http://localhost:8787>.

## Blockers and next step

1. To publish, supply a host and domain. Deploy with `docker compose -f compose.yaml -f compose.oracle.yaml up -d --build` on an Oracle VM, or connect the repository to Northflank using the Dockerfile and a `/app/data` volume.
2. Set `COOKIE_SECURE=1` and serve only over HTTPS.
3. To enable Google sign-in, provide a Google OAuth Web client ID and add the exact HTTPS origin.
4. Run a Docker build and a live smoke test on the target host. This machine cannot verify the image.
5. No public URL is claimed until that deployment succeeds.
