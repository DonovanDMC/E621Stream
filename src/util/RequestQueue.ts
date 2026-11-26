import Config from "../config/Config.ts";
import Redis from "../db/Redis.ts";

const MAX_IN_FLIGHT = 2;

const RESERVE = `
local now = tonumber(ARGV[1])
local start = math.max(now, tonumber(redis.call("GET", KEYS[1]) or "0") + tonumber(ARGV[2]))
redis.call("SET", KEYS[1], start, "PX", 60000)
return start
`;
async function reserve(): Promise<number> {
    return Number(await Redis.send("EVAL", [RESERVE, "1", `${Config.redisPrefix}e621:last_request`, String(Date.now()), String(Config.e621RequestInterval)]));
}

export interface Scheduler { schedule<T>(fn: () => Promise<T>): Promise<T> }
export default class RequestQueue implements Scheduler {
    background: Scheduler = { schedule: fn => this.enqueue(fn, true) };
    inFlight = 0;
    interval: number;
    lastStart = 0;
    reserving = false;
    shared: boolean;
    timer: NodeJS.Timeout | null = null;
    waiting: Array<{ background: boolean; start(): void }> = [];
    constructor(interval: number, shared = false) {
        this.interval = interval;
        this.shared = shared;
    }

    private enqueue<T>(fn: () => Promise<T>, background: boolean): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.waiting.push({
                background,
                start: () => {
                    this.inFlight++;
                    fn().then(resolve, reject).finally(() => {
                        this.inFlight--;
                        this.pump();
                    });
                },
            });
            this.pump();
        });
    }

    private pump(): void {
        const now = Date.now();
        if (this.timer !== null || this.reserving || this.waiting.length === 0 || this.inFlight >= MAX_IN_FLIGHT) return;
        const wait = this.lastStart + this.interval - now;
        if (wait > 0) {
            this.timer = setTimeout(() => {
                this.timer = null;
                this.pump();
            }, wait);
            return;
        }
        if (!this.shared) {
            this.startNext();
            return;
        }

        this.reserving = true;
        void reserve()
            .then(start => start > now ? Bun.sleep(start - now) : undefined)
            .catch((err: unknown) => {
                console.error(`Redis failed to reserve request: ${String(err)}`);
            })
            .then(() => {
                this.reserving = false;
                this.startNext();
            });
    }

    private startNext(): void {
        const foreground = this.waiting.findIndex(item => !item.background);
        const [next] = this.waiting.splice(foreground === -1 ? 0 : foreground, 1);
        if (!next) return;
        this.lastStart = Date.now();
        next.start();
        this.pump();
    }

    schedule<T>(fn: () => Promise<T>): Promise<T> {
        return this.enqueue(fn, false);
    }
}
