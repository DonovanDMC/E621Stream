// bun run client-types
import { dirname, resolve } from "node:path";

import ts from "typescript";

import { EVENT_TYPES, MOD_ACTION_EVENTS, PRIVATE_EVENT_TYPES, VERSION_EVENTS } from "../src/events.ts";
import { TRACKED, UPDATES } from "../src/ingester/updates.ts";

const root = resolve(import.meta.dir, "../");
const out = resolve(root, "clients/typescript/lib/generated.ts");
const MOD_ACTION_SOURCE = "https://raw.githubusercontent.com/e621ng/e621ng/master/app/models/mod_action.rb";

const RECORDS: Record<string, string> = {
    artist: "Artist",
    artist_url: "ArtistURL",
    artist_version: "ArtistVersion",
    avoid_posting: "AvoidPosting",
    avoid_posting_version: "AvoidPostingVersion",
    ban: "Ban",
    blip: "Blip",
    bulk_update_request: "BulkUpdateRequest",
    comment: "Comment",
    dmail: "DMail",
    forum_post: "ForumPost",
    forum_topic: "ForumTopic",
    help_page: "HelpPage",
    mod_action: "ModAction",
    news_update: "NewsUpdate",
    note: "Note",
    note_version: "NoteVersion",
    pool: "Pool",
    pool_version: "PoolVersion",
    post_approval: "PostApproval",
    post_event: "PostEvent",
    post_flag: "PostFlag",
    post_replacement: "PostReplacement",
    post_set: "PostSet",
    post_version: "PostVersion",
    tag: "Tag",
    tag_alias: "TagAlias",
    tag_implication: "TagImplication",
    tag_type_version: "TagTypeVersion",
    takedown: "Takedown",
    upload_karma_event: "UploadKarmaEvent",
    user: "User",
    user_feedback: "UserFeedback",
    wiki_page: "WikiPage",
    wiki_page_version: "WikiPageVersion",
};

function extractRecords(): string {
    // the e621-openapi version the e621 module uses
    const path = Bun.resolveSync("e621-openapi/types", dirname(Bun.resolveSync("e621/package.json", root))).replace(/\.js$/, ".d.ts");
    const source = ts.createSourceFile(path, ts.sys.readFile(path)!, ts.ScriptTarget.Latest, true);
    const aliases = new Map<string, ts.TypeAliasDeclaration>();
    source.forEachChild((node) => {
        if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node);
    });
    const wanted = new Set(Object.values(RECORDS).filter(name => name !== "ModAction" && name !== "UploadKarmaEvent"));
    // posts are sent in the legacy format
    wanted.add("LegacyPost");
    wanted.add("UploadKarmaEventsIndexResponses");
    const included = new Set<string>();
    const visit = (name: string): void => {
        const alias = aliases.get(name);
        if (!alias || included.has(name)) return;
        included.add(name);
        const walk = (node: ts.Node): void => {
            if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) visit(node.typeName.text);
            node.forEachChild(walk);
        };
        walk(alias.type);
    };
    for (const name of wanted) visit(name);
    return [...aliases.values()].filter(alias => included.has(alias.name.text)).map(alias => alias.getFullText(source).trim()).join("\n\n");
}

const RUBY_TYPES: Record<string, string> = { integer: "number", string: "string", boolean: "boolean", datetime: "string" };
// where what's sent differs from mod_action.rb
const VALUE_OVERRIDES: Record<string, Record<string, string>> = {
    user_flags_change: { added: "Array<string>", removed: "Array<string>" },
};

async function modActionValues(): Promise<string> {
    const source = await (await fetch(MOD_ACTION_SOURCE)).text();
    const lines: Array<string> = [];
    for (const match of source.matchAll(/^ {4}([a-z_]+): \{([^}]*)\},/gm)) {
        const [, action, body] = match as unknown as [string, string, string];
        const fields = [...body.matchAll(/([a-z_]+): :([a-z]+)/g)].map(([, key, type]) => `${key}: ${VALUE_OVERRIDES[action]?.[key!] ?? RUBY_TYPES[type!] ?? "unknown"}`);
        lines.push(`    ${action}: { ${fields.sort().join("; ")}${fields.length === 0 ? "" : " "}};`);
    }
    if (lines.length < 50) throw new Error(`only found ${lines.length} mod actions in ${MOD_ACTION_SOURCE}, its format probably changed`);
    return `export interface ModActionValues {\n${lines.sort().join("\n")}\n}`;
}

function eventMap(): string {
    const modActions = new Map<string, Array<string>>();
    for (const [action, event] of Object.entries(MOD_ACTION_EVENTS)) modActions.set(event!, [...modActions.get(event!) ?? [], action]);
    const versions = new Map(Object.entries(VERSION_EVENTS));
    const updates = new Map(UPDATES.map(source => [source.event as string, source]));
    const members = new Map<string, string>();
    for (const tracked of Object.values(TRACKED)) {
        if ("members" in tracked) {
            members.set(tracked.members.added, tracked.resource);
            members.set(tracked.members.removed, tracked.resource);
        }
    }
    const record = (resource: string): string => {
        const type = RECORDS[resource];
        if (!type) throw new Error(`no record type for ${resource}, add it to RECORDS in scripts/clientTypes.ts`);
        return type;
    };
    const lines: Array<string> = [];
    for (const type of [...EVENT_TYPES, ...PRIVATE_EVENT_TYPES]) {
        const resource = type.slice(0, type.indexOf("."));
        let data: string;
        if (type === "post.create") data = "{ post: LegacyPost }";
        else if (type === "post.update") data = "{ changes: PostChanges | null; post: LegacyPost }";
        else if (type === "post.destroy") data = "{ post: PostSnapshot; post_event: PostEvent }";
        else if (type === "post.stats") data = "PostStats";
        else if (type === "mod_action.create") data = "ModAction";
        else if (type === "post_replacement.destroy") data = `{ post_event: PostEvent; post_replacement: Pick<PostReplacement, "id" | ${TRACKED.postReplacement.fields.map(field => `"${field}"`).join(" | ")}> }`;
        else if (modActions.has(type)) data = `ModAction<${modActions.get(type)!.sort().map(action => `"${action}"`).join(" | ")}>`;
        else if (versions.has(type)) data = record(versions.get(type)!.slice(0, -".create".length));
        else if (members.has(type)) data = `Record<"${members.get(type)!}", ${record(members.get(type)!)}> & { post_ids: Array<number> }`;
        else if (type === "pool.add_posts" || type === "pool.remove_posts") data = "{ pool_version: PoolVersion; post_ids: Array<number> }";
        else if (type === "private_post_set.add_posts" || type === "private_post_set.remove_posts") data = `{ post_ids: Array<number>; post_set: ${record("post_set")} }`;
        else if (updates.has(type)) {
            const source = updates.get(type)!;
            data = `Update<"${source.resource}", ${record(source.resource)}, ${source.fields.map(field => `"${field}"`).join(" | ")}>`;
        } else if (type.endsWith(".create")) data = record(resource);
        else throw new Error(`don't know what ${type} is sent with, add it to scripts/clientTypes.ts`);
        lines.push(`    "${type}": ${data};`);
    }
    return `/** The \`data\` each event type is sent with. */\nexport interface EventDataMap {\n${lines.join("\n")}\n}`;
}

function snapshotMap(): string {
    const lines = ["    post: PostSnapshot;"];
    for (const tracked of Object.values(TRACKED)) {
        const fields = ["id", ...tracked.fields, ...("members" in tracked ? [tracked.members.field] : [])];
        lines.push(`    ${tracked.resource}: Pick<${RECORDS[tracked.resource]!}, ${fields.map(field => `"${field}"`).join(" | ")}>;`);
    }
    return `/** What \`snapshot\` sends back for each resource. */\nexport interface SnapshotDataMap {\n${lines.join("\n")}\n}`;
}

const header = `// generated by scripts/clientTypes.ts in the E621Stream repository, don't edit by hand
/* eslint-disable */`;
const body = [
    header,
    "import type { Changes, PostChanges, PostSnapshot, PostStats } from \"./changes.ts\";",
    "// records, from the e621-openapi module's types (https://www.npmjs.com/package/e621-openapi)",
    extractRecords(),
    "export type UploadKarmaEvent = UploadKarmaEventsIndexResponses[200][number];",
    `// the values each mod action is logged with, from ${MOD_ACTION_SOURCE}`,
    await modActionValues(),
    "export type ModActionName = keyof ModActionValues;",
    `/** Checking \`action\` narrows \`values\`. */
export type ModAction<A extends ModActionName = ModActionName> = A extends ModActionName ? {
    action: A;
    created_at: string;
    creator_id: number;
    id: number;
    updated_at: string;
    /** What the action applies to. */
    values: ModActionValues[A];
} : never;`,
    `/** \`changes\` is null when the previous state isn't known. */
export type Update<Resource extends string, R, Field extends keyof R & string> = Record<Resource, R> & { changes: Changes<R, Field> | null };`,
    eventMap(),
    snapshotMap(),
];
await Bun.write(out, `${body.join("\n\n")}\n`);
console.log(`wrote ${out}`);

const modActionEvents = [...new Set(Object.values(MOD_ACTION_EVENTS) as Array<string>)].sort();
const versionEvents = Object.keys(VERSION_EVENTS).sort();
const tsList = (name: string, types: ReadonlyArray<string>): string => `export const ${name} = [\n${types.map(type => `    "${type}",\n`).join("")}] as const;`;
const eventsPath = resolve(root, "clients/typescript/lib/events.ts");
let events = await Bun.file(eventsPath).text();
for (const [name, types] of [["EVENT_TYPES", EVENT_TYPES], ["PRIVATE_EVENT_TYPES", PRIVATE_EVENT_TYPES], ["MOD_ACTION_EVENT_TYPES", modActionEvents], ["VERSION_EVENT_TYPES", versionEvents]] as const) {
    events = events.replace(new RegExp(`export const ${name} = \\[[^\\]]*\\] as const;`), tsList(name, types));
}
await Bun.write(eventsPath, events);
console.log(`wrote ${eventsPath}`);

const words = (types: ReadonlyArray<string>, indent: string): string => {
    const lines: Array<string> = [];
    let line = "";
    for (const type of types) {
        if (line && indent.length + line.length + type.length + 1 > 118) {
            lines.push(indent + line);
            line = "";
        }
        line += line ? ` ${type}` : type;
    }
    return [...lines, indent + line].join("\n");
};
const rubyPath = resolve(root, "clients/ruby/lib/e621stream/events.rb");
await Bun.write(rubyPath, `# frozen_string_literal: true
# typed: strict

module E621Stream
  module Events
    # Generated by scripts/clientTypes.ts in the E621Stream repository, from the server's src/events.ts.
    EVENT_TYPES = %w[
${words(EVENT_TYPES, "      ")}
    ].freeze

    # Polled with your own credentials and only sent to you. They have to be subscribed to by name, \`*\` doesn't include
    # them.
    PRIVATE_EVENT_TYPES = %w[${PRIVATE_EVENT_TYPES.join(" ")}].freeze
  end
end
`);
console.log(`wrote ${rubyPath}`);
process.exit(0);
