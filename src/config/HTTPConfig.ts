import { z } from "zod";

import Config from "./Config.ts";
import { parseEnv } from "./env.ts";

const env = parseEnv("http", z.object({
    HTTP_PORT: z.coerce.number().int().positive().default(3000),
    HTTP_SESSION_LENGTH: z.coerce.number().int().positive().default(24), // hours, how long logins on the site last
    HTTP_MAX_TOKENS_PER_USER: z.coerce.number().int().positive().default(10),
    // logging in with e621, and private events through gateway tokens
    HTTP_OAUTH_CLIENT_ID: z.string().optional(),
    HTTP_OAUTH_CLIENT_SECRET: z.string().optional(),
    HTTP_OAUTH_REDIRECT_URI: z.string().optional(),
}));

const HTTPConfig = {
    port: env.HTTP_PORT,
    sessionLength: env.HTTP_SESSION_LENGTH,
    maxTokensPerUser: env.HTTP_MAX_TOKENS_PER_USER,
    oauthEnabled: env.HTTP_OAUTH_CLIENT_ID && env.HTTP_OAUTH_CLIENT_SECRET,
    oauthClientID: env.HTTP_OAUTH_CLIENT_ID,
    oauthClientSecret: env.HTTP_OAUTH_CLIENT_SECRET,
    oauthRedirectURI: env.HTTP_OAUTH_REDIRECT_URI ?? new URL("/user/login/oauth/callback", Config.publicURL).href,
} as const;

export default HTTPConfig;
