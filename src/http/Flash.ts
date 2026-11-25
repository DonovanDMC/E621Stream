import { AsyncLocalStorage } from "node:async_hooks";

import { escapeHtml } from "@kitajs/html";
import { z } from "zod";

import { FLASH_COOKIE } from "../util/Constants.ts";
import { decrypt, encrypt } from "../util/Encryption.ts";
import { cookieSecure } from "../util/util.ts";

import type { AnyPathMiddleware } from "@yiffy/bun-router";

export type FlashType = "error" | "notice" | "success" | "warning";
export interface FlashMessage { message: string; type: FlashType }

const schema = z.array(z.object({ message: z.string(), type: z.enum(["error", "notice", "success", "warning"]) }));

interface Context {
    // loaded from the cookie on first use
    messages: Array<FlashMessage> | null;
    req: Bun.BunRequest;
}
const context = new AsyncLocalStorage<Context>();

// we just fully drop notices that fail to parse, it isn't a huge concern if they fail
// encrypted since it can hold tokens
function load(ctx: Context): Array<FlashMessage> {
    if (ctx.messages !== null) return ctx.messages;
    const value = ctx.req.cookies.get(FLASH_COOKIE);
    let messages: Array<FlashMessage> = [];
    if (value) {
        try {
            const parsed = schema.safeParse(JSON.parse(decrypt(value)));
            if (parsed.success) messages = parsed.data;
        } catch {
            // couldn't decrypt, or invalid json
        }
    }
    ctx.messages = messages;
    return messages;
}

// used so flash doesn't need the requests explicitly passed
export const FlashMiddleware: AnyPathMiddleware = async (req, server, next) => context.run({ messages: null, req: req as Bun.BunRequest }, async () => next(req, server));

/** Shown on the next page rendered, only {@link ALLOWED_TAGS} are kept as html */
export function flash(type: FlashType, message: string): void {
    const ctx = context.getStore();
    if (!ctx) throw new Error("flash used outside of a request");
    const messages = load(ctx);
    messages.push({ message, type });
    ctx.req.cookies.set(FLASH_COOKIE, encrypt(JSON.stringify(messages)), {
        httpOnly: true,
        maxAge: 5 * 60,
        path: "/",
        sameSite: "lax",
        secure: cookieSecure(ctx.req),
    });
}

export function flashWithRedirect(path: string, type: FlashType, message: string, code = 303): Response {
    flash(type, message);
    return Response.redirect(path, code);
}

/** The request being handled, for things rendered without it passed in */
export function currentRequest(): Bun.BunRequest | null {
    return context.getStore()?.req ?? null;
}

export function takeFlash(): Array<FlashMessage> {
    const ctx = context.getStore();
    if (!ctx) return [];
    const messages = load(ctx);
    if (messages.length === 0) return [];
    ctx.messages = [];
    ctx.req.cookies.delete(FLASH_COOKIE);
    return messages;
}

export const ALLOWED_TAGS = ["b", "br", "code", "em", "i", "pre", "strong", "u"];
const VOID_TAGS = ["br"];

/** Escapes everything but {@link ALLOWED_TAGS}, and closes unclosed tags */
export function flashHTML(message: string): string {
    const out: Array<string> = [], open: Array<string> = [];
    let last = 0;
    // tags with attributes don't match, so get escaped
    for (const match of message.matchAll(/<(\/?)([a-z]+)\s*\/?>/gi)) {
        out.push(escapeHtml(message.slice(last, match.index)));
        last = match.index + match[0].length;
        const closing = match[1] === "/", tag = match[2]!.toLowerCase();
        if (!ALLOWED_TAGS.includes(tag)) {
            out.push(escapeHtml(match[0]));
        } else if (VOID_TAGS.includes(tag)) {
            if (!closing) out.push(`<${tag}>`);
        } else if (!closing) {
            open.push(tag);
            out.push(`<${tag}>`);
        } else {
            const index = open.lastIndexOf(tag);
            // also closes anything opened inside it
            if (index !== -1) out.push(...open.splice(index).reverse().map(t => `</${t}>`));
        }
    }
    out.push(escapeHtml(message.slice(last)), ...open.reverse().map(t => `</${t}>`));
    return out.join("");
}
