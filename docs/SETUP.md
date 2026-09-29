# Setup and deployment

End to end: about 20 minutes. You need a Cloudflare account (free plan), a
Google account with a Fitbit/Google wearable in the Google Health app, Node.js
22+, and Telegram on your phone.

1. [Install and try the demo](#1-install-and-try-the-demo)
2. [Cloudflare](#2-cloudflare)
3. [Google Cloud OAuth client](#3-google-cloud-oauth-client)
4. [Secrets and Telegram](#4-secrets-and-telegram)
5. [Deploy](#5-deploy)
6. [Authorise Google Health](#6-authorise-google-health)
7. [Verify](#7-verify)
8. [Configuration](#8-configuration)
9. [Operations](#9-operations)

## 1. Install and try the demo

```bash
npm ci
npm run demo
```

No accounts are needed: every scenario runs through the real pipeline with
synthetic data. `npm run check` runs typecheck, lint, formatting and tests.

## 2. Cloudflare

```bash
npx wrangler login                 # opens the browser; approve access
```

PulseWatch needs one D1 database (binding `DB`) and one queue
(`pulsewatch-notifications`, producer binding `NOTIFICATIONS`, consumed by the
same Worker). If they already exist, just put the database id in the D1 entry
of `wrangler.jsonc`. Otherwise create them:

```bash
npx wrangler d1 create pulsewatch  # copy the printed database_id into wrangler.jsonc
npx wrangler queues create pulsewatch-notifications
```

The database id identifies the database but grants nothing without your
Cloudflare credentials, so it is fine to commit.

## 3. Google Cloud OAuth client

All in [Google Cloud Console](https://console.cloud.google.com/), signed in
with the Google account that owns the health data.

1. **Create a project** (e.g. `pulsewatch`).
2. **Enable the API:** APIs & Services → Library → **Google Health API** →
   Enable.
3. **Google Auth Platform** (formerly "OAuth consent screen") → Get started:
   - _Branding:_ app name `PulseWatch`, your email as support and developer contact,
     and the public pages from [`site/`](../site) (published with GitHub Pages):
     - Application home page: `https://usmanmateen.github.io/pulsewatch/`
     - Application privacy policy: `https://usmanmateen.github.io/pulsewatch/privacy/`
     - Application terms of service: `https://usmanmateen.github.io/pulsewatch/terms/`
     - Authorised domain: `usmanmateen.github.io` (the `localhost` redirect URI needs no
       authorised domain)
   - _Audience:_ **External**. Add your own Google account under **Test users**.
   - _Data access:_ Add or remove scopes → filter "Google Health API" → tick
     exactly these four, then Update → Save:
     - `.../auth/googlehealth.health_metrics_and_measurements.readonly`
     - `.../auth/googlehealth.activity_and_fitness.readonly`
     - `.../auth/googlehealth.sleep.readonly`
     - `.../auth/googlehealth.settings.readonly`
   - _Clients:_ Create client → **Web application**, name `PulseWatch`, and
     exactly one authorised redirect URI:

     ```
     http://localhost:8976/oauth/callback
     ```

     No JavaScript origins are needed. The redirect goes to a short-lived
     listener that `npm run oauth` runs on your own machine, so the refresh
     token travels from Google straight into a Cloudflare secret and never
     through a public endpoint or the database. Google allows `localhost`
     redirect URIs for Web-application clients without domain verification.
4. **Publishing status.** Prefer **In production** (Audience → Publish app).
   In _Testing_, Google revokes refresh tokens after 7 days; PulseWatch then
   needs a fresh `npm run oauth` every week. If the app has to stay in Testing,
   set `"serviceHealth": { "refreshTokenLifetimeDays": 7 }` in
   `PULSEWATCH_CONFIG` to get a reminder a day before access lapses. A personal, unverified app in production is
   fine: Google shows an "unverified app" warning during consent and caps it
   at 100 users.
5. **Client ID** is public configuration: set `GOOGLE_CLIENT_ID` in the
   `vars` of `wrangler.jsonc`.
6. **Client secret** is a secret: put it in `.env` (git-ignored) or export it
   as `GOOGLE_CLIENT_SECRET` in the shell that runs `npm run oauth`:

   ```ini
   GOOGLE_CLIENT_SECRET=<your client secret>
   ```

Never commit `.env` or paste the secret into issues, chats or `wrangler.jsonc`.

## 4. Secrets and Telegram

| Name                   | Kind              | Set by                                             |
| ---------------------- | ----------------- | -------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | variable (`vars`) | you, in `wrangler.jsonc`                           |
| `NOTIFY_PROVIDER`      | variable (`vars`) | `telegram` (default in `wrangler.jsonc`) or `ntfy` |
| `GOOGLE_CLIENT_SECRET` | secret            | `npm run oauth` (or `npx wrangler secret put`)     |
| `GOOGLE_REFRESH_TOKEN` | secret            | `npm run oauth`                                    |
| `STATUS_TOKEN`         | secret            | `npm run secrets:init -- --upload`                 |
| `TELEGRAM_BOT_TOKEN`   | secret            | `npm run telegram:setup`                           |
| `TELEGRAM_CHAT_ID`     | secret            | `npm run telegram:setup`                           |
| `NTFY_TOPIC`           | secret, ntfy only | `npx wrangler secret put NTFY_TOPIC`               |
| `NTFY_TOKEN`           | secret, optional  | only for an access-controlled ntfy server          |

```bash
npm run secrets:init
```

This writes a random `STATUS_TOKEN` to `.dev.vars` (git-ignored) without
printing it.

**Telegram** delivers the notifications. Public ntfy.sh is not recommended
from Cloudflare Workers: it limits messages per IP address, and Workers share
their IPs with other customers, so its daily quota is usually already used up
(see [ARCHITECTURE.md](../ARCHITECTURE.md#the-ntfysh-rate-limit-problem)).

1. Install **Telegram** on your phone and sign in.
2. Open **@BotFather** (blue tick), send `/newbot`, and choose a name and a
   username ending in `bot`. BotFather replies with a token.
3. After deploying (step 5), run `npm run telegram:setup`, paste the token at
   the hidden prompt, then open the link it prints and tap **Start**. The
   script stores `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as Worker
   secrets and sends a "PulseWatch is connected" message.

To use ntfy instead (for example a self-hosted server), set
`NOTIFY_PROVIDER` to `ntfy` and `NTFY_URL` in `wrangler.jsonc`, store
`NTFY_TOPIC` (and `NTFY_TOKEN` if the server needs authentication), and
subscribe to the topic in the ntfy app.

## 5. Deploy

```bash
npm run db:migrate:remote           # creates the tables in D1
npx wrangler deploy                 # Worker, cron trigger, queue producer and consumer
npm run secrets:init -- --upload    # STATUS_TOKEN
npm run telegram:setup              # bot token at a hidden prompt, then tap Start in Telegram
```

Later deploys: `npm run deploy` (runs every check and the D1 migrations
first).

Until step 6 is done, the Worker runs safely and `/status` reports
`google.auth: "not_configured"`.

## 6. Authorise Google Health

```bash
npm run oauth
```

The browser opens Google's consent screen. Sign in, choose **Advanced → Go to
PulseWatch (unsafe)** on the unverified-app warning (it is your own app),
grant all four permissions (select all), and wait for "PulseWatch is
connected". The script stores `GOOGLE_REFRESH_TOKEN` and
`GOOGLE_CLIENT_SECRET` as Worker secrets (`--token-only` stores just the
token if the secret is already managed elsewhere); nothing is printed.

Re-run `npm run oauth` whenever PulseWatch asks you to re-authorise; the
Worker notices the new token automatically.

## 7. Verify

```bash
# Replace <subdomain> with your workers.dev subdomain.
curl https://pulsewatch.<subdomain>.workers.dev/health

# Operational status (token from .dev.vars):
curl -H "Authorization: Bearer $STATUS_TOKEN" https://pulsewatch.<subdomain>.workers.dev/status

# End-to-end delivery test (Worker → Queue → Telegram → phone):
curl -X POST -H "Authorization: Bearer $STATUS_TOKEN" https://pulsewatch.<subdomain>.workers.dev/admin/test-notification

# Run a check now instead of waiting for the cron:
curl -X POST -H "Authorization: Bearer $STATUS_TOKEN" https://pulsewatch.<subdomain>.workers.dev/admin/check

# Check every Google request against the live API, plus a dry run of the
# first sync (statuses and counts only, never health values):
curl -X POST -H "Authorization: Bearer $STATUS_TOKEN" https://pulsewatch.<subdomain>.workers.dev/admin/diagnostics

# Live logs:
npx wrangler tail
```

A healthy `/status` shows `google.auth: "ok"`, a recent
`google.lastSuccessfulSyncAt`, `device.lastSyncObservedAt`, and
`wearState: "ok:NORMAL"` while you wear the tracker.

The real end-to-end test is the primary use case: take the tracker off and
leave it near your phone. The reminder arrives at the first check after the
tracker syncs a long enough gap: with the default thresholds (30 minutes, two
checks) within about 40 minutes, with 5 minutes and one check usually within
10–20 minutes, depending on how often the tracker syncs. Put it back on and
the notification is deleted at the next check after it syncs.

## 8. Configuration

Thresholds live in `PULSEWATCH_CONFIG` in `wrangler.jsonc`. Only overrides are
needed; everything else keeps its default. Unknown keys and out-of-range
values are rejected at start-up.

```jsonc
"PULSEWATCH_CONFIG": {
  "schedule": { "wakeTime": "07:00", "sleepTime": "23:00" },
  "rules": {
    "deviceOffWrist": { "staleAfterMinutes": 30, "confirmationChecks": 2, "syncStaleAfterMinutes": 60 },
    "inactivity": { "thresholdMinutes": 90 },
    "sleep": { "minimumHours": 6.5 },
    "restingHeartRate": { "baselineDays": 30, "minimumSamples": 14 },
    "hrv": { "baselineDays": 30, "minimumSamples": 14, "consecutiveDays": 3 },
    "morningBrief": { "earliest": "07:30", "latest": "11:00" }
  }
}
```

Every option, with its default and valid range, is in
[src/config/schema.ts](../src/config/schema.ts). `TIME_ZONE` (IANA name,
default `Europe/London` in `wrangler.jsonc`) controls waking hours, day
boundaries and the brief.

## 9. Operations

| Situation                        | What happens / what to do                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Refresh token revoked or expired | One "needs re-authorising" notification; checks pause. Run `npm run oauth`.                                    |
| OAuth app still in Testing       | Tokens last 7 days; a reminder arrives a day before (with `refreshTokenLifetimeDays: 7`). Run `npm run oauth`. |
| Google Health outage             | Wear state freezes; after 6 failed checks one alert; clears on recovery.                                       |
| Telegram `429`                   | Queue retries after Telegram's `retry_after`; see `notifications.rateLimitedTotal`.                            |
| Telegram bot token leaked        | `/revoke` in @BotFather, then `npm run telegram:setup` with the new token.                                     |
| Change thresholds                | Edit `PULSEWATCH_CONFIG`, `npm run deploy`.                                                                    |
| Rotate `STATUS_TOKEN`            | Delete it from `.dev.vars`, then `npm run secrets:init -- --upload`.                                           |
| Using ntfy: rotate the topic     | `npx wrangler secret put NTFY_TOPIC` with a new topic, then resubscribe in the ntfy app.                       |
| Delete all data                  | See [docs/DATA.md](DATA.md#deleting-everything).                                                               |
