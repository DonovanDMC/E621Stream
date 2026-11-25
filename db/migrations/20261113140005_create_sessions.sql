-- migrate:up
CREATE TABLE sessions (
    id                   TEXT         PRIMARY KEY, -- hmac(sha256, session token) fingerprint, not the token itself
    user_id              BIGINT       NOT NULL  REFERENCES users (id) ON DELETE CASCADE,
    api_key_login_id     BIGINT       REFERENCES api_key_logins (id) ON DELETE CASCADE,
    oauth_login_id       BIGINT       REFERENCES oauth_logins (id) ON DELETE CASCADE,
    ip_address           INET         NOT NULL,
    created_at           TIMESTAMPTZ  NOT NULL  DEFAULT now(),
    last_used_at         TIMESTAMPTZ  NOT NULL  DEFAULT now(),
    expires_at           TIMESTAMPTZ  NOT NULL,
    -- logged in with either an api key or oauth
    CHECK (num_nonnulls(api_key_login_id, oauth_login_id) = 1)
);
CREATE INDEX sessions_user_id ON sessions (user_id);
CREATE INDEX sessions_api_key_login_id ON sessions (api_key_login_id);
CREATE INDEX sessions_oauth_login_id ON sessions (oauth_login_id);

-- migrate:down
DROP TABLE sessions;
