-- Up Migration

CREATE TABLE alerted_rounds (
  hunter_telegram_id BIGINT       NOT NULL,
  battle_id          BIGINT       NOT NULL,
  zone_id            INTEGER      NOT NULL,
  alerted_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hunter_telegram_id, battle_id, zone_id)
);

-- Cleanup queries delete by alerted_at; index keeps it cheap.
CREATE INDEX alerted_rounds_alerted_at_idx ON alerted_rounds (alerted_at);

-- Used by /poll/scheduler to hydrate the in-memory dedup set on boot.
-- (We just SELECT * — no extra index needed since the table stays small.)

-- Down Migration

DROP TABLE alerted_rounds;