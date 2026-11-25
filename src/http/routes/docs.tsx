import Router from "@yiffy/bun-router";

import { DOCS } from "../Docs.ts";
import Docs from "../views/Docs.tsx";
import { render } from "../Views.ts";

for (const page of DOCS) {
    Router.new(page.href, "GET")
        .handle(async () => render(<Docs page={page} />));
}
