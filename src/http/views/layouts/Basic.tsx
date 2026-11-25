import Flash from "../partials/Flash.tsx";
import Head, { type HeadProps } from "../partials/Head.tsx";

import type { PropsWithChildren } from "@kitajs/html";

export default function Basic({ children, ...head }: PropsWithChildren<HeadProps>): JSX.Element {
    return (
        <html lang="en">
            <Head {...head} />
            <body>
                <Flash />
                {children}
            </body>
        </html>
    );
}
