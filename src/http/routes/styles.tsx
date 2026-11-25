import Router from "@yiffy/bun-router";

import { style } from "../Styles.ts";
import NotFound from "../views/NotFound.tsx";
import { render } from "../Views.ts";

// wildcard so names can include folders
Router.new("/styles/*", "GET")
    .handle((req) => {
        const path = new URL(req.url).pathname.slice("/styles/".length);
        if (!path.endsWith(".css")) return render(<NotFound />, 404);
        const css = style(path.slice(0, -".css".length));
        if (css === null) return render(<NotFound />, 404);
        return css;
    });
