import { deleteSnapshots, getReplacementSnapshots } from "../db.ts";
import { e621, request } from "../e621.ts";
import { publish } from "../events.ts";

import { UpdateFeed, UPDATES, type Item } from "./updates.ts";

interface PostEvent extends Item { action: string; post_id: number }

// replacements can't be ordered by updated_at, so older ones are only checked when a post event mentions them
const feed = new UpdateFeed(UPDATES.find(source => source.name === "post_replacement_updates")!);

/** runs for every post event, only does anything for the ones about replacements */
export async function checkReplacements(item: Item): Promise<number> {
    const event = item as PostEvent;
    if (!event.action.startsWith("replacement_")) return 0;
    const replacements = await request("post_replacements for a post", () => e621.postReplacements.search({ post_id: String(event.post_id), limit: 320 }));
    let published = await feed.handle(replacements, true);
    if (event.action === "replacement_deleted") {
        const present = new Set(replacements.map(replacement => replacement.id));
        const gone = [...(await getReplacementSnapshots(event.post_id)).entries()].filter(([id]) => !present.has(id));
        for (const [id, last] of gone) {
            await publish("post_replacement.destroy", event.created_at ?? new Date().toISOString(), { post_replacement: { id, ...last }, post_event: event });
            published++;
        }
        await deleteSnapshots("post_replacement", gone.map(([id]) => id));
    }
    return published;
}
