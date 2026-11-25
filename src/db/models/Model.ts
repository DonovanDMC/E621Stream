import DB from "../DB.ts";

import type { SQL } from "bun";

type Fragment = SQL.Query<unknown>;
type Row = Record<string, unknown>;

export interface ModelClass<M extends Model<object>> {
    readonly columns: ReadonlyArray<string>;
    readonly numbers: ReadonlyArray<string>;
    readonly primaryKey: ReadonlyArray<string>;
    readonly table: string;
    new (attributes?: Partial<AttributesOf<M>>): M;
}
export type AttributesOf<M> = M extends Model<infer A> ? A : never;

export interface FindOptions<A> {
    limit?: number;
    order?: Partial<Record<keyof A & string, "ASC" | "DESC">>;
}

function join(fragments: Array<Fragment>, separator: "AND" | ","): Fragment {
    return fragments.reduce((all, fragment) => (separator === "AND" ? DB`${all} AND ${fragment}` : DB`${all}, ${fragment}`));
}

function where(conditions: Row): Fragment {
    const entries = Object.entries(conditions).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return DB`TRUE`;
    return join(entries.map(([column, value]) => (value === null ? DB`${DB(column)} IS NULL` : DB`${DB(column)} = ${value}`)), "AND");
}

export default abstract class Model<A extends object> {
    // set by subclasses
    static readonly columns: ReadonlyArray<string> = [];
    // BIGINT columns, Bun returns these as strings
    static readonly numbers: ReadonlyArray<string> = [];
    static readonly primaryKey: ReadonlyArray<string> = ["id"];
    static readonly table: string;

    #persisted = false;

    constructor(attributes: Partial<A> = {}) {
        Object.assign(this, attributes);
    }

    private static async _findBy<M extends Model<object>>(model: ModelClass<M>, conditions: Row): Promise<M | null> {
        const [record] = await Model._select(model, where(conditions), { limit: 1 });
        return record ?? null;
    }

    private static async _select<M extends Model<object>>(model: ModelClass<M>, condition: Fragment, { limit, order }: FindOptions<AttributesOf<M>> = {}): Promise<Array<M>> {
        const orderBy = Object.entries(order ?? {}).map(([column, direction]) => (direction === "DESC" ? DB`${DB(column)} DESC` : DB`${DB(column)} ASC`));
        const rows = await DB<Array<Row>>`SELECT * FROM ${DB(model.table)} WHERE ${condition} ${orderBy.length === 0 ? DB`` : DB`ORDER BY ${join(orderBy, ",")}`} ${limit === undefined ? DB`` : DB`LIMIT ${limit}`}`;
        return rows.map((row) => {
            const record = new model();
            record.load(row);
            return record;
        });
    }

    static async all<M extends Model<object>>(this: ModelClass<M>, options?: FindOptions<AttributesOf<M>>): Promise<Array<M>> {
        return Model._select(this, DB`TRUE`, options);
    }

    static async count<M extends Model<object>>(this: ModelClass<M>, conditions: Partial<AttributesOf<M>> = {}): Promise<number> {
        // BIGINT, comes back as a string
        const [row] = await DB<Array<{ count: string }>>`SELECT count(*) AS count FROM ${DB(this.table)} WHERE ${where(conditions)}`;
        return Number(row?.count ?? 0);
    }

    static async create<M extends Model<object>>(this: ModelClass<M>, attributes: Partial<AttributesOf<M>>): Promise<M> {
        const record = new this(attributes);
        await record.save();
        return record;
    }

    static async exists<M extends Model<object>>(this: ModelClass<M>, conditions: Partial<AttributesOf<M>> = {}): Promise<boolean> {
        const [row] = await DB<Array<{ exists: boolean }>>`SELECT EXISTS (SELECT 1 FROM ${DB(this.table)} WHERE ${where(conditions)}) AS exists`;
        return row?.exists ?? false;
    }

    /** In `primaryKey` order */
    static async find<M extends Model<object>>(this: ModelClass<M>, ...key: Array<unknown>): Promise<M | null> {
        if (key.length !== this.primaryKey.length) throw new TypeError(`${this.name}.find expects ${this.primaryKey.length} key value(s), got ${key.length}`);
        return Model._findBy(this, Object.fromEntries(this.primaryKey.map((column, i) => [column, key[i]])));
    }

    static async findBy<M extends Model<object>>(this: ModelClass<M>, conditions: Partial<AttributesOf<M>>): Promise<M | null> {
        return Model._findBy(this, conditions);
    }

    /** Insert, or update the non-key columns on conflict */
    static async upsert<M extends Model<object>>(this: ModelClass<M>, attributes: Partial<AttributesOf<M>>): Promise<M> {
        const record = new this(attributes);
        record.beforeSave();
        const values = record.values();
        const columns = Object.keys(values);
        const updates = columns.filter(column => !this.primaryKey.includes(column)).map(column => DB`${DB(column)} = EXCLUDED.${DB(column)}`);
        const conflict = join(this.primaryKey.map(column => DB`${DB(column)}`), ",");
        const [row] = await DB<Array<Row>>`INSERT INTO ${DB(this.table)} ${DB(values, ...columns)} ON CONFLICT (${conflict}) ${updates.length === 0 ? DB`DO NOTHING` : DB`DO UPDATE SET ${join(updates, ",")}`} RETURNING *`;
        // DO NOTHING returns no row when it conflicts
        if (row) record.load(row);
        else record.#persisted = true;
        return record;
    }

    static async where<M extends Model<object>>(this: ModelClass<M>, conditions: Partial<AttributesOf<M>>, options?: FindOptions<AttributesOf<M>>): Promise<Array<M>> {
        return Model._select(this, where(conditions), options);
    }

    /** Rows where column is any of values, and the other conditions match */
    static async whereIn<M extends Model<object>, K extends keyof AttributesOf<M> & string>(this: ModelClass<M>, column: K, values: ReadonlyArray<AttributesOf<M>[K]>, conditions: Partial<AttributesOf<M>> = {}, options?: FindOptions<AttributesOf<M>>): Promise<Array<M>> {
        if (values.length === 0) return [];
        return Model._select(this, DB`${DB(column)} IN ${DB([...values])} AND ${where(conditions)}`, options);
    }

    private get model(): ModelClass<this> {
        return this.constructor as ModelClass<this>;
    }

    get persisted(): boolean {
        return this.#persisted;
    }

    private key(): Row {
        return Object.fromEntries(this.model.primaryKey.map((column): [string, unknown] => [column, (this as Row)[column]]));
    }

    // also marks it as persisted
    private load(row: Row): void {
        for (const column of this.model.numbers) {
            if (typeof row[column] === "string") row[column] = Number(row[column]);
        }
        Object.assign(this, row);
        this.#persisted = true;
    }

    // unset columns are left out for the database defaults
    private values(): Row {
        return Object.fromEntries(this.model.columns.map((column): [string, unknown] => [column, (this as Row)[column]]).filter(([, value]) => value !== undefined));
    }

    /** Before every insert and update */
    protected beforeSave(): void {
        // for subclasses
    }

    async destroy(): Promise<boolean> {
        if (!this.#persisted) return false;
        const { count } = await DB<Array<Row> & { count: number }>`DELETE FROM ${DB(this.model.table)} WHERE ${where(this.key())}`;
        this.#persisted = false;
        return count > 0;
    }

    async reload(): Promise<this> {
        const [row] = await DB<Array<Row>>`SELECT * FROM ${DB(this.model.table)} WHERE ${where(this.key())}`;
        if (!row) throw new Error(`${this.model.name} ${JSON.stringify(this.key())} no longer exists`);
        this.load(row);
        return this;
    }

    /** Insert if new, otherwise update */
    async save(): Promise<this> {
        this.beforeSave();
        const values = this.values();
        const columns = Object.keys(values);
        let rows: Array<Row>;
        if (this.#persisted) rows = await DB<Array<Row>>`UPDATE ${DB(this.model.table)} SET ${DB(values, ...columns)} WHERE ${where(this.key())} RETURNING *`;
        else rows = await DB<Array<Row>>`INSERT INTO ${DB(this.model.table)} ${DB(values, ...columns)} RETURNING *`;
        if (rows[0]) this.load(rows[0]);
        return this;
    }

    toJSON(): A {
        return this.values() as A;
    }

    async update(attributes: Partial<A>): Promise<this> {
        Object.assign(this, attributes);
        return this.save();
    }
}
