import { deleteSnapshots, getReplacementSnapshots, getSnapshots } from "../db.ts";
import { publish } from "../events.ts";

import { checkReplacements, type PostEvent } from "./replacements.ts";

import type { Item } from "./updates.ts";

async function expunged(event: PostEvent): Promise<number> {
    const last = (await getSnapshots("post", [event.post_id])).get(event.post_id);
    await publish("post.destroy", event.created_at ?? new Date().toISOString(), { post: { id: event.post_id, ...last }, post_event: event });
    await deleteSnapshots("post", [event.post_id]);
    await deleteSnapshots("post_replacement", [...(await getReplacementSnapshots(event.post_id)).keys()]);
    return 1;
}

export async function afterPostEvent(item: Item): Promise<number> {
    const event = item as PostEvent;
    if (event.action === "expunged") return expunged(event);
    if (event.action.startsWith("replacement_")) return checkReplacements(event);
    return 0;
}
