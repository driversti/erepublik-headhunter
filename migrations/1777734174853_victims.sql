-- Up Migration

CREATE TABLE victims (
  id                 BIGSERIAL    PRIMARY KEY,
  hunter_telegram_id BIGINT       NOT NULL REFERENCES hunters(telegram_id) ON DELETE CASCADE,
  citizen_id         BIGINT       NOT NULL,
  citizen_name       TEXT         NOT NULL,
  citizen_country    TEXT,
  avatar_url         TEXT,
  nickname           TEXT,
  added_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (hunter_telegram_id, citizen_id)
);

CREATE INDEX victims_citizen_idx ON victims (citizen_id);

-- Down Migration

DROP TABLE victims;