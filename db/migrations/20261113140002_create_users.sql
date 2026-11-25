-- migrate:up
CREATE TYPE user_role AS ENUM ('user', 'admin', 'owner');
CREATE TABLE users (
    id                   BIGINT       PRIMARY KEY,
    last_login_at        TIMESTAMPTZ,
    role                 user_role    NOT NULL  DEFAULT 'user',
    messages_per_minute  SMALLINT     NOT NULL  DEFAULT 60
);

-- migrate:down
DROP TABLE users;
DROP TYPE user_role;
