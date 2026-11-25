import Config from "../Config.ts";
import { EVENT_TYPES } from "../gateway/events.ts";
import { filtersFor } from "../gateway/filter.ts";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "../gateway/protocol.ts";
import { STORED_RESOURCES } from "../ingester/sources.ts";
import { GATEWAY_NONCE_LIMIT, MAX_FILTER_IDs, MAX_FILTER_TAGS } from "../util/Constants.ts";

export interface DocHeading {
    depth: 2 | 3;
    id: string;
    /** Html with the tags taken out, so still escaped */
    text: string;
}

export interface DocPage {
    /** Rendered html */
    content: string;
    /** For the sidebar, the page's sections */
    headings: Array<DocHeading>;
    href: string;
    name: string;
    title: string;
}

// in the order they're linked
const PAGES = [
    { name: "index", href: "/", title: "Overview" },
    { name: "subscriptions", href: "/subscriptions", title: "Subscriptions" },
    { name: "events", href: "/events", title: "Events" },
    { name: "replaying", href: "/replaying", title: "Replaying" },
    { name: "snapshots", href: "/snapshots", title: "Snapshots" },
    { name: "compression", href: "/compression", title: "Compression" },
    { name: "close-codes", href: "/close-codes", title: "Close Codes" },
    { name: "clients", href: "/clients", title: "Clients" },
];

const dir = Bun.fileURLToPath(new URL("./pages/", import.meta.url));
const slug = (text: string): string => text.toLowerCase().replaceAll(/<[^>]+>/g, "").replaceAll(/[^\w\s-]/g, "").trim().replaceAll(/\s+/g, "-");

// event types with the same filters share a row, grouped by resource
function filterTable(): string {
    const rows = new Map<string, Array<string>>();
    for (const type of EVENT_TYPES) {
        const filters = filtersFor(type);
        const key = `${type.split(".")[0]}|${filters.length === 0 ? "none" : filters.map(name => `\`${name}\``).join(", ")}`;
        rows.set(key, [...rows.get(key) ?? [], `\`${type}\``]);
    }
    return ["| event | filters |", "|---|---|", ...[...rows].map(([key, types]) => `| ${types.join(", ")} | ${key.split("|")[1]} |`)].join("\n");
}

function replay(): string {
    const limit = Config.replayLimit.toLocaleString("en-US");
    return Config.replayPeriod === 0 ? `The last ${limit} events are kept.` : `Events are kept for ${Config.replayPeriod} hours, up to ${limit} of them.`;
}

// filled in when the pages are loaded, so the limits always match the config
const VALUES: Record<string, () => string> = {
    auth_cache: () => String(Math.round(Config.authCacheSeconds / 60)),
    auth_required: () => Config.wsAuthRequired ? "You have to authenticate to connect." : "Authenticating is optional, but it's needed for private events.",
    filters: filterTable,
    identify_timeout: () => String(Config.identifyTimeout / 1000),
    max_connections_ip: () => String(Config.maxConnectionsPerIP),
    max_connections_user: () => String(Config.maxConnectionsPerUser),
    max_filter_ids: () => MAX_FILTER_IDs.toLocaleString("en-US"),
    max_filter_tags: () => String(MAX_FILTER_TAGS),
    max_snapshot_ids: () => Config.maxSnapshotIDs.toLocaleString("en-US"),
    max_subscriptions: () => String(Config.maxSubscriptions),
    messages_per_minute: () => String(Config.maxClientMessagesPerMinute),
    nonce_limit: () => String(GATEWAY_NONCE_LIMIT),
    private_poll: () => String(Math.round(Config.e621PrivatePollInterval / 1000)),
    protocol_version: () => String(PROTOCOL_VERSION),
    protocol_versions: () => SUPPORTED_PROTOCOL_VERSIONS.join(", "),
    replay,
    snapshot_chunk: () => Config.snapshotChunkSize.toLocaleString("en-US"),
    snapshot_resources: () => STORED_RESOURCES.map(resource => `\`${resource}\``).join(", "),
    ws_url: () => Config.publicWSURL,
};

function render(source: string, name: string): Pick<DocPage, "content" | "headings"> {
    const headings: Array<DocHeading> = [];
    const filled = source.replaceAll(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const value = VALUES[key];
        if (!value) throw new Error(`pages/${name}.md uses {{${key}}}, which doesn't exist`);
        return value();
    });
    const content = Bun.markdown.html(filled)
        // ids so sections can be linked to
        .replaceAll(/<h([2-4])>(.*?)<\/h\1>/g, (_, depth: string, text: string) => {
            const id = slug(text);
            if (depth !== "4") headings.push({ depth: Number(depth) as 2 | 3, id, text: text.replaceAll(/<[^>]+>/g, "") });
            return `<h${depth} id="${id}">${text}</h${depth}>`;
        })
        .replaceAll("<table>", "<div class=\"table-responsive\"><table class=\"table table-sm table-bordered data-table\">")
        .replaceAll("</table>", "</table></div>");
    return { content, headings };
}

export const DOCS: Array<DocPage> = await Promise.all(PAGES.map(async page => ({ ...page, ...render(await Bun.file(`${dir}${page.name}.md`).text(), page.name) })));
