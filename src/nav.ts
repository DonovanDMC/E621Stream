export interface NavLink {
    href: string;
    page?: string;
    title: string;
}

export const NAV: Array<NavLink> = [
    { href: "/", page: "index", title: "Overview" },
    { href: "/subscriptions/", page: "subscriptions", title: "Subscriptions" },
    { href: "/events/", page: "events", title: "Events" },
    { href: "/replaying/", page: "replaying", title: "Replaying" },
    { href: "/snapshots/", page: "snapshots", title: "Snapshots" },
    { href: "/compression/", page: "compression", title: "Compression" },
    { href: "/close-codes/", page: "close-codes", title: "Close Codes" },
    { href: "/clients/", page: "clients", title: "Clients" },
    { href: "/authorize", title: "Tokens" },
    { href: "/status", title: "Status" },
];

const escapeHTML = (value: string): string => value.replaceAll(/[&<>"']/g, char => `&#${char.codePointAt(0)};`);

export function navHTML(links: Array<NavLink>, active: string): string {
    const items = links.map(link => link.href === active
        ? `<a href="${link.href}" class="active" aria-current="page">${escapeHTML(link.title)}</a>`
        : `<a href="${link.href}">${escapeHTML(link.title)}</a>`);
    return `<header class="site-header">\n      <nav class="site-nav" aria-label="Pages">\n        ${items.join("\n        ")}\n      </nav>\n    </header>`;
}

export const NAV_CSS = `
.site-header { border-bottom: 1px solid var(--border); padding-bottom: 16px; }
.site-nav { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 18px; padding: 12px 16px 0; font-size: 14px; }
.site-nav a { color: var(--link); text-decoration: none; border-bottom: 2px solid transparent; }
.site-nav a:hover { text-decoration: underline; }
.site-nav a.active { color: var(--heading); font-weight: bold; border-bottom-color: var(--link); }
.site-nav a.active:hover { text-decoration: none; }
`;
