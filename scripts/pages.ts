import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { Marked } from "marked";

const root = resolve(import.meta.dir, "../");
const pagesDir = join(root, "pages");
const out = join(root, "dist-pages");
// nav order, anything not listed goes after these alphabetically
const ORDER = ["index", "subscriptions", "events", "replaying", "compression", "close-codes"];

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
const rank = (name: string): number => ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.length;
pages.sort((a, b) => rank(a.name) - rank(b.name) || a.title.localeCompare(b.title));

const template = await Bun.file(join(pagesDir, "template.html")).text();
await rm(out, { recursive: true, force: true });
for (const page of pages) {
    const links = pages.map(p => p.href === page.href
        ? `<a href="${p.href}" class="active" aria-current="page">${escapeHTML(p.name === "index" ? "Overview" : p.title)}</a>`
        : `<a href="${p.href}">${escapeHTML(p.name === "index" ? "Overview" : p.title)}</a>`);
    const header = `<header class="site-header">\n      <nav class="site-nav" aria-label="Pages">\n        ${links.join("\n        ")}\n      </nav>\n    </header>`;
    const html = template
        .replace("{{title}}", escapeHTML(page.name === "index" ? page.title : `${page.title} - E621Stream`))
        .replace("{{header}}", () => header)
        .replace("{{content}}", () => page.content);
    const dir = page.name === "index" ? out : join(out, page.name);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "index.html"), html);
}
console.log(`built ${pages.length} page(s) into ${out}`);
