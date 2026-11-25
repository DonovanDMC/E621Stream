import Session from "../db/models/Session.ts";
import User from "../db/models/User.ts";
import { SESSION_COOKIE } from "../util/Constants.ts";
import { fingerprint } from "../util/HMAC.ts";

import { currentRequest } from "./Flash.ts";
import GenericError from "./views/GenericError.tsx";
import { render } from "./Views.ts";

import type APIKeyLogin from "../db/models/APIKeyLogin.ts";
import type OAuthLogin from "../db/models/OAuthLogin.ts";
import type { UserRole } from "../db/models/User.ts";
import type { AnyPathMiddleware } from "@yiffy/bun-router";

export async function getLogin(req: Bun.BunRequest): Promise<OAuthLogin | APIKeyLogin | null> {
    const value = req.cookies.get(SESSION_COOKIE);
    if (!value) return null;
    const session = await Session.find(fingerprint(value));
    if (!session) {
        console.warn(`Session for ${fingerprint(value)} not found`);
        req.cookies.delete(SESSION_COOKIE);
        return null;
    }
    const login = await session.getLogin();
    if (!login) {
        console.warn(`login for session ${fingerprint(value)} not found (${session.api_key_login_id ? "APIKeyLogin" : session.oauth_login_id ? "OAuthKeyLogin" : "None"})`);
        req.cookies.delete(SESSION_COOKIE);
        return null;
    }

    return login;
}

// filled by loginRequired too, so pages behind it don't look the user up twice
const users = new WeakMap<Request, User | null>();

export function loginRequired(roleRequired?: UserRole): AnyPathMiddleware<{ sessionID: string; user: User }> {
    return async (req, server, next) => {
        const login = await getLogin(req as Bun.BunRequest);
        if (!login) {
            const url = new URL(req.url);
            return Response.redirect(`/user/login?return=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
        }
        const user = await User.find(login.user_id);
        if (!user) return render(<GenericError title="Error" message="User not found?" />, 500);
        if (roleRequired && !user.is(roleRequired)) return render(<GenericError title="Access Denied" message="You don't have access to that." />, 403);
        users.set(req, user);
        return next(Object.assign(req, { sessionID: req.cookies.get(SESSION_COOKIE)!, user }), server);
    };
}

export async function getUser(req: Bun.BunRequest): Promise<User | null> {
    const login = await getLogin(req);
    if (login === null) return null;
    const user = await User.find(login.user_id);
    return user;
}

/** The user for the request being handled, null when logged out */
export async function currentUser(): Promise<User | null> {
    const req = currentRequest();
    if (!req) return null;
    if (!users.has(req)) users.set(req, await getUser(req));
    return users.get(req) ?? null;
}

export async function logout(req: Bun.BunRequest): Promise<void> {
    const value = req.cookies.get(SESSION_COOKIE);
    if (!value) return;
    await (await Session.find(fingerprint(value)))?.destroy();
    req.cookies.delete(SESSION_COOKIE);
}
