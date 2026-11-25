import { CRAWLS } from "./backfill.ts";
import { FEEDS } from "./feeds.ts";
import { POSTS_SOURCE } from "./posts.ts";
import { UPDATES } from "./updates.ts";

import type { SnapshotResourceType } from "../gateway/snapshots.ts";

/** Every feed the ingester runs, by name */
export const FEED_SOURCES: Array<{ intervalMS: number; name: string }> = [POSTS_SOURCE, ...FEEDS, ...UPDATES].map(({ intervalMS, name }) => ({ name, intervalMS }));
export const FEED_NAMES = FEED_SOURCES.map(source => source.name);

/** Resources something stores snapshots of, the rest in the snapshot map would always be empty */
export const STORED_RESOURCES: Array<SnapshotResourceType> = [...new Set<SnapshotResourceType>([
    "post",
    ...FEEDS.flatMap(source => source.snapshot ? [source.snapshot] : []),
    ...UPDATES.map(source => source.resource),
    ...CRAWLS.flatMap(source => source.resource ? [source.resource] : []),
])].toSorted();
