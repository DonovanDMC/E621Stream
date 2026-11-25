import Router, { Middleware } from "@yiffy/bun-router";
import Debug from "@yiffy/debug";
import z from "zod";

import Config from "../../Config.ts";
import OAuthLink from "../../db/models/OAuthLink.ts";
import User from "../../db/models/User.ts";
import { ban, drop, listBans, unban } from "../../gateway/management.ts";
import { listClients } from "../../gateway/presence.ts";
import { cancelRecovery, getRecovery, requestRecovery } from "../../gateway/recovery.ts";
import { clearSlowMode, getSlowMode, setSlowMode } from "../../gateway/slowMode.ts";
import { clearFeedSlow, getFeedControls, pauseFeed, resumeFeed, slowFeed } from "../../ingester/control.ts";
import { getFeedHealth } from "../../ingester/health.ts";
import { RECOVERABLE } from "../../ingester/recovery.ts";
import { FEED_NAMES } from "../../ingester/sources.ts";
import { MAX_BAN_REASON_LENGTH, MESSAGE_LIMIT_MAX, MESSAGE_LIMIT_MIN, SLOW_MODE_MAX_SCALE, SLOW_MODE_MIN_SCALE } from "../../util/Constants.ts";
import I18n from "../../util/I18n.ts";
import { getDatabaseStats } from "../DatabaseStats.ts";
import { flashWithRedirect } from "../Flash.ts";
import { loginRequired } from "../Session.tsx";
import Admin from "../views/Admin.tsx";
import DatabaseStats from "../views/DatabaseStats.tsx";
import { render } from "../Views.ts";

// shown as who banned someone or turned on slow mode, only oauth logins have a name stored
async function adminName(user: User): Promise<string> {
    const link = await OAuthLink.findBy({ user_id: user.id });
    return link?.cached_data.user.name ?? `#${user.id}`;
}

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
// an iso time, or how long ago like 6h / 90m / 2d
function parseTime(value: string | undefined, fallback: Date): Date {
    const text = value?.trim() ?? "";
    if (text === "") return fallback;
    const relative = /^(\d+)([mhd])$/.exec(text);
    if (relative) return new Date(Date.now() - (Number(relative[1]) * UNITS[relative[2] as keyof typeof UNITS]));
    return new Date(text);
}

// empty fields are left out, so the optional ones don't end up as ""
const optional = z.string().trim().transform(value => value === "" ? null : value).optional();

Router.new("/admin", "GET")
    .use(loginRequired("admin"))
    .handle(async (req) => {
        const [clients, bans, recovery, slowMode, staff, feedHealth, feedControls, limited] = await Promise.all([listClients(), listBans(), getRecovery(), getSlowMode(), User.whereIn("role", ["admin", "owner"], {}, { order: { id: "ASC" } }), getFeedHealth(), getFeedControls(), User.withMessageLimits()]);
        const links = await OAuthLink.whereIn("user_id", [...staff, ...limited].map(user => user.id));
        const names = new Map(links.map(link => [link.user_id, link.cached_data.user.name]));
        return render(<Admin bans={bans} clients={clients} feedControls={feedControls} feedHealth={feedHealth} limited={limited} names={names} recovery={recovery} slowMode={slowMode} staff={staff} viewer={req.user} />);
    });

Router.new("/admin/database", "GET")
    .use(loginRequired("admin"))
    .handle(async () => render(<DatabaseStats stats={await getDatabaseStats()} />));

Router.new("/admin/message-limit", "POST")
    .use(loginRequired("admin"))
    .use(Middleware.BodyParser({
        accept: ["urlencoded"],
        parse(raw) {
            const schema = z.object({
                user_id: z.coerce.number(),
                // left empty to go back to the default
                limit: optional,
            });
            return schema.parse(raw);
        },
    }))
    .handle(async (req) => {
        const { limit: given = null, user_id: userID } = req.parsedBody;
        if (!Number.isSafeInteger(userID) || userID <= 0) return flashWithRedirect("/admin#message-limits", "error", I18n.t("web.admin.invalidUser"));
        const limit = given === null ? Config.maxClientMessagesPerMinute : Number(given);
        if (!Number.isInteger(limit) || limit < MESSAGE_LIMIT_MIN || limit > MESSAGE_LIMIT_MAX) {
            return flashWithRedirect("/admin#message-limits", "error", I18n.t("web.admin.messageLimit", { min: MESSAGE_LIMIT_MIN, max: MESSAGE_LIMIT_MAX }));
        }
        await User.setMessageLimit(userID, limit);
        Debug("http:admin", `#${req.user.id} set #${userID}'s message limit to ${limit}`);
        return flashWithRedirect("/admin#message-limits", "success", I18n.t("web.admin.success.messageLimitSet", { user: `#${userID}`, limit }));
    });

Router.new("/admin/drop", "POST")
    .use(loginRequired("admin"))
    .use(Middleware.BodyParser({
        accept: ["urlencoded"],
        parse(raw) {
            const schema = z.object({
                session_id: z.string(),
            });
            return schema.parse(raw);
        },
    }))
    .handle(async (req) => {
        const sessionID = req.parsedBody.session_id;
        if (!z.uuid().safeParse(sessionID).success) return flashWithRedirect("/admin", "error", I18n.t("web.admin.invalidSession"));
        await drop(sessionID);
        Debug("http:admin", `#${req.user.id} dropped ${sessionID}`);
        return flashWithRedirect("/admin", "success", I18n.t("web.admin.success.dropped"));
    });

Router.new("/admin/ban", "POST")
    .use(loginRequired("admin"))
    .use(Middleware.BodyParser({
        accept: ["urlencoded"],
        parse(raw) {
            const schema = z.object({
                user_id: z.coerce.number(),
                name: optional,
                reason: optional,
            });
            return schema.parse(raw);
        },
    }))
    .handle(async (req) => {
        const { name = null, reason = null, user_id: userID } = req.parsedBody;
        if (!Number.isSafeInteger(userID) || userID <= 0) return flashWithRedirect("/admin", "error", I18n.t("web.admin.invalidUser"));
        if ((await User.find(userID))?.is("admin")) return flashWithRedirect("/admin", "error", I18n.t("web.admin.adminBan"));
        await ban({
            user_id: userID,
            name,
            reason: reason?.slice(0, MAX_BAN_REASON_LENGTH) ?? null,
            banned_by: await adminName(req.user),
            banned_at: new Date().toISOString(),
        });
        Debug("http:admin", `#${req.user.id} banned #${userID}`);
        return flashWithRedirect("/admin", "success", I18n.t("web.admin.success.banned", { user: name ?? `#${userID}` }));
    });

Router.new("/admin/unban", "POST")
    .use(loginRequired("admin"))
    .use(Middleware.BodyParser({
        accept: ["urlencoded"],
        parse(raw) {
            const schema = z.object({
                user_id: z.coerce.number(),
            });
            return schema.parse(raw);
        },
    }))
    .handle(async (req) => {
        const userID = req.parsedBody.user_id;
        if (!Number.isSafeInteger(userID)) return flashWithRedirect("/admin", "error", I18n.t("web.admin.invalidUser"));
        await unban(userID);
        Debug("http:admin", `#${req.user.id} unbanned #${userID}`);
        return flashWithRedirect("/admin", "success", I18n.t("web.admin.success.unbanned", { user: `#${userID}` }));
    });

Router.new("/admin/slow", "POST")
    .use(loginRequired("admin"))
    .use(Middleware.BodyParser({
        accept: ["urlencoded"],
        parse(raw) {
            const schema = z.object({
                scale: z.coerce.number(),
            });
            return schema.parse(raw);
        },
    }))
    .handle(async (req) => {
        const scale = req.parsedBody.scale;
        if (!Number.isInteger(scale) || scale < SLOW_MODE_MIN_SCALE || scale > SLOW_MODE_MAX_SCALE) {
            return flashWithRedirect("/admin", "error", I18n.t("web.admin.slowScale", { min: SLOW_MODE_MIN_SCALE, max: SLOW_MODE_MAX_SCALE }));
        }
        await setSlowMode(scale, await adminName(req.user));
        Debug("http:admin", `#${req.user.id} turned on slow mode (${scale}x)`);
        return flashWithRedirect("/admin", "success", I18n.t("web.admin.success.slowOn", { scale }));
    });

Router.new("/admin/slow/off", "POST")
    .use(loginRequired("admin"))
    .handle(async (req) => {
        await clearSlowMode();
        Debug("http:admin", `#${req.user.id} turned off slow mode`);
        return flashWithRedirect("/admin", "success", I18n.t("web.admin.success.slowOff"));
    });

const feedName = z.object({ name: z.string() });

Router.new("/admin/feeds/pause", "POST")
    .use(loginRequired("admin"))
    .use(Middleware.BodyParser({ accept: ["urlencoded"], parse: raw => feedName.parse(raw) }))
    .handle(async (req) => {
        const { name } = req.parsedBody;
        if (!FEED_NAMES.includes(name)) return flashWithRedirect("/admin#feeds", "error", I18n.t("web.admin.unknownFeed"));
        await pauseFeed(name, await adminName(req.user));
        Debug("http:admin", `#${req.user.id} paused ${name}`);
        return flashWithRedirect("/admin#feeds", "success", I18n.t("web.admin.success.feedPaused", { name }));
    });

Router.new("/admin/feeds/resume", "POST")
    .use(loginRequired("admin"))
    .use(Middleware.BodyParser({ accept: ["urlencoded"], parse: raw => feedName.parse(raw) }))
    .handle(async (req) => {
        const { name } = req.parsedBody;
        if (!FEED_NAMES.includes(name)) return flashWithRedirect("/admin#feeds", "error", I18n.t("web.admin.unknownFeed"));
        await resumeFeed(name);
        Debug("http:admin", `#${req.user.id} resumed ${name}`);
        return flashWithRedirect("/admin#feeds", "success", I18n.t("web.admin.success.feedResumed", { name }));
    });

Router.new("/admin/feeds/slow", "POST")
    .use(loginRequired("admin"))
    .use(Middleware.BodyParser({
        accept: ["urlencoded"],
        parse(raw) {
            const schema = feedName.extend({
                scale: z.coerce.number(),
            });
            return schema.parse(raw);
        },
    }))
    .handle(async (req) => {
        const { name, scale } = req.parsedBody;
        if (!FEED_NAMES.includes(name)) return flashWithRedirect("/admin#feeds", "error", I18n.t("web.admin.unknownFeed"));
        if (!Number.isInteger(scale) || scale < SLOW_MODE_MIN_SCALE || scale > SLOW_MODE_MAX_SCALE) {
            return flashWithRedirect("/admin#feeds", "error", I18n.t("web.admin.slowScale", { min: SLOW_MODE_MIN_SCALE, max: SLOW_MODE_MAX_SCALE }));
        }
        await slowFeed(name, scale, await adminName(req.user));
        Debug("http:admin", `#${req.user.id} slowed ${name} (${scale}x)`);
        return flashWithRedirect("/admin#feeds", "success", I18n.t("web.admin.success.feedSlowOn", { name, scale }));
    });

Router.new("/admin/feeds/slow/off", "POST")
    .use(loginRequired("admin"))
    .use(Middleware.BodyParser({ accept: ["urlencoded"], parse: raw => feedName.parse(raw) }))
    .handle(async (req) => {
        const { name } = req.parsedBody;
        if (!FEED_NAMES.includes(name)) return flashWithRedirect("/admin#feeds", "error", I18n.t("web.admin.unknownFeed"));
        await clearFeedSlow(name);
        Debug("http:admin", `#${req.user.id} set ${name} back to its normal speed`);
        return flashWithRedirect("/admin#feeds", "success", I18n.t("web.admin.success.feedSlowOff", { name }));
    });

Router.new("/admin/recovery", "POST")
    .use(loginRequired("admin"))
    .use(Middleware.BodyParser({
        accept: ["urlencoded"],
        parse(raw) {
            const schema = z.object({
                from: z.string(),
                to: z.string().optional(),
                // repeated fields come in as an array, a single one doesn't
                source: z.union([z.string(), z.array(z.string())]).optional().transform(value => [value ?? []].flat()),
            });
            return schema.parse(raw);
        },
    }))
    .handle(async (req) => {
        const { from, source, to } = req.parsedBody;
        const sources = source.filter(name => RECOVERABLE.includes(name));
        const result = await requestRecovery(parseTime(from, new Date(Number.NaN)), parseTime(to, new Date()), sources, await adminName(req.user));
        if (typeof result === "string") return flashWithRedirect("/admin", "error", result);
        Debug("http:admin", `#${req.user.id} started recovery ${result.id} (${result.from} to ${result.to}, ${sources.length} source(s))`);
        return flashWithRedirect("/admin", "success", I18n.t("web.admin.success.recoveryStarted", { id: result.id }));
    });

Router.new("/admin/recovery/cancel", "POST")
    .use(loginRequired("admin"))
    .handle(async (req) => {
        if (!await cancelRecovery()) return flashWithRedirect("/admin", "warning", I18n.t("web.admin.recovery.notRunning"));
        Debug("http:admin", `#${req.user.id} cancelled the recovery`);
        return flashWithRedirect("/admin", "success", I18n.t("web.admin.success.recoveryCancelled"));
    });

Router.new("/admin/admins", "POST")
    .use(loginRequired("owner"))
    .use(Middleware.BodyParser({
        accept: ["urlencoded"],
        parse(raw) {
            const schema = z.object({
                user_id: z.coerce.number(),
            });
            return schema.parse(raw);
        },
    }))
    .handle(async (req) => {
        const userID = req.parsedBody.user_id;
        if (!Number.isSafeInteger(userID) || userID <= 0) return flashWithRedirect("/admin", "error", I18n.t("web.admin.invalidUser"));
        const user = await User.find(userID);
        // owners are only changed with the cli's promote
        if (user?.is("admin")) return flashWithRedirect("/admin", "warning", I18n.t(user.role === "owner" ? "web.admin.staff.isOwner" : "web.admin.staff.alreadyAdmin"));
        // they might not have logged in yet
        if (user) await user.update({ role: "admin" });
        else await User.create({ id: userID, role: "admin" });
        Debug("http:admin", `#${req.user.id} made #${userID} an admin`);
        return flashWithRedirect("/admin", "success", I18n.t("web.admin.success.adminAdded", { user: `#${userID}` }));
    });

Router.new("/admin/admins/remove", "POST")
    .use(loginRequired("owner"))
    .use(Middleware.BodyParser({
        accept: ["urlencoded"],
        parse(raw) {
            const schema = z.object({
                user_id: z.coerce.number(),
            });
            return schema.parse(raw);
        },
    }))
    .handle(async (req) => {
        const user = await User.find(req.parsedBody.user_id);
        if (user?.role === "owner") return flashWithRedirect("/admin", "error", I18n.t("web.admin.staff.isOwner"));
        if (user?.role !== "admin") return flashWithRedirect("/admin", "error", I18n.t("web.admin.staff.notAdmin"));
        await user.update({ role: "user" });
        Debug("http:admin", `#${req.user.id} removed #${user.id} as an admin`);
        return flashWithRedirect("/admin", "success", I18n.t("web.admin.success.adminRemoved", { user: `#${user.id}` }));
    });
