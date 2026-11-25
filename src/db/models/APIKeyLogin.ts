import Model from "./Model.ts";

export interface APIKeyLoginAttributes {
    created_at: Date;
    fingerprint: string;
    id: number;
    updated_at: Date;
    user_id: number;
}

export default class APIKeyLogin extends Model<APIKeyLoginAttributes> {
    static override readonly columns = ["id", "user_id", "fingerprint", "created_at", "updated_at"];
    static override readonly numbers = ["id", "user_id"];
    static override readonly table = "api_key_logins";

    declare created_at: Date;
    // fingerprint of the api key, not the key itself
    declare fingerprint: string;
    declare id: number;
    declare updated_at: Date;
    declare user_id: number;

    protected override beforeSave(): void {
        this.updated_at = new Date();
    }
}
