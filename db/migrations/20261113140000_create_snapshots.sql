-- migrate:up
CREATE TABLE snapshots (
    id        BIGINT  NOT NULL,
    resource  TEXT    NOT NULL,
    version   BIGINT  NOT NULL,
    data      JSONB   NOT NULL,
    PRIMARY KEY  (resource, id)
);
-- replacement post events only log the post
CREATE INDEX snapshots_post_replacement_post ON snapshots (((data->>'post_id')::bigint)) WHERE resource = 'post_replacement';
-- tag_destroy mod actions only log the name
CREATE INDEX snapshots_tag_name ON snapshots ((data->>'name')) WHERE resource = 'tag';
-- artist versions list the artist's urls, they're compared against these
CREATE INDEX snapshots_artist_url_artist ON snapshots (((data->>'artist_id')::bigint)) WHERE resource = 'artist_url';
-- updates are matched to the mod action that made them, newest first
CREATE INDEX snapshots_mod_action ON snapshots ((data->>'action'), id) WHERE resource = 'mod_action';
-- user_unban mod actions only log the user
CREATE INDEX snapshots_ban_user ON snapshots (((data->>'user_id')::bigint)) WHERE resource = 'ban';

-- migrate:down
DROP TABLE snapshots;
