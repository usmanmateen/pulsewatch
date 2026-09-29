# Security and privacy

PulseWatch processes personal health information. This document describes
what it protects, against whom, and the controls in place. Data handling and
retention are detailed in [docs/DATA.md](docs/DATA.md).

**PulseWatch is informational. It is not a medical device and must not be
used for diagnosis, treatment or medical monitoring.**

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a vulnerability"
(Security Advisories) on this repository rather than in a public issue.

## Assets

| Asset                         | Why it matters                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------- |
| Google refresh token          | Long-lived read access to the user's health data                                |
| Google OAuth client secret    | Lets someone impersonate the app in OAuth flows                                 |
| Daily health aggregates in D1 | Personal health information                                                     |
| Telegram bot token            | Lets someone send messages as the bot and read messages sent to it              |
| ntfy topic (if used)          | On public ntfy.sh, knowing the topic is enough to read (and send) notifications |
| `STATUS_TOKEN`                | Access to operational status and admin actions                                  |
| Source and dependencies       | A compromised dependency runs with access to all of the above                   |

## Threat model

### OAuth credentials

- **Threats:** credentials committed to git; leaked through logs; stolen from
  the database; over-broad scopes increasing the blast radius.
- **Controls:**
  - The refresh token and client secret live only in Cloudflare Worker
    secrets. `npm run oauth` pipes them to `wrangler secret bulk` on stdin;
    they are never printed, logged, passed as command-line arguments or
    written to disk (unless `--dev-vars` is explicitly requested). The client
    ID is public configuration (`wrangler.jsonc`).
  - The consent callback is a short-lived loopback listener
    (`http://localhost:8976/oauth/callback`) on the owner's machine: there is
    no public OAuth endpoint on the Worker to attack, and the Worker holds no
    Cloudflare API credential.
  - Access tokens are held in memory (reused by a warm isolate until they
    expire) and never persisted.
    **D1 contains no credentials.**
  - Four read-only scopes; no write, location, ECG, profile or nutrition.
  - The consent flow uses PKCE (S256) and a random `state`; the loopback
    callback only listens on localhost and ignores mismatched state.
  - `.gitignore` excludes `.env*` and `.dev.vars*` (examples excepted).
  - If Google rejects the credentials (`invalid_grant`), a circuit breaker
    stops all API calls until the secret changes (detected via a truncated
    SHA-256 fingerprint of the credentials), and one alert asks for re-authorisation.
- **Residual risk:** anyone with Cloudflare account access can read secrets
  into a deployed Worker. Protect the Cloudflare account with 2FA.

### Health data in D1

- **Threats:** unnecessary collection; indefinite retention; exposure through
  an endpoint.
- **Controls:**
  - Only daily aggregates are stored; no intraday samples (see DATA.md).
    Field masks mean heart-rate values are not even downloaded.
  - Automatic retention: 120 days for daily aggregates, 30 days for
    notification rows, 14 days for run records; notification text is deleted
    on delivery.
  - D1 is encrypted at rest by Cloudflare and reachable only through the
    Worker binding (or an authenticated Cloudflare account).
- **Residual risk:** Cloudflare, as processor, can technically access the
  data. Encrypting aggregates with a Worker-held key would not change that
  (the key lives in the same account), so it was judged not worth the
  complexity.

### Notification content

- **Threats:** someone obtains the Telegram bot token (or the ntfy topic);
  messages stored by a third party; lock-screen exposure.
- **Controls:**
  - `npm run telegram:setup` reads the bot token at a hidden prompt (or from
    a file), learns the chat id from your own `/start` message, and stores
    both only as Worker secrets via `wrangler secret bulk` on stdin. Neither
    is printed, logged or written to disk.
  - The token is part of Bot API URLs, so request URLs are never logged and
    delivery failures are recorded as reason codes only. Configuration
    rejects values that do not look like a BotFather token or a numeric chat
    id.
  - Messages go to exactly one chat: the configured `TELEGRAM_CHAT_ID`. The
    Worker never reads incoming messages, so strangers messaging the bot get
    nothing back.
  - Resolved off-wrist alerts are deleted from the chat (`deleteMessage`).
  - Notifications carry the minimum needed (e.g. "no heart-rate data for 36
    minutes"), never raw series.
  - With `NOTIFY_PROVIDER=ntfy`, the topic is a secret with ~131 bits of
    entropy, redacted by the logger; `NTFY_URL`/`NTFY_TOKEN` support a
    self-hosted server.
- **Residual risk:** Telegram bot chats are cloud chats without end-to-end
  encryption, so Telegram stores notification text, including morning-brief
  summaries of sleep and heart rate, until it is deleted. Clear the chat to
  remove it. If the bot token leaks, revoke it in @BotFather (`/revoke`)
  and run `npm run telegram:setup` again. Lock-screen previews are controlled
  in Telegram's notification settings.

### Status endpoint and HTTP surface

- **Threats:** unauthenticated access to operational data; information
  leakage via errors; brute-forcing the token.
- **Controls:**
  - `/health` is public and returns only `ok`/`degraded`/`starting`.
  - `/status` and `/admin/*` require `Authorization: Bearer <STATUS_TOKEN>`,
    compared in constant time over SHA-256 digests. Tokens under 32
    characters are rejected; the generated one has 256 bits of entropy.
  - `/status` returns timestamps, states, counts and error codes only — a
    test inserts distinctive health values and asserts none appear.
  - `/admin/diagnostics` returns HTTP statuses, byte sizes, counts, Google's
    validation messages, wear coverage in relative minutes (which 5-minute
    windows have heart-rate samples) and data-source descriptors (device
    model, platform, recording method). Its test asserts that no readings,
    dates or device identifiers appear, and it stores nothing.
  - Errors return a code, never a stack trace or message.
  - All responses: `Cache-Control: no-store`, `default-src 'none'` CSP,
    `nosniff`, `DENY` framing, `no-referrer`.
- **Residual risk:** no rate limiting on the token check; with a 256-bit
  token, brute force is not practical.

### Logs

- **Threats:** health values or secrets in logs retained by a third party.
- **Controls:** structured JSON with flat primitive fields; by convention
  only ids, states, counts and error codes are logged. As a backstop, keys
  matching `token|secret|password|authorization|cookie|credential|topic|verifier|code`
  are redacted and long strings truncated. A scenario test runs the full
  pipeline and asserts that no durations, bpm values or notification bodies
  reach the logs.

### Supply chain

- **Threats:** a malicious or vulnerable dependency.
- **Controls:** one runtime dependency (`zod`); everything else is dev
  tooling. `npm audit` runs in CI (blocking for runtime dependencies at
  high severity). Dependabot proposes updates weekly. `package-lock.json`
  pins exact versions; CI installs with `npm ci`.

### Input validation

- Every Google response is validated (zod) at the boundary; malformed points
  are skipped and counted, a malformed envelope is an error. Numbers must be
  in plausible ranges before they can reach a baseline.
- Configuration is a strict schema: unknown keys, out-of-range values and
  contradictions fail loudly, with paths but never values in the message.
- Queue messages are validated; unknown or malformed ones are acknowledged
  and counted, not retried.
- Environment values (time zone, URLs, topic, token lengths) are validated at
  start-up; `NTFY_URL` must be HTTPS in live mode and contain no credentials.

## Operational checklist

- [ ] Cloudflare account has 2FA.
- [ ] Google account has 2FA; the OAuth app is **In production** (Testing
      tokens expire after 7 days — if it must stay in Testing, keep
      `refreshTokenLifetimeDays: 7` for the renewal reminder).
- [ ] `STATUS_TOKEN` generated by `npm run secrets:init`; the Telegram bot
      token and chat id stored only as Worker secrets (`npm run telegram:setup`).
- [ ] Nothing from `.dev.vars` or `.env` has been committed (`git status`).
- [ ] Revoke access at <https://myaccount.google.com/permissions> when
      decommissioning, and `npx wrangler delete` the Worker.
