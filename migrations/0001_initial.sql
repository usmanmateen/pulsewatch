-- PulseWatch schema. docs/DATA.md explains what each table holds, why, and
-- for how long. No credentials and no intraday samples are stored here.

-- Current state of each rule: small JSON documents validated on read.
-- `version` enables compare-and-swap updates between overlapping runs.
CREATE TABLE rule_state (
  rule_id    TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- One value per metric per local day: the only physiological data persisted.
-- bedtime/waketime are minutes relative to local midnight of the wake-up day.
CREATE TABLE daily_metrics (
  metric     TEXT NOT NULL CHECK (
    metric IN ('resting_hr', 'hrv', 'respiratory_rate', 'sleep_minutes', 'bedtime', 'waketime', 'steps')
  ),
  day        TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  value      REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (metric, day)
) WITHOUT ROWID;

-- Latest personal baseline per metric, recomputed once a day from daily_metrics.
CREATE TABLE baselines (
  metric       TEXT PRIMARY KEY,
  computed_for TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  samples      INTEGER NOT NULL,
  transform    TEXT NOT NULL CHECK (transform IN ('none', 'log')),
  mean         REAL NOT NULL,
  median       REAL NOT NULL,
  std_dev      REAL NOT NULL,
  mad          REAL NOT NULL,
  center       REAL NOT NULL,
  spread       REAL NOT NULL,
  computed_at  INTEGER NOT NULL
) WITHOUT ROWID;

-- Transactional outbox and delivery history. `id` is the deterministic dedup
-- key produced by the rule; `payload` (the rendered text) is cleared as soon
-- as the notification reaches a terminal status.
CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  rule_id         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('alert', 'clear')),
  severity        TEXT NOT NULL,
  payload         TEXT,
  status          TEXT NOT NULL CHECK (
    status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'expired', 'suppressed')
  ),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token     TEXT,
  lease_until     INTEGER NOT NULL DEFAULT 0,
  enqueued_at     INTEGER,
  last_error      TEXT,
  provider_ref    TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX notifications_dispatch ON notifications (status, next_attempt_at);
CREATE INDEX notifications_created ON notifications (created_at);

-- One row per check. The primary key doubles as the cron-slot lease that
-- makes duplicate cron deliveries no-ops.
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  trigger       TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  outcome       TEXT NOT NULL,
  api_calls     INTEGER NOT NULL DEFAULT 0,
  api_failures  INTEGER NOT NULL DEFAULT 0,
  notifications INTEGER NOT NULL DEFAULT 0,
  rule_summary  TEXT
) WITHOUT ROWID;
CREATE INDEX runs_started ON runs (started_at);

-- Operational key/value store: heartbeats, counters, sync bookkeeping.
CREATE TABLE ops (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
