import { createHmac, timingSafeEqual } from "node:crypto";

import Config from "../Config.ts";

const ALGORITHM = "sha256";
export function fingerprint(content: string): string {
    return createHmac(ALGORITHM, Config.hmacKey).update(content, "utf8").digest("hex");
}

export function compare(content: string, fp: string | null): boolean {
    if (!fp) return false;
    const a = Buffer.from(fingerprint(content), "hex");
    const b = Buffer.from(fp, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
}
