import { decrypt } from "../../util/Encryption.ts";

import Model from "./Model.ts";

import type { OAuthScope, OAuthToken } from "e621-openapi";

export interface OAuthLoginAttributes {
    access_token: string;
    created_at: Date;
    expires_at: Date;
    id: number;
    issued_at: Date;
    refresh_token: string;
    scopes: Array<OAuthScope>;
    updated_at: Date;
    user_id: number;
}

export default class OAuthLogin extends Model<OAuthLoginAttributes> {
    static override readonly columns = ["id", "user_id", "scopes", "access_token", "refresh_token", "issued_at", "expires_at", "created_at", "updated_at"];
    static override readonly numbers = ["id", "user_id"];
    static override readonly table = "oauth_logins";

    declare access_token: string; // encrypted
    declare created_at: Date;
    declare expires_at: Date;
    declare id: number;
    declare issued_at: Date;
    declare refresh_token: string; // encrypted
    declare scopes: Array<OAuthScope>;
    declare updated_at: Date;
    declare user_id: number;

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
}
