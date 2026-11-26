import { z } from "zod";

import { parseEnv } from "./env.ts";

const env = parseEnv("egress", z.object({
    EGRESS_PORT: z.coerce.number().int().positive().default(3000),
    EGRESS_FAMILY: z.coerce.number().pipe(z.literal([4, 6])).default(4), // the ip version it connects to e621 over
}));

const EgressConfig = {
    port: env.EGRESS_PORT,
    family: env.EGRESS_FAMILY,
} as const;

export default EgressConfig;
