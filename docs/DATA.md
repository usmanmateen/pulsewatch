# Data inventory and retention

PulseWatch handles personal health information, so it keeps as little as it
can for as short a time as it can. This page lists everything it reads,
stores and deletes.

## What is read from Google

Four read-only scopes, nothing else:

| Scope (`googlehealth.*`)                   | Used for                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `health_metrics_and_measurements.readonly` | newest heart-rate sample **time**, daily resting HR, HRV, respiratory rate |
| `activity_and_fitness.readonly`            | 5-minute step totals (inactivity), yesterday's step count                  |
| `sleep.readonly`                           | main sleep: duration, start/end, processing status                         |
| `settings.readonly`                        | paired tracker: last sync time, battery level/status, model                |

Every request uses a field mask, so PulseWatch does not even download:

- heart-rate **values** (only the newest sample's timestamp, and whether
  any heart rate was recorded in each 5-minute window);
- sleep stages, device MAC addresses, data-source details, or any metric not
  listed above.

## What is stored (Cloudflare D1)

| Table           | Contents                                                                                                   | Why                                            | Retention                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| `daily_metrics` | One number per metric per day: resting HR, HRV, respiratory rate, sleep minutes, bedtime, wake time, steps | Personal baselines, trend rules, morning brief | **120 days** (`retention.dailyMetricsDays`)            |
| `baselines`     | Latest baseline per metric: window, sample count, median, MAD, mean, SD                                    | Morning-brief comparisons, `/status` readiness | Overwritten daily (one row per metric)                 |
| `rule_state`    | Small JSON per rule: wear state, episode ids and timestamps, last evaluated day                            | Confirmation, deduplication, cooldowns         | Current state only                                     |
| `notifications` | Id, rule, status, attempts, error code, timestamps; **message text only while undelivered**                | Outbox, deduplication, delivery audit          | Text: until delivered/failed/expired. Row: **30 days** |
| `runs`          | One row per check: outcome, API call/failure counts, rule status codes                                     | Cron idempotency, `/status`                    | **14 days**                                            |
| `ops`           | Heartbeats, counters, last error codes, last device sync time, battery bucket, device model                | Observability                                  | Current values only                                    |

Retention runs once per local day from the scheduled check
([src/storage/retention.ts](../src/storage/retention.ts)) and is covered by
tests. Periods are configurable in `PULSEWATCH_CONFIG.retention`.

## What is **not** stored

- Intraday physiological samples of any kind (heart rate, steps per minute,
  sleep stages). They are used in memory for the current check and discarded.
- OAuth credentials. The refresh token, client ID and secret are Cloudflare
  secrets; access tokens exist only in Worker memory, until they expire.
- Notification text after delivery.
- The Telegram bot token and chat id (Cloudflare secrets), or the ntfy topic
  if ntfy is used.

## Where else data goes

| Place             | What                                               | Notes                                                                                                     |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Cloudflare Queues | `{v: 1, id}` only                                  | No health data in queue messages                                                                          |
| Workers Logs      | Event names, ids, state names, counts, error codes | No values; sensitive-looking keys are redacted; retained per Cloudflare's Workers Logs policy             |
| Telegram          | Notification title and text, kept in the bot chat  | Not end-to-end encrypted; resolved alerts deleted; see [SECURITY.md](../SECURITY.md#notification-content) |
| `/status`         | Timestamps, states, counters, sample counts        | Bearer-token protected; tested to contain no values                                                       |

## Deleting everything

```bash
npx wrangler d1 execute pulsewatch --remote --command "DELETE FROM daily_metrics; DELETE FROM baselines; DELETE FROM rule_state; DELETE FROM notifications; DELETE FROM runs; DELETE FROM ops;"
```

Revoke Google access at <https://myaccount.google.com/permissions>, then
`npx wrangler delete` removes the Worker and its secrets.
