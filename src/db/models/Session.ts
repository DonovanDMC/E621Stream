import APIKeyLogin from "./APIKeyLogin.ts";
import Model from "./Model.ts";
import OAuthLogin from "./OAuthLogin.ts";

export interface SessionAttributes {
    api_key_login_id: number | null;
    created_at: Date;
    expires_at: Date;
    id: string;
    ip_address: string;
    last_used_at: Date;
    oauth_login_id: number | null;
    user_id: number;
}

export default class Session extends Model<SessionAttributes> {
    static override readonly columns = ["id", "user_id", "api_key_login_id", "oauth_login_id", "ip_address", "created_at", "last_used_at", "expires_at"];
    static override readonly numbers = ["user_id", "api_key_login_id", "oauth_login_id"];
    static override readonly table = "sessions";

    declare api_key_login_id: number | null;
    declare created_at: Date;
    declare expires_at: Date;
    // fingerprint of the session token, not the token itself
    declare id: string;
    declare ip_address: string;
    declare last_used_at: Date;
    declare oauth_login_id: number | null;
    declare user_id: number;

    async getLogin(): Promise<APIKeyLogin | OAuthLogin | null> {
        if (this.api_key_login_id) return APIKeyLogin.find(this.api_key_login_id);
        if (this.oauth_login_id) return OAuthLogin.find(this.oauth_login_id);
        return null;
    }
}
