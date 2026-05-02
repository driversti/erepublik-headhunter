-- Up Migration

CREATE TYPE hunter_status AS ENUM ('pending', 'active', 'denied', 'revoked');

CREATE TABLE hunters (
  telegram_id   BIGINT PRIMARY KEY,
  username      TEXT,
  status        hunter_status NOT NULL DEFAULT 'pending',
  registered_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ,
  decided_by    BIGINT
);

CREATE INDEX hunters_status_idx ON hunters (status);

-- Down Migration

DROP TABLE hunters;
DROP TYPE hunter_status;
