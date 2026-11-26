-- migrate:up
-- every event and notice, for replaying. the redis stream only keeps the last few minutes for live delivery.
-- ms and seq are the stream id. split into an hour per partition by the ingester, so old hours are dropped whole
CREATE TABLE events (
    ms    BIGINT  NOT NULL,
    seq   BIGINT  NOT NULL,
    type  TEXT    NOT NULL,
    item  JSON    COMPRESSION lz4 NOT NULL,
    PRIMARY KEY  (ms, seq)
) PARTITION BY RANGE (ms);

-- migrate:down
DROP TABLE events;
