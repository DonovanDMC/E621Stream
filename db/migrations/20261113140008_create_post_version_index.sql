-- migrate:up
-- post version mod actions only log the post and version number, this finds the version's id without asking e621.
-- who made it and when is for post updates, which don't say who changed the post
CREATE TABLE post_version_index (
    post_id     BIGINT       NOT NULL,
    version     INTEGER      NOT NULL,
    id          BIGINT       NOT NULL,
    updater_id  BIGINT       NOT NULL,
    updated_at  TIMESTAMPTZ  NOT NULL,
    PRIMARY KEY  (post_id, version)
);

-- migrate:down
DROP TABLE post_version_index;
