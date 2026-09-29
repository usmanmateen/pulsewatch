# Contributing

Thanks for looking. The bar for changes is the same as for the existing code:
typed, tested, and explainable without health-data knowledge you had to
guess at.

## Workflow

```bash
npm ci
npm run check      # typecheck + lint + format:check + tests
npm run demo       # see the effect end to end
```

CI runs the same checks plus a Worker bundle build, a demo smoke run and a
dependency audit.

## Adding a rule

1. Add its configuration to [src/config/schema.ts](src/config/schema.ts)
   under `rules`, with defaults and ranges.
2. Create `src/rules/<name>.ts` implementing `HealthRule` (see
   [src/rules/types.ts](src/rules/types.ts)): a zod state schema,
   `needs()` returning only the data it requires for this check, and a pure
   `evaluate()`. Give notifications deterministic ids — the id is the
   deduplication key.
3. Register it in `RULES` in [src/rules/engine.ts](src/rules/engine.ts) and
   add its id to `RuleId`.
4. Test it with plain unit tests (see `test/daily-rules.test.ts`), and add a
   demo scenario in [src/demo/scenarios.ts](src/demo/scenarios.ts) if it is
   user-visible.

A new baseline trend (respiratory rate, SpO₂, skin temperature) is usually
one `createTrendRule()` call in [src/rules/trend.ts](src/rules/trend.ts) plus
fetching and storing the daily metric.

## Adding a notification provider

Implement `NotificationProvider` ([src/notifications/types.ts](src/notifications/types.ts)):
`send()` classifies outcomes as `delivered`, `retry` (with a reason and
optional `retryAfterSeconds`) or `failed`; `clear()` is optional. Select it in
[src/services.ts](src/services.ts). Retries, deduplication, leases and TTLs
are handled by the outbox and consumer, not by providers.

## Rules of the road

- No health values in logs, `/status`, test fixtures derived from real data,
  or screenshots. Use the synthetic world for anything public.
- No medical claims in user-facing text; say "unusual relative to your recent
  history", not "abnormal".
- Keep the scheduled path light: it runs every minute (free plan: 10 ms CPU, 50 subrequests, 50 D1
  queries per invocation). Multi-row writes go through a single `json_each`
  statement.

## Updating the public website

The homepage, privacy policy and terms (used on Google's OAuth consent
screen) live in [`site/`](site): static HTML and CSS with no scripts,
cookies or third-party resources. They are published from the `gh-pages`
branch of `usmanmateen/pulsewatch` by GitHub Pages. When the behaviour of
PulseWatch changes — scopes, stored data, retention, providers — update the
privacy policy in the same change and bump its effective date. To publish,
copy the contents of `site/` to the root of the `gh-pages` branch and push.

## Renaming the project

The name appears in `package.json`, `wrangler.jsonc` (`name`, D1
`database_name`, queue names), the `service` log field, and user-facing
strings under `src/`. `grep -ri pulsewatch` finds them all.
