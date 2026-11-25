import Config from "../../Config.ts";
import { encrypt } from "../../util/Encryption.ts";
import { fingerprint } from "../../util/HMAC.ts";
import DB from "../DB.ts";
import Redis from "../Redis.ts";

import APIKeyLogin from "./APIKeyLogin.ts";
import Model from "./Model.ts";
import OAuthLogin from "./OAuthLogin.ts";
import Session from "./Session.ts";

import type { E621User } from "../../gateway/auth.ts";
import type { OAuthScope, OAuthToken } from "e621-openapi";

export const USER_ROLES = ["user", "admin", "owner"] as const;
export type UserRole = (typeof USER_ROLES)[number];
// each role can do everything the ones before it can
const MESSAGE_LIMIT_CACHE_SECONDS = 5 * 60;

const ROLE_LEVELS = Object.fromEntries(USER_ROLES.map((role, index) => [role, index])) as Record<UserRole, number>;
export const hasRole = (role: UserRole, required: UserRole): boolean => ROLE_LEVELS[role] >= ROLE_LEVELS[required];

export interface UserAttributes {
    id: number;
    last_login_at: Date | null;
    messages_per_minute: number;
    role: UserRole;
}

export default class User extends Model<UserAttributes> {
    static override readonly columns = ["id", "last_login_at", "messages_per_minute", "role"];
    static override readonly numbers = ["id"];
    static override readonly table = "users";

    declare id: number;
    declare last_login_at: Date | null;
    declare messages_per_minute: number;
    declare role: UserRole;

    private static async loggedIn(id: number): Promise<User> {
        const user = await User.find(id) ?? await User.create({ id });
        await user.update({ last_login_at: new Date() });
        return user;
    }

    // cached so the gateway doesn't ask postgres on every message, and cleared when it's changed
    private static messageLimitKey(id: number): string {
        return `${Config.redisPrefix}messageLimit:${id}`;
    }

    static async apikeyLogin(apiKey: string, info: E621User, ip: string, sessionID: string): Promise<{ login: APIKeyLogin; session: Session; user: User }> {
        const user = await User.loggedIn(info.id);
        const login = await APIKeyLogin.create({
            user_id: user.id,
            fingerprint: fingerprint(apiKey),
        });

        const session = await Session.create({
            id: fingerprint(sessionID),
            user_id: user.id,
            api_key_login_id: login.id,
            ip_address: ip,
            expires_at: new Date(Date.now() + (Config.sessionLength * 60 * 60 * 1000)),
        });

        return { login, session, user };
    }

    /** How many messages they can send the gateway a minute, people without an account get the default */
    static async messageLimit(id: number | null): Promise<number> {
        if (id === null) return Config.maxClientMessagesPerMinute;
        const key = User.messageLimitKey(id);
        const cached = await Redis.get(key);
        if (cached !== null) return Number(cached);
        const limit = (await User.find(id))?.messages_per_minute ?? Config.maxClientMessagesPerMinute;
        await Redis.set(key, String(limit), "EX", MESSAGE_LIMIT_CACHE_SECONDS);
        return limit;
    }

    static async oauthLogin(token: OAuthToken, info: E621User, ip: string, sessionID: string): Promise<{ login: OAuthLogin; session: Session; user: User }> {
        const user = await User.loggedIn(info.id);
        const login = await OAuthLogin.create({
            user_id: user.id,
            scopes: token.scope.split(" ") as Array<OAuthScope>,
            access_token: encrypt(token.access_token),
            refresh_token: encrypt(token.refresh_token),
            expires_at: new Date(Date.now() + (token.expires_in * 1000)),
            issued_at: new Date(token.created_at * 1000),
        });

        const session = await Session.create({
            id: fingerprint(sessionID),
            user_id: user.id,
            oauth_login_id: login.id,
            ip_address: ip,
            expires_at: new Date(Date.now() + (Config.sessionLength * 60 * 60 * 1000)),
        });

        return { login, session, user };
    }

    static async setMessageLimit(id: number, limit: number): Promise<void> {
        // they might not have logged in yet
        const user = await User.find(id) ?? await User.create({ id });
        await user.update({ messages_per_minute: limit });
        await Redis.del(User.messageLimitKey(id));
    }

    /** Everyone whose limit isn't the default */
    static async withMessageLimits(): Promise<Array<User>> {
        const rows = await DB<Array<{ id: string }>>`SELECT id FROM ${DB(User.table)} WHERE messages_per_minute <> ${Config.maxClientMessagesPerMinute}`;
        return User.whereIn("id", rows.map(row => Number(row.id)), {}, { order: { id: "ASC" } });
    }

    is(role: UserRole): boolean {
        return hasRole(this.role, role);
    }
}
