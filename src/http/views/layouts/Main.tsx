import Flash from "../partials/Flash.tsx";
import Head, { type HeadProps } from "../partials/Head.tsx";
import Nav from "../partials/Nav.tsx";

import type { PropsWithChildren } from "@kitajs/html";

export default function Main({ children, ...head }: PropsWithChildren<HeadProps>): JSX.Element {
    return (
        <html lang="en" data-bs-theme="dark">
            <Head {...head} />
            <body>
                <Nav />
                <main>
                    <Flash />
                    {children}
                </main>
            </body>
        </html>
    );
}
