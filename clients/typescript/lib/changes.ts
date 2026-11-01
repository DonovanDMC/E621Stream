import type { LegacyPost } from "./generated.ts";

/** A field's old and new value. */
export interface ValueChange<T> { new: T; old: T }
export interface SetChange<T> { added: Array<T>; removed: Array<T> }

export type Changes<R, Field extends keyof R> = Partial<{ [K in Field]: ValueChange<R[K]> }>;

export type TagCategoryName = "artist" | "character" | "contributor" | "copyright" | "general" | "invalid" | "lore" | "meta" | "species";

export type PostFlagName = Extract<keyof LegacyPost["flags"], string>;

/** Tags are split by category, so moving a tag between categories shows up as a remove & add. */
export type PostChanges = Partial<
    Record<`tags.${TagCategoryName}`, SetChange<string>>
    & Record<`flags.${PostFlagName}`, ValueChange<boolean>>
    & {
        approver_id: ValueChange<number | null>;
        children: SetChange<number>;
        description: ValueChange<string>;
        has_notes: ValueChange<boolean>;
        locked_tags: SetChange<string>;
        md5: ValueChange<string>;
        parent_id: ValueChange<number | null>;
        pools: SetChange<number>;
        rating: ValueChange<LegacyPost["rating"]>;
        sources: SetChange<string>;
    }
>;
