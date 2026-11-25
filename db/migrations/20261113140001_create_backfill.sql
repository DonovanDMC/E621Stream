-- migrate:up
CREATE TYPE backfill_kind AS ENUM ('crawl', 'export');
CREATE TYPE backfill_status AS ENUM ('done', 'failed', 'pending', 'running', 'waiting');
CREATE TABLE backfill (
    source       TEXT             PRIMARY KEY,
    kind         backfill_kind    NOT NULL,
    status       backfill_status  NOT NULL DEFAULT  'pending',
    cursor       BIGINT,
    ceiling      BIGINT,
    stored       BIGINT           NOT NULL DEFAULT  0,
    detail       TEXT,
    error        TEXT,
    lanes        JSONB, -- Array<{ cursor: number; lower: number }>
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ      NOT NULL DEFAULT  now()
);

-- migrate:down
DROP TABLE backfill;
DROP TYPE backfill_status;
DROP TYPE backfill_kind;
