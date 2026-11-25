// Maintenance commands, in the image as e621stream: docker compose exec -it http e621stream <command>
import DB from "../db/DB.ts";

import * as backfill from "./backfill.ts";
import * as promote from "./promote.ts";

interface Command {
    description: string;
    usage: string;
    run(args: Array<string>): Promise<boolean>;
}

const COMMANDS: Record<string, Command> = { backfill, promote };

function help(): void {
    console.error("usage: e621stream <command>\n");
    for (const command of Object.values(COMMANDS)) console.error(`  ${command.usage}\n      ${command.description}`);
}

const [name, ...args] = process.argv.slice(2);
const command = name === undefined ? undefined : COMMANDS[name];
if (!command) {
    help();
    process.exit(1);
}

const ok = await command.run(args);
if (!ok) console.error(`usage: e621stream ${command.usage}`);
await DB.close();
process.exit(ok ? 0 : 1);
