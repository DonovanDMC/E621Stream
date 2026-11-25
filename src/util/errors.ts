export class AuthError extends Error {
    override name = "AuthError";
    constructor(description: string, status: number) {
        super(`${description} returned ${status}`);
    }
}
