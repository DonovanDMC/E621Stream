import Router from "@yiffy/bun-router";

import { script } from "../Scripts.ts";
import NotFound from "../views/NotFound.tsx";
import { render } from "../Views.ts";

// wildcard so names can include folders
Router.new("/scripts/*", "GET")
    .handle((req) => {
        const path = new URL(req.url).pathname.slice("/scripts/".length);
        if (!path.endsWith(".js")) return render(<NotFound />, 404);
        const js = script(path.slice(0, -".js".length));
        if (js === null) return render(<NotFound />, 404);
        return js;
    });
