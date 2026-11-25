import { DOCS, type DocPage } from "../Docs.ts";

import Main from "./layouts/Main.tsx";

export default function Docs({ page }: { page: DocPage }): JSX.Element {
    return (
        <Main title={page.name === "index" ? "E621Stream" : `${page.title} - E621Stream`} styles={["pages/docs"]}>
            <div class="row g-4">
                <nav class="col-12 col-lg-2 docs-nav" aria-label="Docs">
                    <ul class="nav flex-lg-column">
                        {DOCS.map(doc => (
                            <li class="nav-item">
                                <a class={["nav-link", "px-lg-0", doc.href === page.href && "active"]} href={doc.href} aria-current={doc.href === page.href ? "page" : undefined} safe>{doc.title}</a>
                            </li>
                        ))}
                    </ul>
                </nav>
                {/* our own markdown, rendered when the server starts */}
                <article class="col-12 col-lg-10 docs">{page.content}</article>
            </div>
        </Main>
    );
}
