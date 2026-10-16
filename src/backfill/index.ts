// bun run backfill status
// bun run backfill verify
// bun run backfill reset <source|all>
// bun run backfill run <source...>
import sql, { migrate } from "../db.ts";
import { hasAuth } from "../e621.ts";

import { runSource, SOURCES } from "./runner.ts";
import { listStates, resetState } from "./state.ts";
import { verify } from "./verify.ts";

const [command, ...args] = process.argv.slice(2);
const names = (list: Array<string>): Array<string> => {
    const all = SOURCES.map(source => source.name);
    const picked = list.includes("all") ? all : list;
    const unknown = picked.filter(name => !all.includes(name));
    if (picked.length === 0 || unknown.length !== 0) {
        console.error(`unknown source(s): ${unknown.join(", ") || "(none given)"}\navailable: ${all.join(", ")}, all`);
        process.exit(1);
    }
    return picked;
};

await migrate();
switch (command) {
    case "status": {
        const states = new Map((await listStates()).map(state => [state.source, state]));
        for (const source of SOURCES) {
            const state = states.get(source.name);
            const progress = state?.ceiling ? ` ${Math.round(((state.kind === "crawl" ? state.ceiling - (state.cursor ?? state.ceiling) : state.cursor ?? 0) / state.ceiling) * 100)}%` : "";
            console.log(`${source.name.padEnd(22)} ${(state?.status ?? "pending").padEnd(8)} ${String(state?.stored ?? 0).padStart(10)} stored${progress}${state?.error ? `  ${state.error}` : state?.detail ? `  ${state.detail}` : ""}`);
        }
        break;
    }
    case "verify": {
        if (!hasAuth) throw new Error("E621_AUTH_USER and E621_AUTH_KEY are required");
        await verify();
        break;
    }
    case "reset": {
        for (const name of names(args)) await resetState(name);
        break;
    }
    case "run": {
        if (!hasAuth) throw new Error("E621_AUTH_USER and E621_AUTH_KEY are required");
        for (const name of names(args)) await runSource(SOURCES.find(source => source.name === name)!);
        break;
    }
    default: {
        console.error("usage: bun run backfill <status|verify|reset <source|all>|run <source...>>");
        process.exit(1);
    }
}
await sql.close();
process.exit(0);
