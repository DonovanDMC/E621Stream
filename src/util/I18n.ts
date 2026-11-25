// {name} placeholders are filled from the params passed to t, and are type checked
const en = {
    gateway: {
        alreadyIdentified: "already identified",
        compressionFailed: "compression failed",
        decodeFailed: "failed to decode packet",
        disconnected: "disconnected by an admin",
        expectedUpgrade: "expected a websocket upgrade",
        identifyTimedOut: "identify timed out",
        internalError: "internal error",
        invalidCompression: "compress must be one of: {types}",
        invalidCursor: "invalid cursor",
        invalidPayload: "invalid payload",
        notIdentified: "identify first",
        rateLimited: "you're sending too many messages too quickly",
        tooManyConnections: "too many connections (max {max})",
        unknownOP: "unknown op: {op}",
        unsupportedVersion: "protocol version {version} isn't supported (this server supports {versions}), update your client",
        versionRequired: "a protocol version is required, connect with ?v={version}",
        auth: {
            banned: "user is banned",
            credentials: "invalid credentials",
            malformed: "malformed auth",
            required: "auth required",
            revoked: "authorization was revoked",
            verifyFailed: "auth verification failed",
        },
        client: {
            notString: "client name must be a string",
            tooLong: "client name is too long (max {max})",
        },
        filter: {
            emptyTag: "empty tag \"{tag}\"",
            invalidRating: "invalid rating \"{rating}\"",
            mustBeNumbers: "filter.{key} must be an array of numbers",
            mustBeString: "filter.{key} must be a string",
            mustBeStrings: "filter.{key} must be an array of strings",
            notObject: "filter must be an object",
            privateUnfilterable: "{types} can't be filtered",
            tooManyTags: "too many tags (max {max})",
            unknownType: "unknown event type \"{type}\"",
        },
        slow: {
            messageDropped: "a message has been dropped due to backpressure, please reconnect and resume",
            replay: "replay too slow",
            consumer: "you are consuming messages too slowly",
        },
        snapshot: {
            invalidIDs: "ids must be positive integers",
            invalidNonce: "invalid nonce",
            noIDs: "no ids specified",
            tooManyIDs: "too many ids (max {max})",
            unknownResource: "resource must be one of: {resources}",
        },
        subscriptions: {
            invalid: "invalid subscription",
            none: "no subscriptions",
            privateDisabled: "private events were turned off",
            privateNeedsAuth: "{types} require auth",
            privateNotEnabled: "{types} need private events, turn them on at {url}",
            tooMany: "too many subscriptions (max {max})",
        },
    },
    web: {
        admin: {
            adminBan: "Admins can't be banned.",
            invalidSession: "That isn't a session id.",
            invalidUser: "That isn't a user id.",
            messageLimit: "Messages a minute has to be {min}-{max}.",
            slowScale: "Slow mode has to be {min}-{max}x.",
            unknownFeed: "There isn't a feed called that.",
            recovery: {
                alreadyRunning: "A recovery is already running.",
                backwards: "From has to be before to.",
                future: "To can't be in the future.",
                invalidTime: "Invalid time.",
                noSources: "No sources were picked.",
                notRunning: "There isn't a recovery running.",
            },
            staff: {
                alreadyAdmin: "They're already an admin.",
                isOwner: "Owners can only be changed with <code>e621stream promote</code>.",
                notAdmin: "They aren't an admin.",
            },
            success: {
                adminAdded: "Made <strong>{user}</strong> an admin.",
                adminRemoved: "<strong>{user}</strong> isn't an admin anymore.",
                banned: "Banned <strong>{user}</strong>.",
                dropped: "Dropped the session. They can still reconnect, ban them to stop that.",
                messageLimitSet: "<strong>{user}</strong> can send {limit} messages a minute.",
                feedPaused: "Paused <code>{name}</code>. Nothing it would have found is sent until it's resumed.",
                feedResumed: "Resumed <code>{name}</code>.",
                feedSlowOff: "<code>{name}</code> is back to its normal speed.",
                feedSlowOn: "<code>{name}</code> is polled {scale}x slower.",
                recoveryCancelled: "Cancelled the recovery. What's been sent so far stays sent.",
                recoveryStarted: "Started recovery <code>{id}</code>.",
                slowOff: "Slow mode is off.",
                slowOn: "Slow mode is on ({scale}x).",
                unbanned: "Unbanned <strong>{user}</strong>.",
            },
        },
        notFullAccess: "OAuthLink does not have full access, private events cannot be enabled",
        oauthUnavailable: "OAuth login is not available.",
        tokenNotFound: "Token not found",
        tooManyLogins: "Too many login attempts, try again later.",
        tooManyTokens: "You already have too many tokens. You cannot create more.",
        // flash messages, the tags in Flash's ALLOWED_TAGS are kept as html
        success: {
            loggedOut: "Logged out",
            tokenCreated: "Created <strong>{name}</strong>. It's only shown once, so save it somewhere:<pre><code>{token}</code></pre>",
            tokenDeleted: "Token deleted",
            tokenUpdated: "Token updated",
        },
    },
} as const;

type Messages = typeof en;
type Paths<T, Prefix extends string = ""> = { [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Paths<T[K], `${Prefix}${K}.`> }[keyof T & string];
type MessageAt<T, P extends string> = P extends `${infer Head}.${infer Rest}` ? (Head extends keyof T ? MessageAt<T[Head], Rest> : never) : P extends keyof T ? T[P] : never;
type ParamsOf<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | ParamsOf<Rest> : never;

export type MessageKey = Paths<Messages>;
export type MessageParams<K extends MessageKey> = Record<ParamsOf<MessageAt<Messages, K>>, string | number>;
// params are only allowed, and then required, when the message has placeholders
type Args<K extends MessageKey> = [ParamsOf<MessageAt<Messages, K>>] extends [never] ? [] : [params: MessageParams<K>];

export default class I18n {
    static t<K extends MessageKey>(key: K, ...[params]: Args<K>): string {
        let message: unknown = en;
        for (const part of key.split(".")) message = (message as Record<string, unknown>)[part];
        if (typeof message !== "string") throw new TypeError(`missing message for "${key}"`);
        if (!params) return message;
        return message.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String((params as Record<string, string | number>)[name]) : match);
    }
}
