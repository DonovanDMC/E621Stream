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
    /** Every this many starts one is background if any are waiting, so it isn't starved by a busy foreground. 0 turns it off */
    backgroundShare: number;
    inFlight = 0;
    interval: number;
    lastStart = 0;
    reserving = false;
    shared: boolean;
    sinceBackground = 0;
    timer: NodeJS.Timeout | null = null;
    waiting: Array<{ background: boolean; start(): void }> = [];
    constructor(interval: number, shared = false, backgroundShare = 0) {
        this.interval = interval;
        this.shared = shared;
        this.backgroundShare = backgroundShare;
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
        const background = this.waiting.findIndex(item => item.background);
        const due = this.backgroundShare > 0 && background !== -1 && this.sinceBackground >= this.backgroundShare - 1;
        const [next] = this.waiting.splice(due || foreground === -1 ? Math.max(background, 0) : foreground, 1);
        if (!next) return;
        this.sinceBackground = next.background ? 0 : this.sinceBackground + 1;
        this.lastStart = Date.now();
        next.start();
        this.pump();
    }

    schedule<T>(fn: () => Promise<T>): Promise<T> {
        return this.enqueue(fn, false);
    }
}
