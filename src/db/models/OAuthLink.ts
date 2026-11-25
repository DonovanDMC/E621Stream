import { decrypt, encrypt } from "../../util/Encryption.ts";
import DB from "../DB.ts";

import Model from "./Model.ts";

import type { LookupResult } from "../../http/OAuth.tsx";
import type { OAuthScope, OAuthToken } from "e621-openapi";

export interface OAuthLinkAttributes {
    access_token: string;
    cached_data: LookupResult;
    checked_at: Date;
    created_at: Date;
    expires_at: Date;
    id: number;
    issued_at: Date;
    refresh_token: string;
    scopes: Array<OAuthScope>;
    updated_at: Date;
    user_id: number;
}

export default class OAuthLink extends Model<OAuthLinkAttributes> {
    static override readonly columns = ["id", "user_id", "scopes", "access_token", "refresh_token", "cached_data", "issued_at", "expires_at", "checked_at", "created_at", "updated_at"];
    static override readonly numbers = ["id", "user_id"];
    static override readonly table = "oauth_links";

    declare access_token: string; // encrypted
    declare cached_data: LookupResult;
    declare checked_at: Date;
    declare created_at: Date;
    declare expires_at: Date;
    declare id: number;
    declare issued_at: Date;
    declare refresh_token: string; // encrypted
    declare scopes: Array<OAuthScope>;
    declare updated_at: Date;
    declare user_id: number;

    private static _attributesForToken(token: OAuthToken, data: LookupResult): Partial<OAuthLinkAttributes> {
        return { ...OAuthLink._tokenAttributes(token), checked_at: new Date(), cached_data: data };
    }

    private static _tokenAttributes(token: OAuthToken): Partial<OAuthLinkAttributes> {
        return {
            scopes: token.scope.split(" ") as Array<OAuthScope>,
            access_token: encrypt(token.access_token),
            refresh_token: encrypt(token.refresh_token),
            issued_at: new Date(token.created_at * 1000),
            expires_at: new Date(Date.now() + (token.expires_in * 1000)),
        };
    }

    static async createFromToken(userID: number, token: OAuthToken, data: LookupResult): Promise<OAuthLink> {
        return OAuthLink.create({
            user_id: userID,
            ...OAuthLink._attributesForToken(token, data),
        });
    }

    /** User ids, for the server's background refresh */
    static async expiringBefore(date: Date): Promise<Array<number>> {
        const rows = await DB<Array<{ user_id: string }>>`SELECT user_id FROM ${DB(OAuthLink.table)} WHERE expires_at < ${date} ORDER BY expires_at`;
        return rows.map(row => Number(row.user_id));
    }

    get full(): boolean { return this.scopes.includes("full"); }

    get oauthToken(): OAuthToken {
        return {
            access_token: decrypt(this.access_token),
            token_type: "Bearer",
            expires_in: Math.floor((this.expires_at.getTime() - Date.now()) / 1000),
            refresh_token: decrypt(this.refresh_token),
            scope: this.scopes.join(" "),
            created_at: Math.floor(this.issued_at.getTime() / 1000),
        };
    }

    protected override beforeSave(): void {
        this.updated_at = new Date();
    }

    async updateFromToken(token: OAuthToken, data: LookupResult): Promise<this> {
        return this.update(OAuthLink._attributesForToken(token, data));
    }

    /** Just the tokens, the user's info is left as it was */
    async updateTokens(token: OAuthToken): Promise<this> {
        return this.update(OAuthLink._tokenAttributes(token));
    }
}
