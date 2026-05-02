-- Up Migration
--
-- Stores the full SessionRecord (matches src/erep/session-store.ts).
-- Single-row table: id is fixed at 1 via CHECK so we can UPSERT idempotently.

CREATE TABLE bot_session (
  id                 INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  email              TEXT        NOT NULL,
  cookies            JSONB       NOT NULL,
  saved_at           TIMESTAMPTZ NOT NULL,
  last_validated_at  TIMESTAMPTZ
);

-- Down Migration

DROP TABLE bot_session;