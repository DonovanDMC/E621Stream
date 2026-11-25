import { getReplacementSnapshots, removeSnapshot, saveSnapshot } from "../gateway/snapshots.ts";
import { e621, request } from "../util/e621.ts";

import { previous, type Extra } from "./extra.ts";

import type * as E621 from "e621-openapi/types";

// replacements are made with their post, an update that soon after is still the create
const CREATION_SLACK_MS = 2000;

// an expunged post is gone from every search, so the post event is the only sign of it
async function expunged(event: E621.PostEvent): Promise<Array<Extra>> {
    const gone = await removeSnapshot("post", event.post_id);
    for (const replacement of await getReplacementSnapshots(event.post_id)) await removeSnapshot("post_replacement", replacement.id);
    const context = { ...event.creator_id === null ? {} : { updater_id: event.creator_id }, ...previous(gone?.data) };
    return [{ type: "post.destroy", data: { id: event.post_id }, context }];
}

// replacements can't be ordered by updated_at, so they're only checked when a post event mentions them.
// the event doesn't say which replacement it was, so the post's are looked up
async function replacementChanged(event: E621.PostEvent): Promise<Array<Extra>> {
    const replacements = await request("post_replacements for a post", () => e621.postReplacements.search({ post_id: String(event.post_id), limit: 320 }));
    const stored = await getReplacementSnapshots(event.post_id);
    const extras: Array<Extra> = [];
    // whoever accepted, rejected or deleted it made the post event
    const context = event.creator_id === null ? undefined : { updater_id: event.creator_id };
    for (const replacement of replacements) {
        const before = stored.find(snapshot => snapshot.id === replacement.id);
        const updated = Date.parse(replacement.updated_at);
        // ones we haven't stored are only sent if they've changed since being made
        const changed = before ? updated > before.version : updated - Date.parse(replacement.created_at) > CREATION_SLACK_MS;
        if (changed) extras.push({ type: "post_replacement.update", data: replacement, context });
        if (!before || changed) await saveSnapshot("post_replacement", replacement);
    }
    // stored ones the post doesn't have anymore were deleted
    const present = replacements.map(replacement => replacement.id);
    for (const snapshot of stored.filter(s => !present.includes(s.id))) {
        await removeSnapshot("post_replacement", snapshot.id);
        extras.push({ type: "post_replacement.destroy", data: { id: snapshot.id }, context: { ...context, ...previous(snapshot.data) } });
    }
    return extras;
}

export async function postEventExtra(event: E621.PostEvent): Promise<Array<Extra>> {
    if (event.action === "expunged") return expunged(event);
    if (event.action.startsWith("replacement_")) return replacementChanged(event);
    return [];
}
