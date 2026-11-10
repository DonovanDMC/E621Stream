import Debug from "@yiffy/debug";

import { adminChannel, bansKey } from "../config.ts";
import redis, { createRedis } from "../redis.ts";

import { CloseCodes } from "./protocol.ts";
import { sessions } from "./session.ts";

export interface Ban {
    banned_at: string;
    banned_by: string;
    name: string | null;
    reason: string | null;
    user_id: number;
}

type Command = { op: "drop"; session_id: string } | { op: "ban"; user_id: number };

export async function isBanned(userId: number): Promise<boolean> {
    return Boolean(await redis.send("HEXISTS", [bansKey, String(userId)]));
}

export async function listBans(): Promise<Array<Ban>> {
    const values = await redis.send("HVALS", [bansKey]) as Array<string>;
    return values.map(value => JSON.parse(value) as Ban).sort((a, b) => b.banned_at.localeCompare(a.banned_at));
}

export async function ban(entry: Ban): Promise<void> {
    await redis.send("HSET", [bansKey, String(entry.user_id), JSON.stringify(entry)]);
    await redis.publish(adminChannel, JSON.stringify({ op: "ban", user_id: entry.user_id } satisfies Command));
}

export async function unban(userId: number): Promise<void> {
    await redis.send("HDEL", [bansKey, String(userId)]);
}

export async function drop(sessionId: string): Promise<void> {
    await redis.publish(adminChannel, JSON.stringify({ op: "drop", session_id: sessionId } satisfies Command));
}

function run(command: Command): void {
    for (const session of sessions) {
        if (command.op === "drop" && session.id === command.session_id) session.close(CloseCodes.DISCONNECTED, "disconnected by an admin");
        else if (command.op === "ban" && session.user?.id === command.user_id) session.close(CloseCodes.BANNED, "banned");
    }
}

export async function startModeration(): Promise<void> {
    const subscriber = createRedis();
    await subscriber.subscribe(adminChannel, (message) => {
        try {
            run(JSON.parse(message) as Command);
        } catch (err) {
            Debug("gateway:admin", `bad command: ${String(err)}`);
        }
    });
}
