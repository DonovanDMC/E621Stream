import Model from "./Model.ts";

export type BackfillKind = "crawl" | "export";
export type BackfillStatus = "done" | "failed" | "pending" | "running" | "waiting";
/** A crawl goes from cursor down to lower */
export interface Lane { cursor: number; lower: number }

export interface BackfillAttributes {
    ceiling: number | null;
    cursor: number | null;
    detail: string | null;
    error: string | null;
    finished_at: Date | null;
    kind: BackfillKind;
    lanes: Array<Lane> | null;
    source: string;
    started_at: Date | null;
    status: BackfillStatus;
    stored: number;
    updated_at: Date;
}

export default class Backfill extends Model<BackfillAttributes> {
    static override readonly columns = ["source", "kind", "status", "cursor", "ceiling", "stored", "detail", "error", "lanes", "started_at", "finished_at", "updated_at"];
    static override readonly numbers = ["cursor", "ceiling", "stored"];
    static override readonly primaryKey = ["source"];
    static override readonly table = "backfill";

    declare ceiling: number | null;
    declare cursor: number | null;
    declare detail: string | null;
    declare error: string | null;
    declare finished_at: Date | null;
    declare kind: BackfillKind;
    declare lanes: Array<Lane> | null;
    declare source: string;
    declare started_at: Date | null;
    declare status: BackfillStatus;
    declare stored: number;
    declare updated_at: Date;

    protected override beforeSave(): void {
        this.updated_at = new Date();
    }
}
