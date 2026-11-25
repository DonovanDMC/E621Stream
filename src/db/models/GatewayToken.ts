import { randomBytes } from "node:crypto";

import { GATEWAY_TOKEN_PREFIX } from "../../util/Constants.ts";
import { fingerprint } from "../../util/HMAC.ts";

import Model from "./Model.ts";

export interface GatewayTokenAttributes {
    created_at: Date;
    fingerprint: string;
    id: number;
    last_used_at: Date | null;
    name: string;
    private_events: boolean;
    updated_at: Date;
    user_id: number;
}

export default class GatewayToken extends Model<GatewayTokenAttributes> {
    static override readonly columns = ["id", "user_id", "fingerprint", "name", "private_events", "last_used_at", "created_at", "updated_at"];
    static override readonly numbers = ["id", "user_id"];
    static override readonly table = "gateway_tokens";

    declare created_at: Date;
    declare fingerprint: string; // of the token, not the token itself
    declare id: number;
    declare last_used_at: Date | null;
    declare name: string;
    declare private_events: boolean;
    declare updated_at: Date;
    declare user_id: number;

    static async findByToken(token: string): Promise<GatewayToken | null> {
        return GatewayToken.findBy({ fingerprint: fingerprint(token) });
    }

    /** Only the fingerprint is stored, the token can't be retrieved again */
    static async generate(attributes: Pick<GatewayTokenAttributes, "name" | "user_id"> & Partial<Pick<GatewayTokenAttributes, "private_events">>): Promise<{ gatewayToken: GatewayToken; token: string }> {
        const token = `${GATEWAY_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
        const gatewayToken = await GatewayToken.create({ ...attributes, fingerprint: fingerprint(token) });
        return { gatewayToken, token };
    }

    protected override beforeSave(): void {
        this.updated_at = new Date();
    }
}
