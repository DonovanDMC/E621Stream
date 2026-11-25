import DB from "../src/db/DB.ts";
import GatewayToken from "../src/db/models/GatewayToken.ts";
import OAuthLink from "../src/db/models/OAuthLink.ts";
import User from "../src/db/models/User.ts";
import Redis from "../src/db/Redis.ts";
import { encrypt } from "../src/util/Encryption.ts";

/** Empties every table and redis */
export async function reset(): Promise<void> {
    const tables = await DB<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != 'schema_migrations'`;
    await DB.unsafe(`TRUNCATE ${tables.map(table => `"${table.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
    await Redis.send("FLUSHDB", []);
}

export const sleep = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function waitFor<T>(fn: () => T | null | false | Promise<T | null | false>, label: string, ms = 5000): Promise<T> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const value = await fn();
        if (value) return value;
        await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
}

/** Runs one of the services in its own process, stop it with stopService in afterAll */
export async function startService(entry: string, url: string, env: Record<string, string> = {}): Promise<Bun.Subprocess> {
    const proc = Bun.spawn(["bun", entry], { env: { ...Bun.env, ...env }, stdout: "inherit", stderr: "inherit" });
    await waitFor(async () => fetch(`${url}/health`).then(res => res.ok, () => false), `${entry} to start`, 15_000);
    return proc;
}

export async function stopService(proc: Bun.Subprocess | undefined): Promise<void> {
    proc?.kill();
    await proc?.exited;
}

/** A user with an e621 oauth link and a gateway token, like one made on the site */
export async function tokenUser(id = 1, { banned = false, full = true, privateEvents = false } = {}): Promise<{ token: string; user: User }> {
    const user = await User.create({ id, role: "user" });
    await OAuthLink.create({
        user_id: id,
        scopes: full ? ["openid", "profile", "full"] : ["openid", "profile"],
        access_token: encrypt("access"),
        refresh_token: encrypt("refresh"),
        cached_data: { banned, user: { id, name: `user_${id}`, level: 20, level_string: "Member" } },
        issued_at: new Date(),
        expires_at: new Date(Date.now() + 86_400_000),
        checked_at: new Date(),
    });
    const { token } = await GatewayToken.generate({ name: "tests", user_id: id, private_events: privateEvents });
    return { token, user };
}

const sockets: Array<TestSocket> = [];
/** For afterEach, so one test's connections don't get the next one's events */
export function closeSockets(): void {
    for (const socket of sockets.splice(0)) socket.close();
}

export interface Message { d?: unknown; op: string; s?: string; t?: string }

/** A websocket that keeps what it's sent, so tests can wait for the next of something */
export class TestSocket {
    private seen = 0;
    closed: { code: number; reason: string } | null = null;
    messages: Array<Message> = [];
    ws: WebSocket;

    constructor(url: string) {
        this.ws = new WebSocket(url);
        this.ws.addEventListener("message", ({ data }) => this.messages.push(JSON.parse(String(data)) as Message));
        this.ws.addEventListener("close", ({ code, reason }) => this.closed = { code, reason });
        sockets.push(this);
    }

    close(): void {
        if (!this.closed) this.ws.close();
    }

    async closedWith(): Promise<{ code: number; reason: string }> {
        return waitFor(() => this.closed, "the socket to close");
    }

    /** Opens, then identifies once hello arrives */
    async identify(d: Record<string, unknown>): Promise<Message> {
        await this.next("hello");
        this.send("identify", d);
        return this.next("ready");
    }

    /** The next message with this op, skipping others */
    async next(op: string, ms = 5000): Promise<Message> {
        return waitFor(() => {
            const index = this.messages.findIndex((message, i) => i >= this.seen && message.op === op);
            if (index === -1) return null;
            this.seen = index + 1;
            return this.messages[index]!;
        }, `${op} (got ${this.messages.slice(this.seen).map(message => message.op === "error" ? `error: ${JSON.stringify(message.d)}` : message.op).join(", ") || "nothing"}${this.closed ? `, closed with ${this.closed.code}` : ""})`, ms);
    }

    /** Whether nothing with this op arrives for a bit */
    async nothing(op: string, ms = 300): Promise<boolean> {
        await sleep(ms);
        return !this.messages.slice(this.seen).some(message => message.op === op);
    }

    send(op: string, d?: unknown): void {
        this.ws.send(JSON.stringify({ op, d }));
    }
}
