import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { Marked } from "marked";

import { NAV, NAV_CSS, navHTML, type NavLink } from "../src/nav.ts";

const root = resolve(import.meta.dir, "../");
const pagesDir = join(root, "pages");
const out = join(root, "dist-pages");

const escapeHTML = (value: string): string => value.replaceAll(/[&<>"']/g, char => `&#${char.codePointAt(0)};`);
const slug = (text: string): string => text.toLowerCase().replaceAll(/[^\w\s-]/g, "").trim().replaceAll(/\s+/g, "-");

const marked = new Marked({
    renderer: {
        heading({ depth, text, tokens }): string {
            return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
        },
    },
    hooks: {
        postprocess: (html: string): string => html.replaceAll("<table>", "<div class=\"table-wrap\"><table>").replaceAll("</table>", "</table></div>"),
    },
});

const files = (await readdir(pagesDir)).filter(file => file.endsWith(".md"));
const pages = await Promise.all(files.map(async (file) => {
    const name = basename(file, ".md");
    const source = await Bun.file(join(pagesDir, file)).text();
    const title = /^# (.+)$/m.exec(source)?.[1] ?? name;
    return { name, title, href: name === "index" ? "/" : `/${name}/`, content: await marked.parse(source) };
}));
const extra = pages.filter(page => !NAV.some(link => link.page === page.name)).sort((a, b) => a.title.localeCompare(b.title));
const links: Array<NavLink> = [...NAV, ...extra.map(page => ({ href: page.href, page: page.name, title: page.title }))];
for (const link of NAV) if (link.page && !pages.some(page => page.name === link.page)) throw new Error(`the nav links to pages/${link.page}.md, which doesn't exist`);

const template = await Bun.file(join(pagesDir, "template.html")).text();
await rm(out, { recursive: true, force: true });
for (const page of pages) {
    const html = template
        .replace("{{title}}", escapeHTML(page.name === "index" ? page.title : `${page.title} - E621Stream`))
        .replace("{{navStyle}}", () => NAV_CSS)
        .replace("{{header}}", () => navHTML(links, page.href))
        .replace("{{content}}", () => page.content);
    const dir = page.name === "index" ? out : join(out, page.name);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "index.html"), html);
}
console.log(`built ${pages.length} page(s) into ${out}`);
