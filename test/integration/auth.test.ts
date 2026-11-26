import { beforeEach, describe, expect, test } from "bun:test";

import GatewayConfig from "../../src/config/GatewayConfig.ts";
import DB from "../../src/db/DB.ts";
import GatewayToken from "../../src/db/models/GatewayToken.ts";
import User from "../../src/db/models/User.ts";
import { parseAuthHeader, verify } from "../../src/gateway/auth.ts";
import { MESSAGE_LIMIT_MAX } from "../../src/util/Constants.ts";
import { reset, tokenUser } from "../helpers.ts";

beforeEach(reset);

describe("gateway tokens", () => {
    test("only the fingerprint is stored", async () => {
        const { token } = await tokenUser();
        const [row] = await DB<Array<{ fingerprint: string }>>`SELECT fingerprint FROM gateway_tokens`;
        expect(row!.fingerprint).not.toContain(token);
        expect((await GatewayToken.findByToken(token))?.user_id).toBe(1);
        expect(await GatewayToken.findByToken(`${token}x`)).toBeNull();
    });

    test("verify gives the user from the oauth link", async () => {
        const { token } = await tokenUser(1, { privateEvents: true });
        expect(await verify({ token })).toEqual({ ok: true, private: true, user: { id: 1, name: "user_1", level: 20, level_string: "Member" } });
        expect((await GatewayToken.findByToken(token))?.last_used_at).toBeInstanceOf(Date);
    });

    test("private events need the token setting and a full access link", async () => {
        expect(await verify({ token: (await tokenUser(1)).token })).toMatchObject({ private: false });
        expect(await verify({ token: (await tokenUser(2, { full: false, privateEvents: true })).token })).toMatchObject({ private: false });
    });

    test("unknown, revoked and banned", async () => {
        expect(await verify({ token: "e6s_nope" })).toMatchObject({ ok: false });
        const { token } = await tokenUser(1);
        await DB`DELETE FROM oauth_links`;
        expect(await verify({ token })).toMatchObject({ ok: false });
        expect(await verify({ token: (await tokenUser(2, { banned: true })).token })).toMatchObject({ ok: false });
    });
});

test("parseAuthHeader", () => {
    expect(parseAuthHeader("Bearer e6s_abc")).toEqual({ token: "e6s_abc" });
    expect(parseAuthHeader(`Basic ${btoa("someone:key")}`)).toEqual({ username: "someone", apiKey: "key" });
    expect(parseAuthHeader(null)).toBeNull();
    expect(parseAuthHeader("Nope abc")).toBeNull();
});

describe("message limits", () => {
    test("the default, then what an admin set", async () => {
        await User.create({ id: 1, role: "user" });
        expect(await User.messageLimit(1)).toBe(GatewayConfig.maxMessagesPerMinute);
        expect(await User.messageLimit(null)).toBe(GatewayConfig.maxMessagesPerMinute);
        await User.setMessageLimit(1, MESSAGE_LIMIT_MAX);
        expect(await User.messageLimit(1)).toBe(MESSAGE_LIMIT_MAX);
        expect((await User.withMessageLimits()).map(user => user.id)).toEqual([1]);
    });
});
