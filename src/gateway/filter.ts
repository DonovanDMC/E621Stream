import { MAX_FILTER_TAGS } from "../util/Constants.ts";
import I18n from "../util/I18n.ts";
import { Tuple } from "../util/util.ts";

import { EVENT_TYPES, PRIVATE_EVENT_TYPES, type EventContext, type EventType, type EventTypeDataMap, type PrivateEventType } from "./events.ts";

import type * as E621 from "e621-openapi/types";

const RATINGS: Record<string, string> = { s: "s", safe: "s", q: "q", questionable: "q", e: "e", explicit: "e" };

interface TagQuery { all: Array<string>; any: Array<string>; none: Array<string>; notRatings: Array<string>; ratings: Array<string> }
export class FilterError extends Error {
    override name = "FilterError";
}

export interface Filter {
    actions?: Array<string>;
    artist_ids?: Array<number>;
    avoid_posting_ids?: Array<number>;
    creator_ids?: Array<number>;
    forum_category_ids?: Array<number>;
    forum_topic_ids?: Array<number>;
    ids?: Array<number>;
    note_ids?: Array<number>;
    pool_ids?: Array<number>;
    post_ids?: Array<number>;
    tag_category_ids?: Array<number>;
    tag_ids?: Array<number>;
    tags?: string;
    updater_ids?: Array<number>;
    user_ids?: Array<number>;
    wiki_page_ids?: Array<number>;
}

export interface FilteredSubscription {
    filter?: Filter;
    type: string;
}
export type Subscription = string | FilteredSubscription;

export interface CompiledSubscription {
    filter?: Filter;
    privateTypes: Array<PrivateEventType>;
    types: Array<EventType>;
}

function parseTags(query: string): TagQuery {
    const q: TagQuery = { all: [], any: [], none: [], notRatings: [], ratings: [] };
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length > MAX_FILTER_TAGS) throw new FilterError(I18n.t("gateway.filter.tooManyTags", { max: MAX_FILTER_TAGS }));
    for (const token of tokens) {
        const negated = token.startsWith("-"), optional = token.startsWith("~");
        const tag = negated || optional ? token.slice(1) : token;
        if (tag === "") throw new FilterError(I18n.t("gateway.filter.emptyTag", { tag: token }));
        if (tag.startsWith("rating:")) {
            const rating = RATINGS[tag.slice(7)];
            if (!rating) throw new FilterError(I18n.t("gateway.filter.invalidRating", { rating: tag }));
            if (negated) q.notRatings.push(rating);
            else q.ratings.push(rating);
            continue;
        }
        (negated ? q.none : optional ? q.any : q.all).push(tag);
    }
    return q;
}

interface ResolvedType { privateTypes: Array<PrivateEventType>; types: Array<EventType> }
function resolveTypes(type: string): ResolvedType {
    if (type === "*") return { types: EVENT_TYPES, privateTypes: [] };
    if (type.endsWith(".*")) {
        const prefix = type.slice(0, -1);
        const types = EVENT_TYPES.filter(t => t.startsWith(prefix)), privateTypes = PRIVATE_EVENT_TYPES.filter(t => t.startsWith(prefix));
        if (types.length === 0 && privateTypes.length === 0) throw new FilterError(I18n.t("gateway.filter.unknownType", { type }));
        return { types, privateTypes };
    }
    if (PRIVATE_EVENT_TYPES.includes(type as PrivateEventType)) return { types: [], privateTypes: [type as PrivateEventType] };
    if (EVENT_TYPES.includes(type as EventType)) return { types: [type as EventType], privateTypes: [] };
    throw new FilterError(I18n.t("gateway.filter.unknownType", { type }));
}

const stringArrayFilters = Tuple(["actions"] as const),
    numberArrayFilters = Tuple([
        "artist_ids", "avoid_posting_ids", "creator_ids", "forum_category_ids", "forum_topic_ids", "ids", "note_ids", "pool_ids", "post_ids",
        "tag_category_ids", "tag_ids", "updater_ids", "user_ids", "wiki_page_ids",
    ] as const);
export function compileSubscription(input: unknown): CompiledSubscription {
    const sub = (typeof input === "string" ? { type: input } : (input ?? {})) as FilteredSubscription;
    if (typeof sub !== "object" || typeof sub.type !== "string") throw new FilterError(I18n.t("gateway.subscriptions.invalid"));
    const filter = sub.filter ?? {};
    if (typeof filter !== "object" || Array.isArray(filter)) throw new FilterError(I18n.t("gateway.filter.notObject"));
    if (filter.tags !== undefined && typeof filter.tags !== "string") throw new FilterError(I18n.t("gateway.filter.mustBeString", { key: "tags" }));
    for (const attr of stringArrayFilters) {
        const value = filter[attr];
        if (value === undefined) continue;
        if (!Array.isArray(value) || value.some(v => typeof v !== "string")) throw new FilterError(I18n.t("gateway.filter.mustBeStrings", { key: attr }));
    }
    for (const attr of numberArrayFilters) {
        const value = filter[attr];
        if (value === undefined) continue;
        if (!Array.isArray(value) || value.some(v => typeof v !== "number")) throw new FilterError(I18n.t("gateway.filter.mustBeNumbers", { key: attr }));
    }

    const { privateTypes, types } = resolveTypes(sub.type);
    if (privateTypes.length !== 0 && sub.filter) throw new FilterError(I18n.t("gateway.filter.privateUnfilterable", { types: privateTypes.join(", ") }));
    return {
        filter,
        types,
        privateTypes,
    };
}

function filterDoesNotMatch<T>(filter: Array<T> | undefined, value: T | undefined | null): boolean {
    return filter !== undefined && (value === undefined || value === null || !filter.includes(value));
}

// for lists, like the posts added to a pool. matches if any of them do
function noneMatch<T>(filter: Array<T> | undefined, values: Array<T> | undefined): boolean {
    return filter !== undefined && (!values?.some(value => filter.includes(value)));
}

// set while filtersFor is asking a handler which filters it takes
let probed: Array<keyof Filter> | null = null;
function otherFiltersUsed(filter: Filter, keys: Array<keyof Filter>): boolean {
    probed?.push(...keys);
    return (Object.keys(filter) as Array<keyof Filter>).some(key => filter[key] !== undefined && !keys.includes(key));
}

const parsedTags = new WeakMap<Filter, TagQuery>();
function tagsDoNotMatch(filter: Filter, post: Partial<Pick<E621.ExtendedPost, "rating" | "tags">>): boolean {
    if (filter.tags === undefined) return false;
    let query = parsedTags.get(filter);
    if (!query) parsedTags.set(filter, query = parseTags(filter.tags));
    if (!post.tags || !post.rating) return true;
    const tags = Object.values(post.tags).flat();
    if (query.ratings.length !== 0 && !query.ratings.includes(post.rating)) return true;
    if (query.notRatings.includes(post.rating)) return true;
    if (!query.all.every(tag => tags.includes(tag))) return true;
    if (query.none.some(tag => tags.includes(tag))) return true;
    if (query.any.length !== 0 && !query.any.some(tag => tags.includes(tag))) return true;
    return false;
}

const FilterMap: { [K in keyof EventTypeDataMap]: (data: EventTypeDataMap[K], filter: Filter, context: EventContext) => boolean } = {
    "artist.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "artist_ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        return true;
    },
    "artist.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "artist_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "artist.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "artist_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    // who added it is from the artist version, urls don't say
    "artist_url.create": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "artist_ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, data.artist_id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, context.updater_id)) return false;
        return true;
    },
    "artist_url.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "artist_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, data.artist_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    // these come from artist versions, so the version says who
    "artist_url.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "artist_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, data.artist_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "artist_version.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "artist_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, data.artist_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, data.updater_id)) return false;
        return true;
    },
    "avoid_posting.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "avoid_posting_ids", "artist_ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.avoid_posting_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, data.artist_id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        return true;
    },
    "avoid_posting.delete": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "avoid_posting_ids", "artist_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.avoid_posting_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, data.artist_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "avoid_posting.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "avoid_posting_ids", "artist_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.avoid_posting_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, data.artist_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "avoid_posting.undelete": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "avoid_posting_ids", "artist_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.avoid_posting_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, data.artist_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "avoid_posting.update": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "avoid_posting_ids", "artist_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.avoid_posting_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, data.artist_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, data.updater_id)) return false;
        return true;
    },
    "avoid_posting_version.create": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "avoid_posting_ids", "artist_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.avoid_posting_ids, data.avoid_posting_id)) return false;
        if (filterDoesNotMatch(filter.artist_ids, context.artist_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, data.updater_id)) return false;
        return true;
    },
    "ban.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids", "user_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.banner_id)) return false;
        if (filterDoesNotMatch(filter.user_ids, data.user_id)) return false;
        return true;
    },
    "ban.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "user_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.user_ids, data.user_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "ban.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "user_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.user_ids, data.user_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "blip.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        return true;
    },
    "blip.delete": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        return true;
    },
    "blip.destroy": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        return true;
    },
    "blip.undelete": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        return true;
    },
    "blip.update": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, data.updater_id)) return false;
        return true;
    },
    "bulk_update_request.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids", "forum_topic_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.forum_topic_id)) return false;
        return true;
    },
    // only known when it's approved or rejected
    "bulk_update_request.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "forum_topic_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.forum_topic_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "comment.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids", "post_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        return true;
    },
    "comment.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "comment.hide": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "comment.unhide": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "comment.update": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids", "post_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, data.updater_id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        return true;
    },
    // forum categories don't exist as JSON yet
    "forum_category.create": () => false,
    "forum_category.destroy": () => false,
    "forum_category.update": () => false,
    "forum_post.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids", "forum_topic_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.topic_id)) return false;
        return true;
    },
    "forum_post.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "forum_topic_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.topic_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "forum_post.hide": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "forum_topic_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.topic_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "forum_post.unhide": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "forum_topic_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.topic_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "forum_post.update": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids", "forum_topic_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, data.updater_id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.topic_id)) return false;
        return true;
    },
    "forum_topic.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "forum_topic_ids", "creator_ids", "forum_category_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        if (filterDoesNotMatch(filter.forum_category_ids, data.category_id)) return false;
        return true;
    },
    "forum_topic.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "forum_topic_ids", "forum_category_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_category_ids, data.category_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "forum_topic.hide": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "forum_topic_ids", "forum_category_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_category_ids, data.category_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "forum_topic.unhide": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "forum_topic_ids", "forum_category_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_category_ids, data.category_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "forum_topic.update": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "forum_topic_ids", "updater_ids", "forum_category_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, data.updater_id)) return false;
        if (filterDoesNotMatch(filter.forum_category_ids, data.category_id)) return false;
        return true;
    },
    // who made it is from the help_create mod action
    "help_page.create": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, context.updater_id)) return false;
        return true;
    },
    "help_page.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "help_page.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "mod_action.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "actions", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.actions, data.action)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        return true;
    },
    "news_update.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        return true;
    },
    "news_update.destroy": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        return true;
    },
    "news_update.update": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, data.updater_id)) return false;
        return true;
    },
    "note.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "note_ids", "creator_ids", "post_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.note_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        return true;
    },
    "note.delete": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "note_ids", "post_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.note_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        return true;
    },
    "note.undelete": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "note_ids", "post_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.note_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        return true;
    },
    "note.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "note_ids", "post_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.note_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "note_version.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "note_ids", "post_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.note_ids, data.note_id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        return true;
    },
    "pool.add_posts": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "pool_ids", "post_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.pool_ids, data.id)) return false;
        if (noneMatch(filter.post_ids, context.post_ids)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "pool.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "pool_ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.pool_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        return true;
    },
    "pool.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "pool_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.pool_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "pool.remove_posts": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "pool_ids", "post_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.pool_ids, data.id)) return false;
        if (noneMatch(filter.post_ids, context.post_ids)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "pool.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "pool_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.pool_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "pool_version.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "pool_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.pool_ids, data.pool_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, data.updater_id)) return false;
        return true;
    },
    "post.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "creator_ids", "tags"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.uploader_id)) return false;
        if (tagsDoNotMatch(filter, data)) return false;
        return true;
    },
    "post.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "tags", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.id)) return false;
        if (tagsDoNotMatch(filter, data)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    // these are votes, favorites and comments, there's no one updater
    "post.stats": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "tags"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.id)) return false;
        if (tagsDoNotMatch(filter, data)) return false;
        return true;
    },
    "post.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "tags", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.id)) return false;
        if (tagsDoNotMatch(filter, data)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "post_approval.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.user_id)) return false;
        return true;
    },
    "post_approval.destroy": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        return true;
    },
    "post_event.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "actions", "post_ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.actions, data.action)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        return true;
    },
    "post_flag.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        return true;
    },
    // resolving a flag isn't logged anywhere, so who did it isn't known
    "post_flag.update": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        return true;
    },
    "post_replacement.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        return true;
    },
    "post_replacement.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    // who accepted, rejected or deleted it is from the post event
    "post_replacement.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    // maintainers can add posts too, so who did isn't known
    "post_set.add_posts": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (noneMatch(filter.post_ids, context.post_ids)) return false;
        return true;
    },
    "post_set.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        return true;
    },
    "post_set.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "post_set.remove_posts": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (noneMatch(filter.post_ids, context.post_ids)) return false;
        return true;
    },
    // staff edits are logged, anything else is the owner
    "post_set.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "post_version.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, data.updater_id)) return false;
        return true;
    },
    "post_version.hide": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "post_version.unhide": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "post_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "tag.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "tag_category_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.tag_category_ids, data.category)) return false;
        return true;
    },
    "tag.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "tag_category_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.tag_category_ids, data.category)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "tag.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "tag_category_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.tag_category_ids, data.category)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "tag_alias.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids", "forum_topic_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.forum_topic_id)) return false;
        return true;
    },
    "tag_alias.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "forum_topic_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.forum_topic_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "tag_implication.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids", "forum_topic_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.forum_topic_id)) return false;
        return true;
    },
    "tag_implication.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "forum_topic_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.forum_topic_ids, data.forum_topic_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "tag_type_version.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "tag_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.tag_ids, data.tag_id)) return false;
        return true;
    },
    // creator_id is always hidden
    "takedown.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        return true;
    },
    "takedown.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    // takedowns don't record their updater, and have no modaction
    "takedown.update": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        return true;
    },
    "upload_karma_event.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids", "user_ids", "post_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        if (filterDoesNotMatch(filter.user_ids, data.user_id)) return false;
        if (filterDoesNotMatch(filter.post_ids, data.post_id)) return false;
        return true;
    },
    "upload_url_rule.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        return true;
    },
    "upload_url_rule.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "upload_url_rule.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id ?? data.updater_id)) return false;
        return true;
    },
    // whitelist entries don't say who made them, it's from the mod action
    "upload_whitelist.create": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, context.updater_id)) return false;
        return true;
    },
    "upload_whitelist.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "upload_whitelist.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "user.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "user_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.user_ids, data.id)) return false;
        return true;
    },
    "user.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "user_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.user_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "user.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "user_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.user_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "user_feedback.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "creator_ids", "user_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        if (filterDoesNotMatch(filter.user_ids, data.user_id)) return false;
        return true;
    },
    "user_feedback.delete": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "user_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.user_ids, data.user_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "user_feedback.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "user_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.user_ids, data.user_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "user_feedback.undelete": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "user_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.user_ids, data.user_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "user_feedback.update": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "updater_ids", "user_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id ?? data.updater_id)) return false;
        if (filterDoesNotMatch(filter.user_ids, data.user_id)) return false;
        return true;
    },
    "wiki_page.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "wiki_page_ids", "creator_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.wiki_page_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.creator_ids, data.creator_id)) return false;
        return true;
    },
    "wiki_page.destroy": (data, filter, context) => {
        if (otherFiltersUsed(filter, ["ids", "wiki_page_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.wiki_page_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, context.updater_id)) return false;
        return true;
    },
    "wiki_page.update": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "wiki_page_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.wiki_page_ids, data.id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, data.updater_id)) return false;
        return true;
    },
    "wiki_page_version.create": (data, filter) => {
        if (otherFiltersUsed(filter, ["ids", "wiki_page_ids", "updater_ids"])) return false;
        if (filterDoesNotMatch(filter.ids, data.id)) return false;
        if (filterDoesNotMatch(filter.wiki_page_ids, data.wiki_page_id)) return false;
        if (filterDoesNotMatch(filter.updater_ids, data.updater_id)) return false;
        return true;
    },
};

/** Which filters work on an event type, for the docs. Every handler says so before it reads anything */
export function filtersFor(type: EventType): Array<keyof Filter> {
    probed = [];
    try {
        // reading the fake data can throw once the handler gets past its first line, by then it's been recorded
        (FilterMap[type] as (data: unknown, filter: Filter, context: EventContext) => boolean)(new Proxy({}, { get: (): undefined => undefined }), {}, {});
    } catch {
        // expected
    }
    const keys = probed;
    probed = null;
    return keys;
}

export function filterMatches<T extends EventType>(type: T, data: EventTypeDataMap[T], filter?: Filter, context: EventContext = {}): boolean {
    return FilterMap[type](data, filter ?? {}, context);
}
