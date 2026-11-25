import Router, { Middleware } from "@yiffy/bun-router";

import NotFound from "../views/NotFound.tsx";
import { render } from "../Views.ts";

Router
    .new("/*")
    // just the favicon, it doesn't change
    .use(Middleware.Static({ root: new URL("../static", import.meta.url), index: false, maxAge: 24 * 60 * 60 }))
    .handle(() => render(<NotFound />, 404));
