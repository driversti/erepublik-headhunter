-- Up Migration

CREATE TABLE audit_log (
  id                 BIGSERIAL    PRIMARY KEY,
  actor_telegram_id  BIGINT       NOT NULL,
  action             TEXT         NOT NULL,
  target_telegram_id BIGINT,
  target_victim_id   BIGINT,
  metadata           JSONB,
  at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_log_target_telegram_idx ON audit_log (target_telegram_id) WHERE target_telegram_id IS NOT NULL;
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

-- Down Migration

DROP TABLE audit_log;