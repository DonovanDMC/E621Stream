import { AsyncLocalStorage } from "node:async_hooks";

import Config from "../config/Config.ts";

import type { SQL, TransactionSQL } from "bun";

const pool = new Bun.SQL(Config.databaseURL, { max: 4 });

interface Context {
    // the transaction, or a savepoint inside it
    sql: SQL;
    transaction: TransactionSQL;
}
const context = new AsyncLocalStorage<Context>();

// always on the pool
const POOL_ONLY = ["close", "end", "connect", "flush", "reserve"] as Array<PropertyKey>;

type Callback = (sql: TransactionSQL) => unknown;

// nested ones become savepoints
async function transaction(...args: [fn: Callback] | [options: string, fn: Callback]): Promise<unknown> {
    const [options, fn] = args.length === 1 ? [undefined, args[0]] : args;
    const current = context.getStore();
    if (current) {
        return current.transaction.savepoint(async sql => context.run({ sql, transaction: current.transaction }, () => fn(sql as TransactionSQL)));
    }
    const run = async (tx: TransactionSQL): Promise<unknown> => context.run({ sql: tx, transaction: tx }, () => fn(tx));
    return options === undefined ? pool.begin(run) : pool.begin(options, run);
}

function current(): SQL {
    return context.getStore()?.sql ?? pool;
}

/** Queries go to the current transaction if there is one, so it doesn't need passing around */
const DB = new Proxy(pool, {
    apply(_target, thisArg, args: Array<unknown>): unknown {
        return Reflect.apply(current(), thisArg, args);
    },
    get(_target, prop): unknown {
        if (prop === "begin" || prop === "transaction") return transaction;
        const sql = POOL_ONLY.includes(prop) ? pool : current();
        const value: unknown = Reflect.get(sql, prop, sql);
        return typeof value === "function" ? (value as (...args: Array<unknown>) => unknown).bind(sql) : value;
    },
});
export default DB;
