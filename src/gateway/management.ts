import Debug from "@yiffy/debug";

import Config from "../config/Config.ts";
import Redis, { createRedis } from "../db/Redis.ts";
import I18n from "../util/I18n.ts";

import { CloseCodes } from "./protocol.ts";

import type Session from "./Session.ts";

export interface Ban {
    banned_at: string; // ISO timestamp
    banned_by: string;
    name: string | null;
    reason: string | null;
    user_id: number;
}

interface BanCommand { op: "ban"; user_id: number }
interface DropCommand { op: "drop"; session_id: string }
interface RecheckTokenCommand { fingerprint: string; op: "recheck_token" }
type Command = BanCommand | DropCommand | RecheckTokenCommand;

const bansKey = `${Config.redisPrefix}bans`;
const managementChannel = `${Config.redisPrefix}management`;

export async function isBanned(userID: number): Promise<boolean> {
    return await Redis.hexists(bansKey, String(userID));
}

export async function listBans(): Promise<Array<Ban>> {
    const values = await Redis.hvals(bansKey);
    return values.map(value => JSON.parse(value) as Ban).sort((a, b) => b.banned_at.localeCompare(a.banned_at));
}

export async function ban(entry: Ban): Promise<void> {
    await Redis.hset(bansKey, String(entry.user_id), JSON.stringify(entry));
    await Redis.publish(managementChannel, JSON.stringify({ op: "ban", user_id: entry.user_id } satisfies Command));
}

export async function unban(userID: number): Promise<void> {
    await Redis.hdel(bansKey, String(userID));
}

// sessions are spread over every gateway, so they're told to drop it instead
export async function drop(sessionID: string): Promise<void> {
    await Redis.publish(managementChannel, JSON.stringify({ op: "drop", session_id: sessionID } satisfies Command));
}

/** A gateway token was deleted or changed, the sessions using it are checked again now instead of at the next recheck */
export async function recheckToken(fingerprint: string): Promise<void> {
    await Redis.publish(managementChannel, JSON.stringify({ op: "recheck_token", fingerprint } satisfies Command));
}

function run(sessions: Array<Session>, command: Command): void {
    // closing can remove from sessions
    for (const session of [...sessions]) {
        if (command.op === "drop" && session.id === command.session_id) void session.close(CloseCodes.Disconnected, I18n.t("gateway.disconnected"));
        else if (command.op === "ban" && session.user?.id === command.user_id) void session.close(CloseCodes.Banned, I18n.t("gateway.auth.banned"));
        else if (command.op === "recheck_token" && session.usesToken(command.fingerprint)) void session.recheckAuth();
    }
}

export async function startManagement(sessions: Array<Session>): Promise<void> {
    // subscribing takes over the connection, so it needs its own
    const subscriber = createRedis();
    await subscriber.subscribe(managementChannel, (message) => {
        try {
            run(sessions, JSON.parse(message) as Command);
        } catch (err) {
            Debug("gateway:management", `bad command: ${String(err)}`);
        }
    });
}
