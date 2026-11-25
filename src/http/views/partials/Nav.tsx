import { DOCS } from "../../Docs.ts";
import { currentRequest } from "../../Flash.ts";
import { currentUser } from "../../Session.tsx";

import type User from "../../../db/models/User.ts";

// paths are the other pages it's active on, the docs link covers every docs page. exact ones aren't active on pages under them
interface NavLink { exact?: boolean; href: string; paths?: Array<string>; text: string }

function links(user: User | null): Array<NavLink> {
    const list: Array<NavLink> = [{ href: "/", paths: DOCS.map(doc => doc.href), text: "Docs" }, { href: "/status", text: "Status" }];
    if (user) list.push({ href: "/user", text: "Tokens" });
    if (user?.is("admin")) list.push({ href: "/admin", exact: true, text: "Admin" }, { href: "/admin/clients", text: "Clients" }, { href: "/admin/bans", text: "Bans" }, { href: "/admin/database", text: "Database" });
    return list;
}

export default async function Nav(): Promise<string> {
    // error pages are rendered even when the database is down
    const user = await currentUser().catch(() => null);
    const req = currentRequest();
    const path = req ? new URL(req.url).pathname : "";
    return (
        <nav class="navbar navbar-expand-sm bg-body-tertiary border-bottom site-nav">
            <div class="container-fluid">
                <a class="navbar-brand" href="/">E621Stream</a>
                <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#site-nav" aria-controls="site-nav" aria-expanded="false" aria-label="Toggle navigation">
                    <span class="navbar-toggler-icon"></span>
                </button>
                <div class="collapse navbar-collapse" id="site-nav">
                    <ul class="navbar-nav me-auto">
                        {links(user).map(({ exact, href, paths, text }) => {
                            const active = path === href || (!exact && href !== "/" && path.startsWith(`${href}/`)) || (paths?.includes(path) ?? false);
                            return (
                                <li class="nav-item">
                                    <a class={["nav-link", active && "active"]} href={href} aria-current={active ? "page" : undefined} safe>{text}</a>
                                </li>
                            );
                        })}
                    </ul>
                    {user
                        ? (
                                <form method="post" action="/user/logout" class="d-flex mb-0">
                                    <button type="submit" class="btn btn-sm btn-outline-secondary">Log out</button>
                                </form>
                            )
                        : <a class="btn btn-sm btn-primary" href={`/user/login?return=${encodeURIComponent(path || "/user")}`}>Log in</a>}
                </div>
            </div>
        </nav>
    );
}
