import { EVENT_TYPES, isEventType, isPrivateEventType, MOD_ACTION_EVENT_TYPES, PRIVATE_EVENT_TYPES, VERSION_EVENTS, type EventType, type PrivateEventType, type StreamEvent } from "../events.ts";

export interface Filter {
    actions?: Array<string>;
    pool_ids?: Array<number>;
    post_ids?: Array<number>;
    set_ids?: Array<number>;
    tags?: string;
    topic_ids?: Array<number>;
    user_ids?: Array<number>;
}

export interface Subscription {
    filter?: Filter;
    type: string;
}

interface TagQuery { all: Array<string>; any: Array<string>; none: Array<string>; notRatings: Set<string>; ratings: Set<string> | null }

export interface CompiledSubscription {
    actions: Set<string> | null;
    poolIds: Set<number> | null;
    postIds: Set<number> | null;
    privateTypes: Set<PrivateEventType>;
    setIds: Set<number> | null;
    source: Subscription;
    tags: TagQuery | null;
    topicIds: Set<number> | null;
    types: Set<EventType>;
    userIds: Set<number> | null;
}

interface Facets {
    action?: string;
    poolIds?: Array<number>;
    postIds?: Array<number>;
    rating?: string;
    setIds?: Array<number>;
    tags?: Set<string>;
    topicId?: number;
    userIds: Array<number>;
}

export class FilterError extends Error {}

const RATINGS: Record<string, string> = { s: "s", safe: "s", q: "q", questionable: "q", e: "e", explicit: "e" };
const MAX_IDS = 1000;
const MAX_TAGS = 40;

function parseTags(query: string): TagQuery {
    const q: TagQuery = { all: [], any: [], none: [], notRatings: new Set(), ratings: null };
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length > MAX_TAGS) throw new FilterError(`too many tags (max ${MAX_TAGS})`);
    for (const token of tokens) {
        const negated = token.startsWith("-"), optional = token.startsWith("~");
        const tag = negated || optional ? token.slice(1) : token;
        if (tag === "") throw new FilterError(`invalid tag "${token}"`);
        if (tag.startsWith("rating:")) {
            const rating = RATINGS[tag.slice(7)];
            if (!rating) throw new FilterError(`invalid rating "${tag}"`);
            if (negated) q.notRatings.add(rating);
            else (q.ratings ??= new Set()).add(rating);
            continue;
        }
        (negated ? q.none : optional ? q.any : q.all).push(tag);
    }
    return q;
}

function idSet(name: string, value: unknown): Set<number> | null {
    if (value === undefined) return null;
    if (!Array.isArray(value) || !value.every(v => Number.isInteger(v))) throw new FilterError(`${name} must be an array of ints`);
    if (value.length > MAX_IDS) throw new FilterError(`too many ${name} (max ${MAX_IDS})`);
    return new Set(value as Array<number>);
}

function resolveTypes(type: string): { privateTypes: Set<PrivateEventType>; types: Set<EventType> } {
    if (type === "*") return { types: new Set(EVENT_TYPES), privateTypes: new Set() };
    if (type.endsWith(".*")) {
        const prefix = type.slice(0, -1);
        const types = EVENT_TYPES.filter(t => t.startsWith(prefix)), privateTypes = PRIVATE_EVENT_TYPES.filter(t => t.startsWith(prefix));
        if (types.length === 0 && privateTypes.length === 0) throw new FilterError(`unknown event type "${type}"`);
        return { types: new Set(types), privateTypes: new Set(privateTypes) };
    }
    if (isPrivateEventType(type)) return { types: new Set(), privateTypes: new Set([type]) };
    if (!isEventType(type)) throw new FilterError(`unknown event type "${type}"`);
    return { types: new Set([type]), privateTypes: new Set() };
}

export function compile(input: unknown): CompiledSubscription {
    const sub = (typeof input === "string" ? { type: input } : input ?? {}) as Subscription;
    if (typeof sub !== "object" || typeof sub.type !== "string") throw new FilterError("invalid subscription");
    const filter = sub.filter ?? {};
    if (typeof filter !== "object" || Array.isArray(filter)) throw new FilterError("filter must be an object");
    if (filter.tags !== undefined && typeof filter.tags !== "string") throw new FilterError("tags must be a string");
    if (filter.actions !== undefined && (!Array.isArray(filter.actions) || !filter.actions.every(a => typeof a === "string"))) {
        throw new FilterError("actions must be an array of strings");
    }
    const { privateTypes, types } = resolveTypes(sub.type);
    if (privateTypes.size !== 0 && sub.filter) throw new FilterError(`${[...privateTypes].join(", ")} can't be filtered`);
    return {
        source: { type: sub.type, ...(sub.filter ? { filter: sub.filter } : {}) },
        types,
        privateTypes,
        tags: filter.tags ? parseTags(filter.tags) : null,
        postIds: idSet("post_ids", filter.post_ids),
        poolIds: idSet("pool_ids", filter.pool_ids),
        setIds: idSet("set_ids", filter.set_ids),
        topicIds: idSet("topic_ids", filter.topic_ids),
        userIds: idSet("user_ids", filter.user_ids),
        actions: filter.actions ? new Set(filter.actions) : null,
    };
}

const num = (v: unknown): number | undefined => typeof v === "number" ? v : undefined;
const ints = (...values: Array<unknown>): Array<number> => values.filter((v): v is number => typeof v === "number");

function facetsOf(event: StreamEvent): Facets {
    let type: string = event.type, d = event.data;
    if (MOD_ACTION_EVENT_TYPES.has(event.type)) {
        type = "mod_action.create";
    } else if (VERSION_EVENTS[event.type]) {
        type = VERSION_EVENTS[event.type]!;
    } else if (type.endsWith(".update") && type !== "post.update") {
        const resource = type.slice(0, -".update".length);
        d = (d[resource] ?? {}) as Record<string, unknown>;
        type = `${resource}.create`;
    }
    switch (type) {
        case "post.create":
        case "post.update": {
            const post = d.post as { approver_id: number | null; id: number; pools: Array<number>; rating: string; tags: Record<string, Array<string>>; uploader_id: number };
            return { postIds: [post.id], poolIds: post.pools, userIds: ints(post.uploader_id, post.approver_id), tags: new Set(Object.values(post.tags).flat()), rating: post.rating };
        }
        case "post_version.create":
            return { postIds: ints(d.post_id), userIds: ints(d.updater_id), tags: new Set((typeof d.tags === "string" ? d.tags : "").split(" ").filter(Boolean)), rating: d.rating as string };
        case "pool_version.create":
            return { poolIds: ints(d.pool_id), userIds: ints(d.updater_id) };
        case "pool.create":
            return { poolIds: ints(d.id), userIds: ints(d.creator_id) };
        case "pool.add_posts":
        case "pool.remove_posts": {
            const version = (d.pool_version ?? {}) as Record<string, unknown>;
            return { postIds: d.post_ids as Array<number>, poolIds: ints(version.pool_id), userIds: ints(version.updater_id) };
        }
        case "post_set.create":
            return { setIds: ints(d.id), userIds: ints(d.creator_id) };
        case "post_set.add_posts":
        case "post_set.remove_posts": {
            const set = (d.post_set ?? {}) as Record<string, unknown>;
            return { postIds: d.post_ids as Array<number>, setIds: ints(set.id), userIds: ints(set.creator_id) };
        }
        case "user.create":
            return { userIds: ints(d.id) };
        case "forum_topic.create":
            return { topicId: num(d.id), userIds: ints(d.creator_id) };
        case "forum_post.create":
            return { topicId: num(d.topic_id), userIds: ints(d.creator_id, d.updater_id) };
        case "mod_action.create": {
            const values = (d.values ?? {}) as Record<string, unknown>;
            return { postIds: ints(values.post_id), poolIds: ints(values.pool_id), setIds: ints(values.set_id), topicId: num(values.forum_topic_id), userIds: ints(d.creator_id, values.user_id), action: d.action as string };
        }
        case "post_event.create":
            return { postIds: ints(d.post_id), userIds: ints(d.creator_id), action: d.action as string };
        case "tag_alias.create":
        case "tag_implication.create":
        case "bulk_update_request.create":
            return { topicId: num(d.forum_topic_id), userIds: ints(d.creator_id, d.user_id, d.approver_id) };
        default:
            // user_id is who it's about, not who did it
            return { postIds: ints(d.post_id), userIds: ints(d.creator_id, d.updater_id, d.user_id, d.approver_id, d.banner_id, d.linked_user_id) };
    }
}

const facetCache = new WeakMap<StreamEvent, Facets>();
function facets(event: StreamEvent): Facets {
    let f = facetCache.get(event);
    if (!f) facetCache.set(event, f = facetsOf(event));
    return f;
}

function matchTags(q: TagQuery, f: Facets): boolean {
    if (!f.tags) return false;
    if (q.ratings && (!f.rating || !q.ratings.has(f.rating))) return false;
    if (f.rating && q.notRatings.has(f.rating)) return false;
    for (const tag of q.all) if (!f.tags.has(tag)) return false;
    for (const tag of q.none) if (f.tags.has(tag)) return false;
    return q.any.length === 0 || q.any.some(tag => f.tags!.has(tag));
}

export function matches(sub: CompiledSubscription, event: StreamEvent): boolean {
    if (!sub.types.has(event.type)) return false;
    if (!sub.tags && !sub.postIds && !sub.poolIds && !sub.setIds && !sub.topicIds && !sub.userIds && !sub.actions) return true;
    const f = facets(event);
    if (sub.postIds && !f.postIds?.some(id => sub.postIds!.has(id))) return false;
    if (sub.poolIds && !f.poolIds?.some(id => sub.poolIds!.has(id))) return false;
    if (sub.setIds && !f.setIds?.some(id => sub.setIds!.has(id))) return false;
    if (sub.topicIds && (f.topicId === undefined || !sub.topicIds.has(f.topicId))) return false;
    if (sub.userIds && !f.userIds.some(id => sub.userIds!.has(id))) return false;
    if (sub.actions && (f.action === undefined || !sub.actions.has(f.action))) return false;
    if (sub.tags && !matchTags(sub.tags, f)) return false;
    return true;
}
