import Router, { Middleware } from "@yiffy/bun-router";
import z from "zod";

import HTTPConfig from "../../config/HTTPConfig.ts";
import GatewayToken from "../../db/models/GatewayToken.ts";
import OAuthLink from "../../db/models/OAuthLink.ts";
import { recheckToken } from "../../gateway/management.ts";
import I18n from "../../util/I18n.ts";
import { clientIP, returnPath } from "../../util/util.ts";
import { flashWithRedirect } from "../Flash.ts";
import { callback, PURPOSES, startAuthorization, type LoginPurpose } from "../OAuth.tsx";
import { loginRequired, logout } from "../Session.tsx";
import Login from "../views/Login.tsx";
import UserHome from "../views/UserHome.tsx";
import { render } from "../Views.ts";

Router.new("/user", "GET")
    .use(loginRequired())
    .handle(async (req) => {
        const tokens = await GatewayToken.where({ user_id: req.user.id });
        const link = await OAuthLink.findBy({ user_id: req.user.id });
        return render(<UserHome tokens={tokens} link={link} />);
    });

Router.new("/user/login", "GET")
    .handle(req => render(<Login return={returnPath(new URL(req.url).searchParams.get("return"))} />));

Router.new("/user/login/oauth", "GET")
    .handle(async (req, server) => {
        const params = new URL(req.url).searchParams;
        const purpose = params.get("purpose") as LoginPurpose | null;
        if (!HTTPConfig.oauthEnabled) return flashWithRedirect("/user/login", "error", I18n.t("web.oauthUnavailable"));
        const start = await startAuthorization(req, clientIP(req, server), !purpose || !PURPOSES.includes(purpose) ? "login" : purpose, returnPath(params.get("return")));
        if (!start) return flashWithRedirect("/user/login", "warning", I18n.t("web.tooManyLogins"));
        return start;
    });

Router.new("/user/login/oauth/callback", "GET")
    .handle(async (req, server) => callback(req, clientIP(req, server)));

Router.new("/user/logout", "POST")
    .handle(async (req) => {
        await logout(req);
        return flashWithRedirect("/user/login", "success", I18n.t("web.success.loggedOut"));
    });

Router.new("/user/tokens", "POST")
    .use(loginRequired())
    .use(Middleware.BodyParser({
        accept: ["urlencoded"],
        parse(raw) {
            const schema = z.object({
                name: z.string(),
            });
            return schema.parse(raw);
        },
    }))
    .handle(async (req) => {
        const tokenCount = await GatewayToken.count({ user_id: req.user.id });
        if (tokenCount >= HTTPConfig.maxTokensPerUser) return flashWithRedirect("/user", "error", I18n.t("web.tooManyTokens"));
        const { gatewayToken, token } = await GatewayToken.generate({
            user_id: req.user.id,
            name: req.parsedBody.name,
        });
        return flashWithRedirect("/user", "success", I18n.t("web.success.tokenCreated", { name: gatewayToken.name, token }));
    });

Router.new("/user/tokens/delete")
    .use(loginRequired())
    .use(Middleware.BodyParser({
        accept: ["urlencoded"],
        parse(raw) {
            const schema = z.object({
                id: z.coerce.number(),
            });
            return schema.parse(raw);
        },
    }))
    .handle(async (req) => {
        const token = await GatewayToken.findBy({ user_id: req.user.id, id: req.parsedBody.id });
        if (!token) return flashWithRedirect("/user", "error", I18n.t("web.tokenNotFound"));
        await token.destroy();
        // the sessions using it fail the recheck and are closed
        await recheckToken(token.fingerprint);
        return flashWithRedirect("/user", "success", I18n.t("web.success.tokenDeleted"));
    });

Router.new("/user/tokens/toggle-private-events")
    .use(loginRequired())
    .use(Middleware.BodyParser({
        accept: ["urlencoded"],
        parse(raw) {
            const schema = z.object({
                id: z.coerce.number(),
            });
            return schema.parse(raw);
        },
    }))
    .handle(async (req) => {
        const token = await GatewayToken.findBy({ user_id: req.user.id, id: req.parsedBody.id });
        if (!token) return flashWithRedirect("/user", "warning", I18n.t("web.tokenNotFound"));
        const link = await OAuthLink.findBy({ user_id: req.user.id });
        if (!link?.full) return flashWithRedirect("/user", "error", I18n.t("web.notFullAccess"));
        await token.update({ private_events: !token.private_events });
        // turning them off closes sessions that were using them
        await recheckToken(token.fingerprint);
        return flashWithRedirect("/user", "success", I18n.t("web.success.tokenUpdated"));
    });
